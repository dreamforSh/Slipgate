import type {
  GroupItem,
  RequestErrorItem,
  RequestErrorPhase,
  RequestErrorSummary,
  UpstreamAccount,
} from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import {
  hasRequestErrorCleanupConstraint,
  MEMORY_REQUEST_ERROR_LIMIT,
  parseRequestErrorMetadata,
  RequestErrorCleanupConstraintError,
  type RequestErrorCleanupFilter,
  type RequestErrorFilter,
  type RequestErrorInsert,
  type RequestErrorStore,
} from "./request_errors_types.ts";
import type { StoredUserRecord } from "./types.ts";

interface MemoryRequestErrorRow extends RequestErrorInsert {
  id: number;
  createdAtMs: number;
  resolved: boolean;
  resolvedAtIso: string | null;
  resolvedBy: string;
  haystack: string[];
}

export interface MemoryRequestErrorStoreDeps {
  users: Map<string, StoredUserRecord>;
  accounts: Map<string, Pick<UpstreamAccount, "name">>;
  groups: Map<string, Pick<GroupItem, "name">>;
}

function matches(row: MemoryRequestErrorRow, f: RequestErrorFilter): boolean {
  if (f.sinceIso && row.createdAtMs < Date.parse(f.sinceIso)) return false;
  if (f.untilIso && row.createdAtMs >= Date.parse(f.untilIso)) return false;
  if (f.phase && row.phase !== f.phase) return false;
  if (f.statusCode !== undefined && row.statusCode !== f.statusCode) return false;
  if (f.statusClass === "4xx" && !(row.statusCode >= 400 && row.statusCode < 500)) return false;
  if (f.statusClass === "5xx" && row.statusCode < 500) return false;
  if (f.statusClass === "upstream" && row.upstreamStatus < 400) return false;
  if (f.accountId && row.accountId !== f.accountId) return false;
  if (f.userId && row.userId !== f.userId) return false;
  if (f.apiKeyId && row.apiKeyId !== f.apiKeyId) return false;
  if (f.groupId && row.groupId !== f.groupId) return false;
  if (f.platform && row.platform !== f.platform) return false;
  if (f.model && row.model !== f.model) return false;
  if (f.modelContains && !row.model.toLowerCase().includes(f.modelContains.toLowerCase())) return false;
  if (f.requestId && row.requestId !== f.requestId) return false;
  if (f.resolved === "open" && row.resolved) return false;
  if (f.resolved === "resolved" && !row.resolved) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    if (!row.haystack.some((h) => h.includes(needle))) return false;
  }
  return true;
}

export class MemoryRequestErrorStore implements RequestErrorStore {
  private readonly rows: MemoryRequestErrorRow[] = [];
  private seq = 0;

  constructor(private readonly deps: MemoryRequestErrorStoreDeps) {}

  private toItem(r: MemoryRequestErrorRow): RequestErrorItem {
    return {
      id: String(r.id),
      requestId: r.requestId,
      clientRequestId: r.clientRequestId,
      userId: r.userId,
      userEmail: r.userId ? (this.deps.users.get(r.userId)?.email ?? "") : "",
      apiKeyId: r.apiKeyId,
      accountId: r.accountId,
      accountName: r.accountId ? (this.deps.accounts.get(r.accountId)?.name ?? "") : "",
      groupId: r.groupId,
      groupName: r.groupId ? (this.deps.groups.get(r.groupId)?.name ?? "") : "",
      platform: r.platform,
      model: r.model,
      upstreamModel: r.upstreamModel,
      phase: r.phase,
      kind: r.kind,
      statusCode: r.statusCode,
      upstreamStatus: r.upstreamStatus,
      errorType: r.errorType,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      upstreamBody: r.upstreamBody,
      attempt: r.attempt,
      failoverUsed: r.failoverUsed,
      durationMs: r.durationMs,
      executionMode: r.executionMode,
      metadata: parseRequestErrorMetadata(r.metadataJson),
      resolved: r.resolved,
      resolvedAtIso: r.resolvedAtIso,
      resolvedBy: r.resolvedBy,
      createdAtIso: new Date(r.createdAtMs).toISOString(),
    };
  }

