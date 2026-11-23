import type { DashboardRange, UsageLogItem, UsageSeriesPoint, UsageTotals } from "@slipgate/contracts";
import { dashboardWindow, type DashboardWindow } from "../dashboard.ts";

/**
 * Usage aggregates the stores compute for the user dashboard, the public key-usage lookup, the
 * public status page and the ops monitor. PostgresOpsStore aggregates with SQL (GROUP BY a time
 * bucket over an indexed, bounded window: exact at any volume, only the groups cross the wire);
 * MemoryOpsStore runs the reference reducers below over its rows. Both feed the same pure
 * finalizers, so ranking, rounding and bucketing are identical in either store.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Longest a scoped aggregate (one user's dashboard, one key's lookup) may run in Postgres. It is
 * exact over the whole window, so its cost grows with the scope's traffic; past this the
 * statement is cancelled and its pooled connection freed instead of being held by one heavy
 * scope (the pool also serves settlements).
 */
export const SCOPED_USAGE_TIMEOUT_MS = 8_000;

/** A usage aggregate ran past its statement timeout; routes answer 503 and suggest a shorter range. */
export class UsageAggregateTimeoutError extends Error {
  constructor(message = "Usage figures for this range took too long to compute") {
    super(message);
    this.name = "UsageAggregateTimeoutError";
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Additive sums                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface UsageSums {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costNano: bigint;
  /** Sum and count of positive durations / time-to-first-token (unknown = 0 is left out). */
  durationSum: number;
  durationCount: number;
  ttftSum: number;
  ttftCount: number;
}

export function emptySums(): UsageSums {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costNano: 0n,
    durationSum: 0,
    durationCount: 0,
    ttftSum: 0,
    ttftCount: 0,
  };
}

export function addLogToSums(s: UsageSums, log: UsageLogItem): void {
  s.requests += 1;
  if (log.statusCode >= 400) s.errors += 1;
  s.inputTokens += log.inputTokens;
  s.outputTokens += log.outputTokens;
  s.cacheReadTokens += log.cacheReadTokens;
  s.costNano += BigInt(log.costNanoUsd);
  if (log.durationMs > 0) {
    s.durationSum += log.durationMs;
    s.durationCount += 1;
  }
  if (log.ttftMs > 0) {
    s.ttftSum += log.ttftMs;
    s.ttftCount += 1;
  }
}

export function sumsToTotals(s: UsageSums): UsageTotals {
  return {
    requests: s.requests,
    errors: s.errors,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    costNanoUsd: s.costNano.toString(),
    avgDurationMs: s.durationCount ? Math.round(s.durationSum / s.durationCount) : 0,
    avgTtftMs: s.ttftCount ? Math.round(s.ttftSum / s.ttftCount) : 0,
  };
}

function bumpSums<K>(map: Map<K, UsageSums>, key: K, log: UsageLogItem): void {
  let s = map.get(key);
  if (!s) {
    s = emptySums();
    map.set(key, s);
  }
  addLogToSums(s, log);
}

/** Integer part of a NUMERIC sum printed by Postgres. */
export function nanoFromText(text: string | null | undefined): bigint {
  return BigInt(String(text ?? "0").split(".")[0] || "0");
}

/** Top `limit` entries by tokens, then requests, then key: a total order, so both stores agree. */
export function rankSums(map: Map<string, UsageSums>, limit: number): { key: string; requests: number; tokens: number; costNanoUsd: string }[] {
  return Array.from(map.entries())
    .map(([key, s]) => ({ key, requests: s.requests, tokens: s.inputTokens + s.outputTokens, costNanoUsd: s.costNano.toString() }))
    .filter((e) => e.requests > 0)
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit);
}

/** Nearest-rank percentile (`percentile_disc` in Postgres) of positive values; 0 when none. */
export function nearestRank(values: number[], p: number): number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/* ------------------------------------------------------------------------------------------ */
/* Scoped usage: one user (dashboard) or one API key (public lookup)                          */
/* ------------------------------------------------------------------------------------------ */

export interface ScopedUsageQuery {
  userId?: string;
  apiKeyId?: string;
  range: DashboardRange;
  nowMs: number;
  /** `Date#getTimezoneOffset()` of the viewer (UTC minus local, minutes). */
  tzOffsetMinutes: number;
}

export interface ScopedUsagePlan {
  win: DashboardWindow;
  bucketMs: number;
  periodStartMs: number;
  todayStartMs: number;
  nowMs: number;
}

export function scopedUsagePlan(q: ScopedUsageQuery): ScopedUsagePlan {
  const win = dashboardWindow(q.range, q.nowMs, q.tzOffsetMinutes);
  return {
    win,
    bucketMs: win.granularity === "hour" ? HOUR_MS : DAY_MS,
    periodStartMs: win.periodStartMs,
    todayStartMs: win.todayStartMs,
    nowMs: q.nowMs,
  };
}

