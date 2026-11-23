import { SYSTEM_LOG_LEVEL_RANK, type SystemLogItem } from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import {
  hasSystemLogConstraint,
  MEMORY_SYSTEM_LOG_LIMIT,
  parseSystemLogContext,
  SystemLogFilterRequiredError,
  type SystemLogCleanupAudit,
  type SystemLogFilter,
  type SystemLogInsert,
  type SystemLogStore,
} from "./system_logs_types.ts";

interface MemorySystemLogRow extends SystemLogInsert {
  id: number;
  createdAtMs: number;
  /** Lower-cased message, request ids and context, for the case-insensitive `q` search. */
  haystack: string[];
}

function matches(row: MemorySystemLogRow, f: SystemLogFilter): boolean {
  if (f.sinceIso && row.createdAtMs < Date.parse(f.sinceIso)) return false;
  if (f.untilIso && row.createdAtMs >= Date.parse(f.untilIso)) return false;
  if (f.level && row.level !== f.level) return false;
  if (f.minLevel && SYSTEM_LOG_LEVEL_RANK[row.level] < SYSTEM_LOG_LEVEL_RANK[f.minLevel]) return false;
  if (f.source && row.source !== f.source) return false;
  if (f.component && row.component !== f.component) return false;
  if (f.host && row.host !== f.host) return false;
  if (f.requestId && row.requestId !== f.requestId) return false;
  if (f.clientRequestId && row.clientRequestId !== f.clientRequestId) return false;
  if (f.userId && row.userId !== f.userId) return false;
  if (f.apiKeyId && row.apiKeyId !== f.apiKeyId) return false;
  if (f.accountId && row.accountId !== f.accountId) return false;
  if (f.platform && row.platform !== f.platform) return false;
  if (f.model && row.model !== f.model) return false;
  if (f.afterId && row.id <= Number(f.afterId)) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    if (!row.haystack.some((h) => h.includes(needle))) return false;
  }
  return true;
}

function toItem(row: MemorySystemLogRow): SystemLogItem {
  return {
    id: String(row.id),
    createdAtIso: new Date(row.createdAtMs).toISOString(),
    level: row.level,
    source: row.source,
    component: row.component,
    host: row.host,
    message: row.message,
    requestId: row.requestId,
    clientRequestId: row.clientRequestId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    accountId: row.accountId,
    platform: row.platform,
    model: row.model,
    context: parseSystemLogContext(row.contextJson),
  };
}

/** In-memory system logs (dev / tests): the newest MEMORY_SYSTEM_LOG_LIMIT rows are kept. */
export class MemorySystemLogStore implements SystemLogStore {
  private readonly rows: MemorySystemLogRow[] = [];
  private readonly audits: (SystemLogCleanupAudit & { createdAtMs: number })[] = [];
  private seq = 0;
  private runtimeConfig: Record<string, unknown> | null = null;

  async insertSystemLogs(rows: SystemLogInsert[]): Promise<number> {
    let inserted = 0;
    for (const r of rows) {
      if (!r.message) continue;
      const createdAtMs = Date.parse(r.createdAtIso);
      const contextJson = r.contextJson || "{}";
      this.rows.push({
        ...r,
        component: r.component || "app",
        contextJson,
        id: ++this.seq,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        haystack: [r.message, r.requestId, r.clientRequestId, contextJson].map((s) => s.toLowerCase()),
      });
      inserted++;
    }
    if (this.rows.length > MEMORY_SYSTEM_LOG_LIMIT) this.rows.splice(0, this.rows.length - MEMORY_SYSTEM_LOG_LIMIT);
    return inserted;
  }

  async listSystemLogs(filter: SystemLogFilter, page: number, pageSize: number): Promise<{ items: SystemLogItem[]; total: number }> {
    const hits = this.rows.filter((r) => matches(r, filter));
    hits.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id - a.id);
    const { offset, limit } = clampPage(page, pageSize);
    return { items: hits.slice(offset, offset + limit).map(toItem), total: hits.length };
  }

  async deleteSystemLogs(filter: SystemLogFilter): Promise<number> {
    if (!hasSystemLogConstraint(filter)) throw new SystemLogFilterRequiredError();
    return this.removeWhere((r) => matches(r, filter));
  }

  async recordSystemLogCleanup(audit: SystemLogCleanupAudit): Promise<void> {
    this.audits.push({ ...audit, conditions: structuredClone(audit.conditions), createdAtMs: Date.now() });
    if (this.audits.length > 1_000) this.audits.splice(0, this.audits.length - 1_000);
  }

  async pruneSystemLogs(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    for (let i = this.audits.length - 1; i >= 0; i--) if (this.audits[i]!.createdAtMs < cutoff) this.audits.splice(i, 1);
    return this.removeWhere((r) => r.createdAtMs < cutoff);
  }

  async getRuntimeLogConfig(): Promise<Record<string, unknown> | null> {
    return this.runtimeConfig ? structuredClone(this.runtimeConfig) : null;
  }

  async setRuntimeLogConfig(value: Record<string, unknown> | null): Promise<void> {
    this.runtimeConfig = value ? structuredClone(value) : null;
  }

  /** Cleanup audits recorded so far (tests). */
  cleanupAudits(): SystemLogCleanupAudit[] {
    return this.audits.map(({ createdAtMs: _, ...a }) => a);
  }

  private removeWhere(pred: (r: MemorySystemLogRow) => boolean): number {
    let kept = 0;
    let removed = 0;
    for (const row of this.rows) {
      if (pred(row)) removed++;
      else this.rows[kept++] = row;
    }
    this.rows.length = kept;
    return removed;
  }
}
