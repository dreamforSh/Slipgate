import type postgres from "postgres";
import type { RequestErrorItem, RequestErrorPhase, RequestErrorSummary } from "@slipgate/contracts";
import { clampPage, likePattern } from "./ops_shared.ts";
import {
  hasRequestErrorCleanupConstraint,
  parseRequestErrorMetadata,
  RequestErrorCleanupConstraintError,
  type RequestErrorCleanupFilter,
  type RequestErrorFilter,
  type RequestErrorInsert,
  type RequestErrorStore,
} from "./request_errors_types.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent DDL for core.request_errors, mirrored by migrations/core/0014_request_errors.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_REQUEST_ERRORS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS core;

  CREATE TABLE IF NOT EXISTS core.request_errors (
      id                BIGSERIAL PRIMARY KEY,
      request_id        TEXT NOT NULL DEFAULT '',
      client_request_id TEXT NOT NULL DEFAULT '',
      user_id           TEXT,
      api_key_id        TEXT,
      account_id        TEXT,
      group_id          TEXT,
      platform          TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL DEFAULT '',
      upstream_model    TEXT NOT NULL DEFAULT '',
      phase             TEXT NOT NULL DEFAULT 'other'
                        CHECK (phase IN ('ingress', 'core_eval', 'outbound', 'upstream_http', 'stream_relay', 'other')),
      kind              TEXT NOT NULL DEFAULT '',
      status_code       INTEGER NOT NULL DEFAULT 500,
      upstream_status   INTEGER NOT NULL DEFAULT 0,
      error_type        TEXT NOT NULL DEFAULT '',
      error_code        TEXT NOT NULL DEFAULT '',
      error_message     TEXT NOT NULL DEFAULT '',
      upstream_body     TEXT NOT NULL DEFAULT '',
      attempt           INTEGER NOT NULL DEFAULT 1,
      failover_used     BOOLEAN NOT NULL DEFAULT FALSE,
      duration_ms       INTEGER NOT NULL DEFAULT 0,
      execution_mode    TEXT NOT NULL DEFAULT '',
      metadata_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolved          BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at       TIMESTAMPTZ,
      resolved_by       TEXT NOT NULL DEFAULT '',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_core_request_errors_created
      ON core.request_errors (created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_phase_created
      ON core.request_errors (phase, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_status_created
      ON core.request_errors (status_code, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_account_created
      ON core.request_errors (account_id, created_at DESC) WHERE account_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_user_created
      ON core.request_errors (user_id, created_at DESC) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_request_id
      ON core.request_errors (request_id) WHERE request_id <> '';
  CREATE INDEX IF NOT EXISTS idx_core_request_errors_resolved_created
      ON core.request_errors (resolved, created_at DESC);
`;

interface RequestErrorRow {
  id: string;
  request_id: string;
  client_request_id: string;
  user_id: string | null;
  user_email: string | null;
  api_key_id: string | null;
  account_id: string | null;
  account_name: string | null;
  group_id: string | null;
  group_name: string | null;
  platform: string;
  model: string;
  upstream_model: string;
  phase: RequestErrorPhase;
  kind: string;
  status_code: number;
  upstream_status: number;
  error_type: string;
  error_code: string;
  error_message: string;
  upstream_body: string;
  attempt: number;
  failover_used: boolean;
  duration_ms: number;
  execution_mode: string;
  metadata_json: unknown;
  resolved: boolean;
  resolved_at: Date | null;
  resolved_by: string;
  created_at: Date;
}

function whereOf(sql: Sql, f: RequestErrorFilter): Fragment {
  const parts: Fragment[] = [];
  if (f.sinceIso) parts.push(sql`re.created_at >= ${new Date(f.sinceIso)}`);
  if (f.untilIso) parts.push(sql`re.created_at < ${new Date(f.untilIso)}`);
  if (f.phase) parts.push(sql`re.phase = ${f.phase}`);
  if (f.statusCode !== undefined) parts.push(sql`re.status_code = ${f.statusCode}`);
  if (f.statusClass === "4xx") parts.push(sql`re.status_code >= 400 AND re.status_code < 500`);
  if (f.statusClass === "5xx") parts.push(sql`re.status_code >= 500`);
  if (f.statusClass === "upstream") parts.push(sql`re.upstream_status >= 400`);
  if (f.accountId) parts.push(sql`re.account_id = ${f.accountId}`);
  if (f.userId) parts.push(sql`re.user_id = ${f.userId}`);
  if (f.apiKeyId) parts.push(sql`re.api_key_id = ${f.apiKeyId}`);
  if (f.platform) parts.push(sql`re.platform = ${f.platform}`);
  if (f.model) parts.push(sql`re.model = ${f.model}`);
  if (f.requestId) parts.push(sql`re.request_id = ${f.requestId}`);
  if (f.resolved === "open") parts.push(sql`re.resolved = FALSE`);
  if (f.resolved === "resolved") parts.push(sql`re.resolved = TRUE`);
  if (f.q) {
    const p = likePattern(f.q);
    parts.push(
      sql`(re.request_id ILIKE ${p} OR re.client_request_id ILIKE ${p} OR re.model ILIKE ${p} OR re.error_code ILIKE ${p} OR re.error_message ILIKE ${p} OR re.kind ILIKE ${p})`,
    );
  }
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toItem(r: RequestErrorRow): RequestErrorItem {
  return {
    id: String(r.id),
    requestId: r.request_id,
    clientRequestId: r.client_request_id,
    userId: r.user_id,
    userEmail: r.user_email ?? "",
    apiKeyId: r.api_key_id,
    accountId: r.account_id,
    accountName: r.account_name ?? "",
    groupId: r.group_id,
    groupName: r.group_name ?? "",
    platform: r.platform,
    model: r.model,
    upstreamModel: r.upstream_model,
    phase: r.phase,
    kind: r.kind,
    statusCode: Number(r.status_code ?? 0),
    upstreamStatus: Number(r.upstream_status ?? 0),
    errorType: r.error_type,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    upstreamBody: r.upstream_body,
    attempt: Number(r.attempt ?? 1),
    failoverUsed: Boolean(r.failover_used),
    durationMs: Number(r.duration_ms ?? 0),
    executionMode: r.execution_mode,
    metadata: parseRequestErrorMetadata(r.metadata_json),
    resolved: Boolean(r.resolved),
    resolvedAtIso: r.resolved_at ? toIso(r.resolved_at) : null,
    resolvedBy: r.resolved_by ?? "",
    createdAtIso: toIso(r.created_at),
  };
}

export class PostgresRequestErrorStore implements RequestErrorStore {
  constructor(private readonly sql: Sql) {}

  async insertRequestErrors(rows: RequestErrorInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map((r) => {
      const createdAtMs = Date.parse(r.createdAtIso);
      return {
        request_id: r.requestId,
        client_request_id: r.clientRequestId,
        user_id: r.userId,
        api_key_id: r.apiKeyId,
        account_id: r.accountId,
        group_id: r.groupId,
        platform: r.platform,
        model: r.model,
        upstream_model: r.upstreamModel,
        phase: r.phase,
        kind: r.kind,
        status_code: r.statusCode,
        upstream_status: r.upstreamStatus,
        error_type: r.errorType,
        error_code: r.errorCode,
        error_message: r.errorMessage,
        upstream_body: r.upstreamBody,
        attempt: r.attempt,
        failover_used: r.failoverUsed,
        duration_ms: r.durationMs,
        execution_mode: r.executionMode,
        metadata_json: this.sql.json(parseRequestErrorMetadata(r.metadataJson) as postgres.JSONValue),
        created_at: new Date(Number.isFinite(createdAtMs) ? createdAtMs : Date.now()),
      };
    });
    const result = await this.sql`
      INSERT INTO core.request_errors ${this.sql(
        values,
        "request_id",
        "client_request_id",
        "user_id",
        "api_key_id",
        "account_id",
        "group_id",
        "platform",
        "model",
        "upstream_model",
        "phase",
        "kind",
        "status_code",
        "upstream_status",
        "error_type",
        "error_code",
        "error_message",
        "upstream_body",
        "attempt",
        "failover_used",
        "duration_ms",
        "execution_mode",
        "metadata_json",
        "created_at",
      )}
    `;
    return result.count;
  }

  async listRequestErrors(
    filter: RequestErrorFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: RequestErrorItem[]; total: number }> {
    const sql = this.sql;
    const where = whereOf(sql, filter);
    const { offset, limit } = clampPage(page, pageSize);
    const [rows, totals] = await Promise.all([
      sql<RequestErrorRow[]>`
        SELECT
          re.*,
          u.email AS user_email,
          a.name  AS account_name,
          g.name  AS group_name
        FROM core.request_errors re
        LEFT JOIN commerce.users u ON u.id = re.user_id
        LEFT JOIN core.accounts a  ON a.id = re.account_id
        LEFT JOIN core.groups g    ON g.id = re.group_id
        WHERE ${where}
        ORDER BY re.created_at DESC, re.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM core.request_errors re
        WHERE ${where}
      `,
    ]);
    return { items: rows.map(toItem), total: Number(totals[0]?.n ?? "0") };
  }

  async getRequestError(id: string): Promise<RequestErrorItem | null> {
    if (!/^\d{1,18}$/.test(id)) return null;
    const rows = await this.sql<RequestErrorRow[]>`
      SELECT
        re.*,
        u.email AS user_email,
        a.name  AS account_name,
        g.name  AS group_name
      FROM core.request_errors re
      LEFT JOIN commerce.users u ON u.id = re.user_id
      LEFT JOIN core.accounts a  ON a.id = re.account_id
      LEFT JOIN core.groups g    ON g.id = re.group_id
      WHERE re.id = ${id}::bigint
      LIMIT 1
    `;
    return rows[0] ? toItem(rows[0]) : null;
  }

  async summarizeRequestErrors(sinceIso: string, untilIso?: string): Promise<RequestErrorSummary> {
    const sql = this.sql;
    const sinceDate = new Date(sinceIso);
    const untilDate = untilIso ? new Date(untilIso) : new Date();
    const windowWhere = untilIso
      ? sql`re.created_at >= ${sinceDate} AND re.created_at < ${untilDate}`
      : sql`re.created_at >= ${sinceDate}`;

    const [totals, phases, models, accounts] = await Promise.all([
      sql<{ total: string; open_count: string; resolved_count: string; s4xx: string; s5xx: string }[]>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE NOT re.resolved)::text AS open_count,
          COUNT(*) FILTER (WHERE re.resolved)::text AS resolved_count,
          COUNT(*) FILTER (WHERE re.status_code >= 400 AND re.status_code < 500)::text AS s4xx,
          COUNT(*) FILTER (WHERE re.status_code >= 500)::text AS s5xx
        FROM core.request_errors re
        WHERE ${windowWhere}
      `,
      sql<{ phase: RequestErrorPhase; n: string }[]>`
        SELECT re.phase, COUNT(*)::text AS n
        FROM core.request_errors re
        WHERE ${windowWhere}
        GROUP BY re.phase
        ORDER BY COUNT(*) DESC
      `,
      sql<{ model: string; n: string }[]>`
        SELECT re.model, COUNT(*)::text AS n
        FROM core.request_errors re
        WHERE ${windowWhere} AND re.model <> ''
        GROUP BY re.model
        ORDER BY COUNT(*) DESC
        LIMIT 8
      `,
      sql<{ account_id: string; account_name: string | null; n: string }[]>`
        SELECT re.account_id, COALESCE(MAX(a.name), '') AS account_name, COUNT(*)::text AS n
        FROM core.request_errors re
        LEFT JOIN core.accounts a ON a.id = re.account_id
        WHERE ${windowWhere} AND re.account_id IS NOT NULL AND re.account_id <> ''
        GROUP BY re.account_id
        ORDER BY COUNT(*) DESC
        LIMIT 8
      `,
    ]);

    const t = totals[0];
    return {
      total: Number(t?.total ?? "0"),
      openCount: Number(t?.open_count ?? "0"),
      resolvedCount: Number(t?.resolved_count ?? "0"),
      status4xx: Number(t?.s4xx ?? "0"),
      status5xx: Number(t?.s5xx ?? "0"),
      byPhase: phases.map((p) => ({ phase: p.phase, count: Number(p.n) })),
      topModels: models.map((m) => ({ model: m.model, count: Number(m.n) })),
      topAccounts: accounts.map((a) => ({
        accountId: a.account_id,
        accountName: a.account_name ?? "",
        count: Number(a.n),
      })),
      sinceIso: sinceDate.toISOString(),
      untilIso: untilDate.toISOString(),
    };
  }

  async setRequestErrorResolved(id: string, resolved: boolean, operatorId: string): Promise<RequestErrorItem | null> {
    if (!/^\d{1,18}$/.test(id)) return null;
    const updated = await this.sql<{ id: string }[]>`
      UPDATE core.request_errors
      SET
        resolved = ${resolved},
        resolved_at = ${resolved ? new Date() : null},
        resolved_by = ${resolved ? operatorId : ""}
      WHERE id = ${id}::bigint
      RETURNING id::text AS id
    `;
    if (!updated[0]) return null;
    return this.getRequestError(id);
  }

  async cleanupRequestErrors(filter: RequestErrorCleanupFilter): Promise<number> {
    if (!hasRequestErrorCleanupConstraint(filter)) throw new RequestErrorCleanupConstraintError();
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (filter.beforeIso) parts.push(sql`created_at < ${new Date(filter.beforeIso)}`);
    if (filter.phase) parts.push(sql`phase = ${filter.phase}`);
    if (filter.statusCode !== undefined) parts.push(sql`status_code = ${filter.statusCode}`);
    if (filter.resolvedOnly) parts.push(sql`resolved = TRUE`);
    const where = parts.reduce((acc, part) => sql`${acc} AND ${part}`);
    const res = await sql`DELETE FROM core.request_errors WHERE ${where}`;
    return res.count;
  }
}
