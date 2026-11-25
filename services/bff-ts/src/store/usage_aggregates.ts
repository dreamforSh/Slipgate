import {
  recognizeEndpoint,
  USAGE_STATS_HOURLY_MAX_MS,
  type DashboardRange,
  type EndpointFamily,
  type UsageEndpointStat,
  type UsageLogItem,
  type UsageRankBy,
  type UsageSeriesPoint,
  type UsageStatsResponse,
  type UsageTotals,
} from "@slipgate/contracts";
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

/* ------------------------------------------------------------------------------------------ */
/* Admin usage statistics: the usage page's charts over its own filters                       */
/* ------------------------------------------------------------------------------------------ */

/** Widest window the usage page charts; an earlier start is moved up to this many days before the end. */
export const USAGE_STATS_MAX_DAYS = 400;
/** Window when the filters give no start. */
export const USAGE_STATS_DEFAULT_DAYS = 30;
/** Default bucket size: hourly up to two days (an hourly ask is honoured up to USAGE_STATS_HOURLY_MAX_MS). */
const USAGE_STATS_AUTO_HOURLY_MS = 2 * DAY_MS;
/** Models and groups listed (the page sorts them by its own metric). */
export const USAGE_STATS_BREAKDOWN_LIMIT = 200;
/**
 * Longest the Postgres statistics read may run: it is exact over every matching row of a window
 * of up to USAGE_STATS_MAX_DAYS, so a wide unfiltered window on a busy install can be heavy.
 */
export const USAGE_STATS_TIMEOUT_MS = 15_000;

export interface UsageStatsPlan {
  sinceMs: number;
  untilMs: number;
  granularity: "hour" | "day";
  bucketMs: number;
  /** Local start of the first bucket (at or before sinceMs). */
  startMs: number;
  bucketCount: number;
  /** The requested start was moved up to USAGE_STATS_MAX_DAYS before the end. */
  clamped: boolean;
}

/** Window and buckets for the usage page's charts (`tzOffsetMinutes` as Date#getTimezoneOffset). */
export function usageStatsPlan(input: {
  sinceIso?: string;
  untilIso?: string;
  granularity?: "hour" | "day";
  nowMs: number;
  tzOffsetMinutes: number;
}): UsageStatsPlan {
  const until = input.untilIso ? Date.parse(input.untilIso) : Number.NaN;
  const untilMs = Number.isFinite(until) ? Math.min(until, input.nowMs) : input.nowMs;
  const since = input.sinceIso ? Date.parse(input.sinceIso) : Number.NaN;
  const wanted = Number.isFinite(since) ? since : untilMs - USAGE_STATS_DEFAULT_DAYS * DAY_MS;
  const earliest = untilMs - USAGE_STATS_MAX_DAYS * DAY_MS;
  const sinceMs = Math.min(Math.max(wanted, earliest), untilMs);
  const span = untilMs - sinceMs;
  const hourly =
    input.granularity === "hour" ? span <= USAGE_STATS_HOURLY_MAX_MS : input.granularity === undefined && span <= USAGE_STATS_AUTO_HOURLY_MS;
  const bucketMs = hourly ? HOUR_MS : DAY_MS;
  const offsetMs = input.tzOffsetMinutes * MINUTE_MS;
  const startMs = Math.floor((sinceMs - offsetMs) / bucketMs) * bucketMs + offsetMs;
  return {
    sinceMs,
    untilMs,
    granularity: hourly ? "hour" : "day",
    bucketMs,
    startMs,
    bucketCount: Math.max(1, Math.ceil((untilMs - startMs) / bucketMs)),
    clamped: wanted < earliest,
  };
}

export interface UsageStatsAggregate {
  totals: UsageSums;
  /** Keyed by bucket index (0 .. plan.bucketCount - 1). */
  buckets: Map<number, UsageSums>;
  models: Map<string, UsageSums>;
  groups: Map<string, UsageSums>;
  users: Map<string, UsageSums>;
  /** Keyed by codecPairKey(ingressCodec, egressCodec). */
  codecPairs: Map<string, UsageSums>;
  groupNames: Map<string, string>;
  userEmails: Map<string, string>;
}

