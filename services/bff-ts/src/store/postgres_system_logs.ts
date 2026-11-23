import type postgres from "postgres";
import type { SystemLogItem, SystemLogLevel, SystemLogSource } from "@slipgate/contracts";
import { clampPage, likePattern } from "./ops_shared.ts";
import {
  hasSystemLogConstraint,
  levelsAtLeast,
  parseSystemLogContext,
  RUNTIME_LOG_CONFIG_KEY,
  SYSTEM_LOG_PRUNE_BATCH,
  SystemLogFilterRequiredError,
  type SystemLogCleanupAudit,
  type SystemLogFilter,
  type SystemLogInsert,
  type SystemLogStore,
} from "./system_logs_types.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent DDL for persisted system logs, mirrored by migrations/commerce/0021_system_logs.sql.
 * Applied by PostgresControlStore.init(); the tables are new and small, so the index statements
 * are cheap no-ops after the first start.
 */
export const PG_SYSTEM_LOGS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS commerce;

  CREATE TABLE IF NOT EXISTS commerce.system_logs (
      id                BIGSERIAL PRIMARY KEY,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      level             TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
      source            TEXT NOT NULL DEFAULT 'bff' CHECK (source IN ('bff', 'net', 'core')),
      component         TEXT NOT NULL DEFAULT 'app',
      host              TEXT NOT NULL DEFAULT '',
      message           TEXT NOT NULL,
      request_id        TEXT NOT NULL DEFAULT '',
      client_request_id TEXT NOT NULL DEFAULT '',
      user_id           TEXT,
      api_key_id        TEXT,
      account_id        TEXT,
      platform          TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL DEFAULT '',
      context           TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_created
      ON commerce.system_logs (created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_level_created
      ON commerce.system_logs (level, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_component_created
      ON commerce.system_logs (component, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_request
      ON commerce.system_logs (request_id) WHERE request_id <> '';
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_user_created
      ON commerce.system_logs (user_id, created_at DESC) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_api_key_created
      ON commerce.system_logs (api_key_id, created_at DESC) WHERE api_key_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_account_created
      ON commerce.system_logs (account_id, created_at DESC) WHERE account_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS commerce.system_log_cleanup_audits (
      id           BIGSERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      operator_id  TEXT NOT NULL,
      conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,
      deleted_rows BIGINT NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_system_log_cleanup_audits_created
      ON commerce.system_log_cleanup_audits (created_at DESC, id DESC);
`;

interface SystemLogRow {
  id: string;
  created_at: Date;
  level: SystemLogLevel;
  source: SystemLogSource;
  component: string;
  host: string;
  message: string;
  request_id: string;
  client_request_id: string;
  user_id: string | null;
  api_key_id: string | null;
  account_id: string | null;
  platform: string;
  model: string;
  context: string;
}

function whereOf(sql: Sql, f: SystemLogFilter): Fragment {
  const parts: Fragment[] = [];
  if (f.sinceIso) parts.push(sql`created_at >= ${new Date(f.sinceIso)}`);
  if (f.untilIso) parts.push(sql`created_at < ${new Date(f.untilIso)}`);
  if (f.level) parts.push(sql`level = ${f.level}`);
  if (f.minLevel) parts.push(sql`level IN ${sql(levelsAtLeast(f.minLevel))}`);
  if (f.source) parts.push(sql`source = ${f.source}`);
  if (f.component) parts.push(sql`component = ${f.component}`);
  if (f.host) parts.push(sql`host = ${f.host}`);
  if (f.requestId) parts.push(sql`request_id = ${f.requestId}`);
  if (f.clientRequestId) parts.push(sql`client_request_id = ${f.clientRequestId}`);
  if (f.userId) parts.push(sql`user_id = ${f.userId}`);
  if (f.apiKeyId) parts.push(sql`api_key_id = ${f.apiKeyId}`);
  if (f.accountId) parts.push(sql`account_id = ${f.accountId}`);
  if (f.platform) parts.push(sql`platform = ${f.platform}`);
  if (f.model) parts.push(sql`model = ${f.model}`);
  if (f.afterId) parts.push(sql`id > ${f.afterId}::bigint`);
  if (f.q) {
    const p = likePattern(f.q);
    parts.push(sql`(message ILIKE ${p} OR request_id ILIKE ${p} OR client_request_id ILIKE ${p} OR context ILIKE ${p})`);
  }
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

function toItem(r: SystemLogRow): SystemLogItem {
  return {
    id: String(r.id),
    createdAtIso: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    level: r.level,
    source: r.source,
    component: r.component,
    host: r.host,
    message: r.message,
    requestId: r.request_id,
    clientRequestId: r.client_request_id,
    userId: r.user_id,
    apiKeyId: r.api_key_id,
    accountId: r.account_id,
    platform: r.platform,
    model: r.model,
    context: parseSystemLogContext(r.context),
  };
}

export class PostgresSystemLogStore implements SystemLogStore {
  constructor(private readonly sql: Sql) {}

  async insertSystemLogs(rows: SystemLogInsert[]): Promise<number> {
    const values = rows
      .filter((r) => r.message)
      .map((r) => {
        const createdAtMs = Date.parse(r.createdAtIso);
        return {
          created_at: new Date(Number.isFinite(createdAtMs) ? createdAtMs : Date.now()),
          level: r.level,
          source: r.source,
          component: r.component || "app",
          host: r.host,
          message: r.message,
          request_id: r.requestId,
          client_request_id: r.clientRequestId,
          user_id: r.userId,
          api_key_id: r.apiKeyId,
          account_id: r.accountId,
          platform: r.platform,
          model: r.model,
          context: r.contextJson || "{}",
        };
      });
    if (values.length === 0) return 0;
    // One multi-row statement per batch, in order (BIGSERIAL ids follow it).
    const result = await this.sql`
      INSERT INTO commerce.system_logs ${this.sql(
        values,
        "created_at",
        "level",
        "source",
        "component",
        "host",
        "message",
        "request_id",
        "client_request_id",
        "user_id",
        "api_key_id",
        "account_id",
        "platform",
        "model",
        "context",
      )}
    `;
    return result.count;
  }

  async listSystemLogs(filter: SystemLogFilter, page: number, pageSize: number): Promise<{ items: SystemLogItem[]; total: number }> {
    const sql = this.sql;
    const where = whereOf(sql, filter);
    const { offset, limit } = clampPage(page, pageSize);
    const [rows, totals] = await Promise.all([
      sql<SystemLogRow[]>`
        SELECT id::text AS id, created_at, level, source, component, host, message, request_id, client_request_id,
               user_id, api_key_id, account_id, platform, model, context
          FROM commerce.system_logs
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM commerce.system_logs WHERE ${where}`,
    ]);
    return { items: rows.map(toItem), total: totals[0]?.n ?? 0 };
  }

  async deleteSystemLogs(filter: SystemLogFilter): Promise<number> {
    if (!hasSystemLogConstraint(filter)) throw new SystemLogFilterRequiredError();
    const result = await this.sql`DELETE FROM commerce.system_logs WHERE ${whereOf(this.sql, filter)}`;
    return result.count;
  }

  async recordSystemLogCleanup(audit: SystemLogCleanupAudit): Promise<void> {
    await this.sql`
      INSERT INTO commerce.system_log_cleanup_audits (operator_id, conditions, deleted_rows)
      VALUES (${audit.operatorId}, ${this.sql.json(audit.conditions as postgres.JSONValue)}, ${audit.deletedRows})
    `;
  }

  async pruneSystemLogs(cutoffIso: string): Promise<number> {
    const cutoff = new Date(cutoffIso);
    let total = 0;
    // Bounded batches: each statement holds its locks briefly; a backlog drains over the loop.
    for (let i = 0; i < 1_000; i++) {
      const result = await this.sql`
        DELETE FROM commerce.system_logs
         WHERE id IN (SELECT id FROM commerce.system_logs WHERE created_at < ${cutoff} LIMIT ${SYSTEM_LOG_PRUNE_BATCH})
      `;
      total += result.count;
      if (result.count < SYSTEM_LOG_PRUNE_BATCH) break;
    }
    await this.sql`DELETE FROM commerce.system_log_cleanup_audits WHERE created_at < ${cutoff}`;
    return total;
  }

  async getRuntimeLogConfig(): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ value_json: unknown }[]>`
      SELECT value_json FROM commerce.portal_settings WHERE key = ${RUNTIME_LOG_CONFIG_KEY}
    `;
    let v = rows[0]?.value_json;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v) as unknown;
      } catch {
        return null;
      }
    }
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }

  async setRuntimeLogConfig(value: Record<string, unknown> | null): Promise<void> {
    if (value === null) {
      await this.sql`DELETE FROM commerce.portal_settings WHERE key = ${RUNTIME_LOG_CONFIG_KEY}`;
      return;
    }
    await this.sql`
      INSERT INTO commerce.portal_settings (key, value_json, updated_at)
      VALUES (${RUNTIME_LOG_CONFIG_KEY}, ${this.sql.json(value as postgres.JSONValue)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `;
  }
}