  async insertRequestErrors(rows: RequestErrorInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    for (const r of rows) {
      const parsedMs = Date.parse(r.createdAtIso);
      const createdAtMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
      this.rows.push({
        ...r,
        id: ++this.seq,
        createdAtMs,
        resolved: false,
        resolvedAtIso: null,
        resolvedBy: "",
        haystack: [r.requestId, r.clientRequestId, r.model, r.errorCode, r.errorMessage, r.kind].map((s) =>
          s.toLowerCase(),
        ),
      });
    }
    if (this.rows.length > MEMORY_REQUEST_ERROR_LIMIT) {
      this.rows.splice(0, this.rows.length - MEMORY_REQUEST_ERROR_LIMIT);
    }
    return rows.length;
  }

  async listRequestErrors(
    filter: RequestErrorFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: RequestErrorItem[]; total: number }> {
    const hits = this.rows.filter((r) => matches(r, filter));
    hits.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id - a.id);
    const { offset, limit } = clampPage(page, pageSize);
    return { items: hits.slice(offset, offset + limit).map((r) => this.toItem(r)), total: hits.length };
  }

  async getRequestError(id: string): Promise<RequestErrorItem | null> {
    const row = this.rows.find((r) => String(r.id) === id);
    return row ? this.toItem(row) : null;
  }

  async summarizeRequestErrors(sinceIso: string, untilIso?: string): Promise<RequestErrorSummary> {
    const sinceMs = Date.parse(sinceIso);
    const untilMs = untilIso ? Date.parse(untilIso) : Date.now();
    const hits = this.rows.filter(
      (r) => r.createdAtMs >= sinceMs && (!untilIso || r.createdAtMs < untilMs),
    );
    let openCount = 0;
    let resolvedCount = 0;
    let status4xx = 0;
    let status5xx = 0;
    const phaseCounts = new Map<RequestErrorPhase, number>();
    const modelCounts = new Map<string, number>();
    const accountCounts = new Map<string, number>();

    for (const r of hits) {
      if (r.resolved) resolvedCount++;
      else openCount++;
      if (r.statusCode >= 400 && r.statusCode < 500) status4xx++;
      else if (r.statusCode >= 500) status5xx++;
      phaseCounts.set(r.phase, (phaseCounts.get(r.phase) ?? 0) + 1);
      if (r.model) modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
      if (r.accountId) accountCounts.set(r.accountId, (accountCounts.get(r.accountId) ?? 0) + 1);
    }

    return {
      total: hits.length,
      openCount,
      resolvedCount,
      status4xx,
      status5xx,
      byPhase: [...phaseCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([phase, count]) => ({ phase, count })),
      topModels: [...modelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([model, count]) => ({ model, count })),
      topAccounts: [...accountCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([accountId, count]) => ({
          accountId,
          accountName: this.deps.accounts.get(accountId)?.name ?? "",
          count,
        })),
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(untilMs).toISOString(),
    };
  }

  async setRequestErrorResolved(id: string, resolved: boolean, operatorId: string): Promise<RequestErrorItem | null> {
    const row = this.rows.find((r) => String(r.id) === id);
    if (!row) return null;
    row.resolved = resolved;
    row.resolvedAtIso = resolved ? new Date().toISOString() : null;
    row.resolvedBy = resolved ? operatorId : "";
    return this.toItem(row);
  }

  async cleanupRequestErrors(filter: RequestErrorCleanupFilter): Promise<number> {
    if (!hasRequestErrorCleanupConstraint(filter)) throw new RequestErrorCleanupConstraintError();
    const beforeMs = filter.beforeIso ? Date.parse(filter.beforeIso) : undefined;
    let deleted = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (beforeMs !== undefined && !(r.createdAtMs < beforeMs)) continue;
      if (filter.phase && r.phase !== filter.phase) continue;
      if (filter.statusCode !== undefined && r.statusCode !== filter.statusCode) continue;
      if (filter.resolvedOnly && !r.resolved) continue;
      this.rows.splice(i, 1);
      deleted++;
    }
    return deleted;
  }
}
