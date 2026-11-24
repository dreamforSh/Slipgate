import type postgres from "postgres";
import type { ChannelMonitor, ChannelMonitorRun, ChannelMonitorStatus } from "@slipgate/contracts";
import {
  normalizeMonitorStatus,
  summarizeMonitorRuns,
  type ChannelMonitorStore,
  type CreateMonitorRecordInput,
  type RecordMonitorRunInput,
  type UpdateMonitorRecordPatch,
} from "./channel_monitors_types.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent DDL for channel monitors & probe runs, mirrored by migrations/commerce/0020_channel_monitors.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_CHANNEL_MONITORS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS commerce;

  CREATE TABLE IF NOT EXISTS commerce.channel_monitors (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      account_id          TEXT NOT NULL,
      group_id            TEXT NOT NULL DEFAULT '',
      platform            TEXT NOT NULL DEFAULT '',
      model               TEXT NOT NULL DEFAULT '',
      interval_seconds    INTEGER NOT NULL DEFAULT 300,
      timeout_ms          INTEGER NOT NULL DEFAULT 30000,
      degraded_latency_ms INTEGER NOT NULL DEFAULT 8000,
      enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      is_public           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      last_status         TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (last_status IN ('unknown', 'up', 'degraded', 'down')),
      last_latency_ms     INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT NOT NULL DEFAULT '',
      last_checked_at     TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS commerce.channel_monitor_runs (
      id            BIGSERIAL PRIMARY KEY,
      monitor_id    TEXT NOT NULL REFERENCES commerce.channel_monitors(id) ON DELETE CASCADE,
      status        TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
      ok            BOOLEAN NOT NULL DEFAULT FALSE,
      latency_ms    INTEGER NOT NULL DEFAULT 0,
      model         TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitors_enabled_order
      ON commerce.channel_monitors (enabled, sort_order ASC);
  CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitor_runs_monitor_checked
      ON commerce.channel_monitor_runs (monitor_id, checked_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitor_runs_checked
      ON commerce.channel_monitor_runs (checked_at DESC);
`;

interface MonitorRow {
  id: string;
  name: string;
  description: string;
  account_id: string;
  account_name: string | null;
  group_id: string;
  group_name: string | null;
  platform: string;
  model: string;
  interval_seconds: number;
  timeout_ms: number;
  degraded_latency_ms: number;
  enabled: boolean;
  is_public: boolean;
  sort_order: number;
  last_status: ChannelMonitorStatus;
  last_latency_ms: number;
  last_error: string;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  monitor_id: string;
  status: "up" | "degraded" | "down";
  ok: boolean;
  latency_ms: number;
  model: string;
  error_message: string;
  checked_at: Date;
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toRun(r: RunRow): ChannelMonitorRun {
  return {
    id: String(r.id),
    monitorId: r.monitor_id,
    status: r.status,
    ok: Boolean(r.ok),
    latencyMs: Number(r.latency_ms ?? 0),
    model: r.model ?? "",
    errorMessage: r.error_message ?? "",
    checkedAtIso: toIso(r.checked_at),
  };
}

function toMonitor(r: MonitorRow, runs24h: ChannelMonitorRun[] = []): ChannelMonitor {
  const summary = summarizeMonitorRuns(runs24h);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    accountId: r.account_id,
    accountName: r.account_name ?? "",
    groupId: r.group_id,
    groupName: r.group_name ?? "",
    platform: r.platform,
    model: r.model,
    intervalSeconds: Number(r.interval_seconds),
    timeoutMs: Number(r.timeout_ms),
    degradedLatencyMs: Number(r.degraded_latency_ms),
    enabled: Boolean(r.enabled),
    isPublic: Boolean(r.is_public),
    sortOrder: Number(r.sort_order ?? 0),
    lastStatus: normalizeMonitorStatus(r.last_status),
    lastLatencyMs: Number(r.last_latency_ms ?? 0),
    lastError: r.last_error ?? "",
    lastCheckedAtIso: r.last_checked_at ? toIso(r.last_checked_at) : null,
    uptime24hPct: summary.uptime24hPct,
    recentRuns: summary.recentRuns,
    createdAtIso: toIso(r.created_at),
    updatedAtIso: toIso(r.updated_at),
  };
}

export class PostgresChannelMonitorStore implements ChannelMonitorStore {
  constructor(private readonly sql: Sql) {}

  async listMonitors(opts: { publicOnly?: boolean; enabledOnly?: boolean } = {}): Promise<ChannelMonitor[]> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (opts.publicOnly) parts.push(sql`m.is_public = TRUE`);
    if (opts.enabledOnly) parts.push(sql`m.enabled = TRUE`);
    const where = parts.length ? parts.reduce((acc, p) => sql`${acc} AND ${p}`) : sql`TRUE`;

    const rows = await sql<MonitorRow[]>`
      SELECT
        m.*,
        a.name AS account_name,
        g.name AS group_name
      FROM commerce.channel_monitors m
      LEFT JOIN core.accounts a ON a.id = m.account_id
      LEFT JOIN core.groups g   ON g.id = m.group_id
      WHERE ${where}
      ORDER BY m.sort_order ASC, m.created_at DESC
    `;
    if (rows.length === 0) return [];
    const sinceIso = new Date(Date.now() - 86_400_000).toISOString();
    const runsByMonitor = await this.listRecentRunsBatch(
      rows.map((r) => r.id),
      sinceIso,
    );
    return rows.map((r) => toMonitor(r, runsByMonitor.get(r.id) ?? []));
  }

  async getMonitor(id: string): Promise<ChannelMonitor | null> {
    const rows = await this.sql<MonitorRow[]>`
      SELECT
        m.*,
        a.name AS account_name,
        g.name AS group_name
      FROM commerce.channel_monitors m
      LEFT JOIN core.accounts a ON a.id = m.account_id
      LEFT JOIN core.groups g   ON g.id = m.group_id
      WHERE m.id = ${id}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const sinceIso = new Date(Date.now() - 86_400_000).toISOString();
    const runsByMonitor = await this.listRecentRunsBatch([id], sinceIso);
    return toMonitor(rows[0], runsByMonitor.get(id) ?? []);
  }

  async createMonitor(input: CreateMonitorRecordInput): Promise<ChannelMonitor> {
    const id = `mon_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date();
    await this.sql`
      INSERT INTO commerce.channel_monitors (
        id, name, description, account_id, group_id, platform, model,
        interval_seconds, timeout_ms, degraded_latency_ms,
        enabled, is_public, sort_order, created_at, updated_at
      )
      VALUES (
        ${id}, ${input.name}, ${input.description}, ${input.accountId}, ${input.groupId}, ${input.platform}, ${input.model},
        ${input.intervalSeconds}, ${input.timeoutMs}, ${input.degradedLatencyMs},
        ${input.enabled}, ${input.isPublic}, ${input.sortOrder}, ${now}, ${now}
      )
    `;
    return (await this.getMonitor(id))!;
  }

  async updateMonitor(id: string, patch: UpdateMonitorRecordPatch): Promise<ChannelMonitor | null> {
    const current = await this.getMonitor(id);
    if (!current) return null;
    await this.sql`
      UPDATE commerce.channel_monitors
      SET
        name = ${patch.name ?? current.name},
        description = ${patch.description ?? current.description},
        account_id = ${patch.accountId ?? current.accountId},
        group_id = ${patch.groupId ?? current.groupId},
        platform = ${patch.platform ?? current.platform},
        model = ${patch.model ?? current.model},
        interval_seconds = ${patch.intervalSeconds ?? current.intervalSeconds},
        timeout_ms = ${patch.timeoutMs ?? current.timeoutMs},
        degraded_latency_ms = ${patch.degradedLatencyMs ?? current.degradedLatencyMs},
        enabled = ${patch.enabled ?? current.enabled},
        is_public = ${patch.isPublic ?? current.isPublic},
        sort_order = ${patch.sortOrder ?? current.sortOrder},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    return this.getMonitor(id);
  }

  async deleteMonitor(id: string): Promise<boolean> {
    const res = await this.sql`DELETE FROM commerce.channel_monitors WHERE id = ${id}`;
    return res.count > 0;
  }

  async recordRun(
    monitorId: string,
    runInput: RecordMonitorRunInput,
  ): Promise<{ monitor: ChannelMonitor; run: ChannelMonitorRun } | null> {
    const current = await this.getMonitor(monitorId);
    if (!current) return null;
    const checkedAt = new Date(runInput.checkedAtIso);
    const runRows = await this.sql<RunRow[]>`
      INSERT INTO commerce.channel_monitor_runs (monitor_id, status, ok, latency_ms, model, error_message, checked_at)
      VALUES (${monitorId}, ${runInput.status}, ${runInput.ok}, ${runInput.latencyMs}, ${runInput.model}, ${runInput.errorMessage}, ${checkedAt})
      RETURNING *
    `;
    await this.sql`
      UPDATE commerce.channel_monitors
      SET
        last_status = ${runInput.status},
        last_latency_ms = ${runInput.latencyMs},
        last_error = ${runInput.errorMessage},
        last_checked_at = ${checkedAt},
        updated_at = NOW()
      WHERE id = ${monitorId}
    `;
    const monitor = (await this.getMonitor(monitorId))!;
    return { monitor, run: toRun(runRows[0]!) };
  }

  async listRuns(monitorId: string, limit: number): Promise<ChannelMonitorRun[]> {
    const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = await this.sql<RunRow[]>`
      SELECT *
      FROM commerce.channel_monitor_runs
      WHERE monitor_id = ${monitorId}
      ORDER BY checked_at DESC, id DESC
      LIMIT ${clamped}
    `;
    return rows.map(toRun);
  }

  async listRecentRunsBatch(monitorIds: string[], sinceIso: string): Promise<Map<string, ChannelMonitorRun[]>> {
    const out = new Map<string, ChannelMonitorRun[]>();
    if (monitorIds.length === 0) return out;
    const rows = await this.sql<RunRow[]>`
      SELECT *
      FROM commerce.channel_monitor_runs
      WHERE monitor_id IN ${this.sql(monitorIds)} AND checked_at >= ${new Date(sinceIso)}
      ORDER BY checked_at ASC, id ASC
    `;
    for (const r of rows) {
      let arr = out.get(r.monitor_id);
      if (!arr) {
        arr = [];
        out.set(r.monitor_id, arr);
      }
      arr.push(toRun(r));
    }
    return out;
  }

  async pruneRunsBefore(cutoffIso: string): Promise<number> {
    const res = await this.sql`
      DELETE FROM commerce.channel_monitor_runs WHERE checked_at < ${new Date(cutoffIso)}
    `;
    return res.count;
  }
}