/** Map key of an (ingress, egress) codec pair; codecs never contain a newline. */
export function codecPairKey(ingress: string, egress: string): string {
  return `${ingress}\n${egress}`;
}

export function emptyUsageStatsAggregate(): UsageStatsAggregate {
  return {
    totals: emptySums(),
    buckets: new Map(),
    models: new Map(),
    groups: new Map(),
    users: new Map(),
    codecPairs: new Map(),
    groupNames: new Map(),
    userEmails: new Map(),
  };
}

/** Reference reducer (MemoryOpsStore): `logs` already match the filters and the plan's window. */
export function reduceUsageStats(
  plan: UsageStatsPlan,
  logs: UsageLogItem[],
  labels: { userEmail: (id: string) => string; groupName: (id: string) => string },
): UsageStatsAggregate {
  const agg = emptyUsageStatsAggregate();
  for (const log of logs) {
    addLogToSums(agg.totals, log);
    const idx = Math.floor((Date.parse(log.createdAtIso) - plan.startMs) / plan.bucketMs);
    if (idx >= 0 && idx < plan.bucketCount) bumpSums(agg.buckets, idx, log);
    bumpSums(agg.models, log.publicModel, log);
    bumpSums(agg.groups, log.groupId, log);
    bumpSums(agg.users, log.userId, log);
    bumpSums(agg.codecPairs, codecPairKey(log.ingressCodec, log.egressCodec), log);
  }
  for (const id of agg.groups.keys()) agg.groupNames.set(id, labels.groupName(id));
  for (const id of agg.users.keys()) agg.userEmails.set(id, labels.userEmail(id));
  return agg;
}

function statsSums(s: UsageSums) {
  return {
    requests: s.requests,
    errors: s.errors,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    costNanoUsd: s.costNano.toString(),
  };
}

/** Descending by `by`, then tokens, requests and key: a total order, so both stores agree. */
function rankStats(map: Map<string, UsageSums>, by: UsageRankBy, limit: number): [string, UsageSums][] {
  const tokens = (s: UsageSums) => s.inputTokens + s.outputTokens;
  const primary = (a: UsageSums, b: UsageSums) =>
    by === "cost" ? (b.costNano > a.costNano ? 1 : b.costNano < a.costNano ? -1 : 0) : by === "requests" ? b.requests - a.requests : tokens(b) - tokens(a);
  return Array.from(map.entries())
    .filter(([, s]) => s.requests > 0)
    .sort(([ka, a], [kb, b]) => primary(a, b) || tokens(b) - tokens(a) || b.requests - a.requests || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, limit);
}

function addSums(into: UsageSums, s: UsageSums): void {
  into.requests += s.requests;
  into.errors += s.errors;
  into.inputTokens += s.inputTokens;
  into.outputTokens += s.outputTokens;
  into.cacheReadTokens += s.cacheReadTokens;
  into.costNano += s.costNano;
  into.durationSum += s.durationSum;
  into.durationCount += s.durationCount;
  into.ttftSum += s.ttftSum;
  into.ttftCount += s.ttftCount;
}