/** Raw sums for one scope; every map covers only rows inside the period. */
export interface ScopedUsageAggregate {
  /** Rows at or after local midnight (and not in the future). */
  today: UsageSums;
  period: UsageSums;
  /** By bucket index: 0 is `win.bucketStarts[0]`. */
  buckets: Map<number, UsageSums>;
  models: Map<string, UsageSums>;
  keys: Map<string, UsageSums>;
}

export function emptyScopedUsageAggregate(): ScopedUsageAggregate {
  return { today: emptySums(), period: emptySums(), buckets: new Map(), models: new Map(), keys: new Map() };
}

/** Reference reducer (MemoryOpsStore): the same sums the Postgres GROUP BY returns. */
export function reduceScopedUsage(q: ScopedUsageQuery, logs: Iterable<UsageLogItem>): ScopedUsageAggregate {
  const plan = scopedUsagePlan(q);
  const agg = emptyScopedUsageAggregate();
  for (const log of logs) {
    if (q.userId !== undefined && log.userId !== q.userId) continue;
    if (q.apiKeyId !== undefined && log.apiKeyId !== q.apiKeyId) continue;
    const at = Date.parse(log.createdAtIso);
    if (!Number.isFinite(at) || at > plan.nowMs) continue;
    if (at >= plan.todayStartMs) addLogToSums(agg.today, log);
    if (at < plan.periodStartMs) continue;
    addLogToSums(agg.period, log);
    bumpSums(agg.buckets, Math.floor((at - plan.periodStartMs) / plan.bucketMs), log);
    bumpSums(agg.models, log.publicModel, log);
    bumpSums(agg.keys, log.apiKeyId, log);
  }
  return agg;
}

export interface ScopedUsage {
  granularity: "hour" | "day";
  today: UsageTotals;
  period: UsageTotals;
  series: UsageSeriesPoint[];
  models: { model: string; requests: number; tokens: number; costNanoUsd: string }[];
  keys: { apiKeyId: string; requests: number; tokens: number; costNanoUsd: string }[];
}