/** Tokens, then requests descending, then key ascending: a total order. */
function bySumsDesc(a: [string, UsageSums], b: [string, UsageSums]): number {
  const ta = a[1].inputTokens + a[1].outputTokens;
  const tb = b[1].inputTokens + b[1].outputTokens;
  return tb - ta || b[1].requests - a[1].requests || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/**
 * Inbound, upstream and inbound -> upstream endpoint distributions from the codec pairs, each codec
 * recognised as its endpoint (recognizeEndpoint) and codecs naming the same endpoint merged.
 */
function endpointStats(pairs: Map<string, UsageSums>) {
  type Acc = { sums: UsageSums; family: EndpointFamily; codecs: Set<string> };
  type PathAcc = { inbound: string; upstream: string; inboundFamily: EndpointFamily; upstreamFamily: EndpointFamily; sums: UsageSums };
  const inbound = new Map<string, Acc>();
  const upstream = new Map<string, Acc>();
  const paths = new Map<string, PathAcc>();
  const into = (map: Map<string, Acc>, codec: string, s: UsageSums) => {
    const ep = recognizeEndpoint(codec);
    let acc = map.get(ep.endpoint);
    if (!acc) {
      acc = { sums: emptySums(), family: ep.family, codecs: new Set() };
      map.set(ep.endpoint, acc);
    }
    addSums(acc.sums, s);
    if (codec) acc.codecs.add(codec);
  };
  for (const [key, s] of pairs) {
    if (s.requests <= 0) continue;
    const cut = key.indexOf("\n");
    const ingress = cut < 0 ? key : key.slice(0, cut);
    const egress = cut < 0 ? "" : key.slice(cut + 1);
    into(inbound, ingress, s);
    into(upstream, egress, s);
    const a = recognizeEndpoint(ingress);
    const b = recognizeEndpoint(egress);
    const pathKey = codecPairKey(a.endpoint, b.endpoint);
    let p = paths.get(pathKey);
    if (!p) {
      p = { inbound: a.endpoint, upstream: b.endpoint, inboundFamily: a.family, upstreamFamily: b.family, sums: emptySums() };
      paths.set(pathKey, p);
    }
    addSums(p.sums, s);
  }
  const list = (map: Map<string, Acc>): UsageEndpointStat[] =>
    Array.from(map.entries())
      .sort((x, y) => bySumsDesc([x[0], x[1].sums], [y[0], y[1].sums]))
      .slice(0, USAGE_STATS_BREAKDOWN_LIMIT)
      .map(([endpoint, acc]) => ({ endpoint, family: acc.family, codecs: Array.from(acc.codecs).sort(), ...statsSums(acc.sums) }));
  return {
    endpoints: list(inbound),
    upstreamEndpoints: list(upstream),
    endpointPaths: Array.from(paths.entries())
      .sort((x, y) => bySumsDesc([x[0], x[1].sums], [y[0], y[1].sums]))
      .slice(0, USAGE_STATS_BREAKDOWN_LIMIT)
      .map(([, p]) => ({
        inbound: p.inbound,
        upstream: p.upstream,
        inboundFamily: p.inboundFamily,
        upstreamFamily: p.upstreamFamily,
        ...statsSums(p.sums),
      })),
  };
}

export function finalizeUsageStats(
  plan: UsageStatsPlan,
  agg: UsageStatsAggregate,
  opts: { rankBy: UsageRankBy; rankLimit: number; nowMs: number },
): UsageStatsResponse {
  const series: UsageSeriesPoint[] = Array.from({ length: plan.bucketCount }, (_, i) => {
    const s = agg.buckets.get(i) ?? emptySums();
    return {
      startIso: new Date(plan.startMs + i * plan.bucketMs).toISOString(),
      requests: s.requests,
      errors: s.errors,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      costNanoUsd: s.costNano.toString(),
    };
  });
  return {
    generatedAtIso: new Date(opts.nowMs).toISOString(),
    sinceIso: new Date(plan.sinceMs).toISOString(),
    untilIso: new Date(plan.untilMs).toISOString(),
    clamped: plan.clamped,
    granularity: plan.granularity,
    totals: statsSums(agg.totals),
    series,
    models: rankStats(agg.models, "tokens", USAGE_STATS_BREAKDOWN_LIMIT).map(([model, s]) => ({ model, ...statsSums(s) })),
    groups: rankStats(agg.groups, "tokens", USAGE_STATS_BREAKDOWN_LIMIT).map(([groupId, s]) => ({
      groupId,
      name: agg.groupNames.get(groupId) ?? "",
      ...statsSums(s),
    })),
    users: rankStats(agg.users, opts.rankBy, opts.rankLimit).map(([userId, s]) => ({
      userId,
      email: agg.userEmails.get(userId) ?? "",
      ...statsSums(s),
    })),
    userCount: Array.from(agg.users.values()).filter((s) => s.requests > 0).length,
    rankBy: opts.rankBy,
    ...endpointStats(agg.codecPairs),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Admin dashboard: today / yesterday / period totals, buckets, breakdowns, top-user series    */
/* ------------------------------------------------------------------------------------------ */

/** Longest the Postgres dashboard read may run (one scan of the window plus the top-user buckets). */
export const DASHBOARD_USAGE_TIMEOUT_MS = 15_000;
/** Users whose per-bucket usage the dashboard charts. */
export const DASHBOARD_TOP_USERS = 5;

export interface DashboardUsageAggregate {
  today: UsageSums;
  yesterday: UsageSums;
  period: UsageSums;
  /** Distinct users with a request since the viewer's local midnight. */
  activeToday: number;
  lastMinuteRequests: number;
  lastMinuteTokens: number;
  /** Keyed by bucket index (0 .. win.bucketStarts.length - 1). */
  buckets: Map<number, UsageSums>;
  /** Period breakdowns. */
  models: Map<string, UsageSums>;
  users: Map<string, UsageSums>;
  groups: Map<string, UsageSums>;
  /** Per-bucket sums of the top DASHBOARD_TOP_USERS users (dashboardTopUserIds order). */
  userBuckets: Map<string, Map<number, UsageSums>>;
}

export function emptyDashboardUsage(): DashboardUsageAggregate {
  return {
    today: emptySums(),
    yesterday: emptySums(),
    period: emptySums(),
    activeToday: 0,
    lastMinuteRequests: 0,
    lastMinuteTokens: 0,
    buckets: new Map(),
    models: new Map(),
    users: new Map(),
    groups: new Map(),
    userBuckets: new Map(),
  };
}

/** The users the dashboard charts over time: rankSums order (tokens, requests, id). */
export function dashboardTopUserIds(users: Map<string, UsageSums>): string[] {
  return rankSums(users, DASHBOARD_TOP_USERS).map((u) => u.key);
}

/**
 * Reference reducer (MemoryOpsStore, unit tests): `logs` are rows created at or after
 * `win.sinceMs`, any order; rows after `nowMs` are ignored.
 */
export function reduceDashboardUsage(win: DashboardWindow, nowMs: number, logs: readonly UsageLogItem[]): DashboardUsageAggregate {
  const agg = emptyDashboardUsage();
  const bucketMs = win.granularity === "hour" ? HOUR_MS : DAY_MS;
  const count = win.bucketStarts.length;
  const activeToday = new Set<string>();
  const inPeriod: { log: UsageLogItem; idx: number }[] = [];
  for (const log of logs) {
    const at = Date.parse(log.createdAtIso);
    if (!Number.isFinite(at) || at > nowMs || at < win.sinceMs) continue;
    if (at >= win.todayStartMs) {
      addLogToSums(agg.today, log);
      activeToday.add(log.userId);
    } else if (at >= win.yesterdayStartMs) {
      addLogToSums(agg.yesterday, log);
    }
    if (at > nowMs - MINUTE_MS) {
      agg.lastMinuteRequests += 1;
      agg.lastMinuteTokens += log.inputTokens + log.outputTokens;
    }
    if (at < win.periodStartMs) continue;
    addLogToSums(agg.period, log);
    const idx = Math.floor((at - win.periodStartMs) / bucketMs);
    if (idx >= 0 && idx < count) bumpSums(agg.buckets, idx, log);
    bumpSums(agg.models, log.publicModel, log);
    bumpSums(agg.users, log.userId, log);
    bumpSums(agg.groups, log.groupId, log);
    inPeriod.push({ log, idx });
  }
  agg.activeToday = activeToday.size;
  const top = new Set(dashboardTopUserIds(agg.users));
  for (const { log, idx } of inPeriod) {
    if (!top.has(log.userId) || idx < 0 || idx >= count) continue;
    let perUser = agg.userBuckets.get(log.userId);
    if (!perUser) {
      perUser = new Map();
      agg.userBuckets.set(log.userId, perUser);
    }
    bumpSums(perUser, idx, log);
  }
  return agg;
}