export function finalizeScopedUsage(q: ScopedUsageQuery, agg: ScopedUsageAggregate): ScopedUsage {
  const { win } = scopedUsagePlan(q);
  return {
    granularity: win.granularity,
    today: sumsToTotals(agg.today),
    period: sumsToTotals(agg.period),
    series: win.bucketStarts.map((startMs, i) => {
      const b = agg.buckets.get(i) ?? emptySums();
      return {
        startIso: new Date(startMs).toISOString(),
        requests: b.requests,
        errors: b.errors,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        costNanoUsd: b.costNano.toString(),
      };
    }),
    models: rankSums(agg.models, 12).map(({ key, ...rest }) => ({ model: key, ...rest })),
    keys: rankSums(agg.keys, 20).map(({ key, ...rest }) => ({ apiKeyId: key, ...rest })),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Channel status page                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface ChannelStatusQuery {
  /** Only these groups are read (the page shows enabled, non-exclusive groups). */
  groupIds: string[];
  /** [startMs, endMs) split into buckets of bucketMs. */
  startMs: number;
  endMs: number;
  bucketMs: number;
}

export interface ChannelBucketSums {
  requests: number;
  errors: number;
  ttftSum: number;
  ttftCount: number;
  durationSum: number;
  durationCount: number;
  /** Newest row in the bucket (epoch ms). */
  lastMs: number;
}

/** groupId → bucket index → sums (absent = no traffic). */
export type ChannelStatusAggregate = Map<string, Map<number, ChannelBucketSums>>;

export function emptyChannelBucket(): ChannelBucketSums {
  return { requests: 0, errors: 0, ttftSum: 0, ttftCount: 0, durationSum: 0, durationCount: 0, lastMs: 0 };
}

export function reduceChannelStatus(q: ChannelStatusQuery, logs: Iterable<UsageLogItem>): ChannelStatusAggregate {
  const wanted = new Set(q.groupIds);
  const out: ChannelStatusAggregate = new Map();
  for (const log of logs) {
    if (!wanted.has(log.groupId)) continue;
    const at = Date.parse(log.createdAtIso);
    if (!(at >= q.startMs && at < q.endMs)) continue;
    let group = out.get(log.groupId);
    if (!group) {
      group = new Map();
      out.set(log.groupId, group);
    }
    const idx = Math.floor((at - q.startMs) / q.bucketMs);
    let b = group.get(idx);
    if (!b) {
      b = emptyChannelBucket();
      group.set(idx, b);
    }
    b.requests += 1;
    if (log.statusCode >= 400) b.errors += 1;
    if (log.ttftMs > 0) {
      b.ttftSum += log.ttftMs;
      b.ttftCount += 1;
    }
    if (log.durationMs > 0) {
      b.durationSum += log.durationMs;
      b.durationCount += 1;
    }
    if (at > b.lastMs) b.lastMs = at;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Ops monitor                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface OpsUsageQuery {
  /** Rows created in [sinceMs, nowMs]. */
  sinceMs: number;
  nowMs: number;
  /** Series buckets: index = floor((t - bucketStartMs) / bucketMs), kept when 0 ≤ index < bucketCount. */
  bucketStartMs: number;
  bucketMs: number;
  bucketCount: number;
}

export interface OpsPercentiles {
  ttftP50: number;
  ttftP95: number;
  durationP50: number;
  durationP95: number;
  durationP99: number;
}

export interface OpsGroupSums extends OpsPercentiles {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costNano: bigint;
}

export interface OpsRecentError {
  id: string;
  createdAtIso: string;
  requestId: string;
  userId: string;
  /** "" when the user no longer exists. */
  userEmail: string;
  model: string;
  accountId: string;
  groupId: string;
  /** "" when the group no longer exists. */
  groupName: string;
  statusCode: number;
  durationMs: number;
}

export interface OpsUsageAggregate {
  totals: OpsGroupSums & { lastMinuteRequests: number; lastMinuteTokens: number };
  buckets: Map<number, OpsGroupSums>;
  accounts: Map<string, OpsGroupSums>;
  models: Map<string, OpsGroupSums>;
  /** Error responses (status ≥ 400) by status code. */
  statusCodes: Map<number, number>;
  /** Newest 25 error responses. */
  recentErrors: OpsRecentError[];
}

export const OPS_RECENT_ERRORS = 25;

interface OpsCollector {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costNano: bigint;
  ttft: number[];
  duration: number[];
}

function collector(): OpsCollector {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, costNano: 0n, ttft: [], duration: [] };
}

function collect(c: OpsCollector, log: UsageLogItem): void {
  c.requests += 1;
  if (log.statusCode >= 400) c.errors += 1;
  c.inputTokens += log.inputTokens;
  c.outputTokens += log.outputTokens;
  c.costNano += BigInt(log.costNanoUsd);
  if (log.ttftMs > 0) c.ttft.push(log.ttftMs);
  if (log.durationMs > 0) c.duration.push(log.durationMs);
}

function settle(c: OpsCollector): OpsGroupSums {
  return {
    requests: c.requests,
    errors: c.errors,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costNano: c.costNano,
    ttftP50: nearestRank(c.ttft, 0.5),
    ttftP95: nearestRank(c.ttft, 0.95),
    durationP50: nearestRank(c.duration, 0.5),
    durationP95: nearestRank(c.duration, 0.95),
    durationP99: nearestRank(c.duration, 0.99),
  };
}

function collectInto<K>(map: Map<K, OpsCollector>, key: K, log: UsageLogItem): void {
  let c = map.get(key);
  if (!c) {
    c = collector();
    map.set(key, c);
  }
  collect(c, log);
}

function settleMap<K>(map: Map<K, OpsCollector>): Map<K, OpsGroupSums> {
  return new Map(Array.from(map, ([k, c]) => [k, settle(c)] as const));
}

/** Reference reducer (MemoryOpsStore); labels resolve user e-mails and group names. */
export function reduceOpsUsage(
  q: OpsUsageQuery,
  logs: Iterable<UsageLogItem>,
  labels: { userEmail: (userId: string) => string; groupName: (groupId: string) => string },
): OpsUsageAggregate {
  const total = collector();
  const buckets = new Map<number, OpsCollector>();
  const accounts = new Map<string, OpsCollector>();
  const models = new Map<string, OpsCollector>();
  const statusCodes = new Map<number, number>();
  const errors: UsageLogItem[] = [];
  let lastMinuteRequests = 0;
  let lastMinuteTokens = 0;
  for (const log of logs) {
    const t = Date.parse(log.createdAtIso);
    if (!(t >= q.sinceMs && t <= q.nowMs)) continue;
    collect(total, log);
    if (t > q.nowMs - MINUTE_MS) {
      lastMinuteRequests += 1;
      lastMinuteTokens += log.inputTokens + log.outputTokens;
    }
    const idx = Math.floor((t - q.bucketStartMs) / q.bucketMs);
    if (idx >= 0 && idx < q.bucketCount) collectInto(buckets, idx, log);
    collectInto(accounts, log.accountId, log);
    collectInto(models, log.publicModel, log);
    if (log.statusCode >= 400) {
      statusCodes.set(log.statusCode, (statusCodes.get(log.statusCode) ?? 0) + 1);
      errors.push(log);
    }
  }
  errors.sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : a.createdAtIso > b.createdAtIso ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return {
    totals: { ...settle(total), lastMinuteRequests, lastMinuteTokens },
    buckets: settleMap(buckets),
    accounts: settleMap(accounts),
    models: settleMap(models),
    statusCodes,
    recentErrors: errors.slice(0, OPS_RECENT_ERRORS).map((l) => ({
      id: l.id,
      createdAtIso: l.createdAtIso,
      requestId: l.requestId,
      userId: l.userId,
      userEmail: labels.userEmail(l.userId),
      model: l.publicModel,
      accountId: l.accountId,
      groupId: l.groupId,
      groupName: labels.groupName(l.groupId),
      statusCode: l.statusCode,
      durationMs: l.durationMs,
    })),
  };
}
