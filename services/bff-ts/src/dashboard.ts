import {
  dashboardTopUserIds,
  rankSums,
  reduceDashboardUsage,
  sumsToTotals,
  type DashboardUsageAggregate,
} from "./store/usage_aggregates.ts";
import type {
  AccountStatsRange,
  AccountUsageStats,
  AdminDashboardStats,
  DashboardGranularity,
  DashboardRange,
  GroupItem,
  UpstreamAccount,
  UsageLogItem,
  UsageSeriesPoint,
  UsageTotals,
  UserProfile,
} from "@slipgate/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Rows read per account-stats request; beyond this its totals become a lower bound. */
export const DASHBOARD_MAX_ROWS = 100_000;
const BREAKDOWN_LIMIT = 10;
/** Users charted over time on the dashboard (more lines stop being readable). */
const USER_SERIES_LIMIT = 5;

export interface DashboardWindow {
  /** Earliest instant whose usage rows the aggregation needs. */
  sinceMs: number;
  periodStartMs: number;
  todayStartMs: number;
  yesterdayStartMs: number;
  granularity: "hour" | "day";
  bucketStarts: number[];
}

/**
 * Bucket boundaries in the viewer's local time. `tzOffsetMinutes` follows
 * `Date#getTimezoneOffset()` (UTC minus local, e.g. -480 for UTC+8).
 */
export function dashboardWindow(
  range: DashboardRange,
  nowMs: number,
  tzOffsetMinutes: number,
  granularityHint?: DashboardGranularity,
): DashboardWindow {
  const offsetMs = tzOffsetMinutes * MINUTE_MS;
  const floorLocal = (ms: number, unit: number) => Math.floor((ms - offsetMs) / unit) * unit + offsetMs;

  const todayStartMs = floorLocal(nowMs, DAY_MS);
  const yesterdayStartMs = todayStartMs - DAY_MS;

  let granularity: "hour" | "day";
  let bucketStarts: number[];
  if (range === "24h" || (range === "7d" && granularityHint === "hour")) {
    // 24h is always hourly; 7d may ask for hourly buckets (168 of them).
    granularity = "hour";
    const hours = range === "24h" ? 24 : 7 * 24;
    const currentHour = floorLocal(nowMs, HOUR_MS);
    bucketStarts = Array.from({ length: hours }, (_, i) => currentHour - (hours - 1 - i) * HOUR_MS);
  } else {
    granularity = "day";
    const days = range === "7d" ? 7 : 30;
    bucketStarts = Array.from({ length: days }, (_, i) => todayStartMs - (days - 1 - i) * DAY_MS);
  }
  const periodStartMs = bucketStarts[0]!;
  return {
    sinceMs: Math.min(periodStartMs, yesterdayStartMs),
    periodStartMs,
    todayStartMs,
    yesterdayStartMs,
    granularity,
    bucketStarts,
  };
}

export class TotalsAccumulator {
  requests = 0;
  errors = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cost = 0n;
  private durationSum = 0;
  private durationCount = 0;
  private ttftSum = 0;
  private ttftCount = 0;

  add(log: UsageLogItem) {
    this.requests += 1;
    if (log.statusCode >= 400) this.errors += 1;
    this.inputTokens += log.inputTokens;
    this.outputTokens += log.outputTokens;
    this.cacheReadTokens += log.cacheReadTokens;
    this.cost += BigInt(log.costNanoUsd);
    if (log.durationMs > 0) {
      this.durationSum += log.durationMs;
      this.durationCount += 1;
    }
    if (log.ttftMs > 0) {
      this.ttftSum += log.ttftMs;
      this.ttftCount += 1;
    }
  }

  toJSON(): UsageTotals {
    return {
      requests: this.requests,
      errors: this.errors,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      costNanoUsd: this.cost.toString(),
      avgDurationMs: this.durationCount ? Math.round(this.durationSum / this.durationCount) : 0,
      avgTtftMs: this.ttftCount ? Math.round(this.ttftSum / this.ttftCount) : 0,
    };
  }
}

export interface Breakdown {
  requests: number;
  tokens: number;
  cost: bigint;
}

export function bump(map: Map<string, Breakdown>, key: string, log: UsageLogItem) {
  const entry = map.get(key) ?? { requests: 0, tokens: 0, cost: 0n };
  entry.requests += 1;
  entry.tokens += log.inputTokens + log.outputTokens;
  entry.cost += BigInt(log.costNanoUsd);
  map.set(key, entry);
}

export function ranked(map: Map<string, Breakdown>, limit = BREAKDOWN_LIMIT) {
  return Array.from(map.entries())
    .sort(([, a], [, b]) => b.tokens - a.tokens || b.requests - a.requests)
    .slice(0, limit)
    .map(([key, v]) => ({ key, requests: v.requests, tokens: v.tokens, costNanoUsd: v.cost.toString() }));
}

/** Accounts expiring within this window count as "expiring soon" (same as the account list). */
const EXPIRING_SOON_MS = 7 * 24 * 3_600_000;

export interface DashboardInputs {
  range: DashboardRange;
  /** Requested bucket size (see dashboardWindow). */
  granularity?: DashboardGranularity;
  nowMs: number;
  tzOffsetMinutes: number;
  /**
   * The window's usage aggregated by the store (OpsStore.dashboardUsage, SQL in Postgres), or raw
   * rows created at or after `dashboardWindow(...).sinceMs` to reduce here (tests).
   */
  usage?: DashboardUsageAggregate;
  logs?: UsageLogItem[];
  /** Always false with `usage` (exact); kept for older consoles. */
  truncated?: boolean;
  users: UserProfile[];
  groups: GroupItem[];
  accounts: UpstreamAccount[];
  /** API key counts (OpsStore.countApiKeys), or the keys themselves. */
  apiKeys: { total: number; enabled: number } | { enabled: boolean }[];
}

export function buildDashboardStats(input: DashboardInputs): AdminDashboardStats {
  const win = dashboardWindow(input.range, input.nowMs, input.tzOffsetMinutes, input.granularity);
  const usage = input.usage ?? reduceDashboardUsage(win, input.nowMs, input.logs ?? []);
  const count = win.bucketStarts.length;

  const emailById = new Map(input.users.map((u) => [u.id, u.email]));
  const groupNameById = new Map(input.groups.map((g) => [g.id, g.name]));

  const series: UsageSeriesPoint[] = win.bucketStarts.map((startMs, i) => {
    const b = usage.buckets.get(i);
    return {
      startIso: new Date(startMs).toISOString(),
      requests: b?.requests ?? 0,
      errors: b?.errors ?? 0,
      inputTokens: b?.inputTokens ?? 0,
      outputTokens: b?.outputTokens ?? 0,
      cacheReadTokens: b?.cacheReadTokens ?? 0,
      costNanoUsd: (b?.costNano ?? 0n).toString(),
    };
  });

  const topUsers = rankSums(usage.users, BREAKDOWN_LIMIT).map(({ key, ...rest }) => ({ userId: key, email: emailById.get(key) ?? key, ...rest }));
  const userSeries = dashboardTopUserIds(usage.users).slice(0, USER_SERIES_LIMIT).flatMap((userId) => {
    const perUser = usage.userBuckets.get(userId);
    if (!perUser) return [];
    const tokens = Array.from({ length: count }, (_, i) => {
      const s = perUser.get(i);
      return s ? s.inputTokens + s.outputTokens : 0;
    });
    const costNanoUsd = Array.from({ length: count }, (_, i) => (perUser.get(i)?.costNano ?? 0n).toString());
    return [{ userId, email: emailById.get(userId) ?? userId, tokens, costNanoUsd }];
  });

  // Effective status: a lapsed subscription counts as expired, a finished cooldown as active.
  const countStatus = (status: UpstreamAccount["status"]) =>
    input.accounts.filter((a) => a.effectiveStatus === status).length;
  const apiKeys = Array.isArray(input.apiKeys)
    ? { total: input.apiKeys.length, enabled: input.apiKeys.filter((k) => k.enabled).length }
    : input.apiKeys;

  return {
    generatedAtIso: new Date(input.nowMs).toISOString(),
    range: input.range,
    granularity: win.granularity,
    truncated: input.truncated ?? false,
    today: sumsToTotals(usage.today),
    yesterday: sumsToTotals(usage.yesterday),
    period: sumsToTotals(usage.period),
    throughput: { rpm: usage.lastMinuteRequests, tpm: usage.lastMinuteTokens },
    users: {
      total: input.users.length,
      newToday: input.users.filter((u) => Date.parse(u.createdAtIso) >= win.todayStartMs).length,
      activeToday: usage.activeToday,
    },
    apiKeys,
    accounts: {
      total: input.accounts.length,
      active: countStatus("active"),
      paused: countStatus("paused"),
      cooldown: countStatus("cooldown"),
      expired: countStatus("expired"),
      failedTests: input.accounts.filter((a) => a.lastTest && !a.lastTest.ok).length,
      quotaExceeded: input.accounts.filter((a) => a.quota && a.quota.state !== "ok").length,
      expiringSoon: input.accounts.filter((a) => {
        if (a.effectiveStatus === "expired" || !a.expiresAtIso) return false;
        const at = Date.parse(a.expiresAtIso);
        return Number.isFinite(at) && at > input.nowMs && at - input.nowMs <= EXPIRING_SOON_MS;
      }).length,
    },
    series,
    models: rankSums(usage.models, BREAKDOWN_LIMIT).map(({ key, ...rest }) => ({ model: key, ...rest })),
    topUsers,
    userSeries,
    groups: rankSums(usage.groups, BREAKDOWN_LIMIT).map(({ key, ...rest }) => ({ groupId: key, name: groupNameById.get(key) ?? key, ...rest })),
  };
}

function emptyBuckets(count: number) {
  return Array.from({ length: count }, () => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0n }));
}

export interface AccountStatsInputs {
  accountId: string;
  range: AccountStatsRange;
  nowMs: number;
  tzOffsetMinutes: number;
  /** This account's usage rows created at or after `dashboardWindow(...).sinceMs`, any order. */
  logs: UsageLogItem[];
  truncated: boolean;
}

/** One account's traffic over a window, bucketed like the admin dashboard. */
export function buildAccountUsageStats(input: AccountStatsInputs): AccountUsageStats {
  const win = dashboardWindow(input.range, input.nowMs, input.tzOffsetMinutes);
  const bucketSize = win.granularity === "hour" ? HOUR_MS : DAY_MS;
  const today = new TotalsAccumulator();
  const period = new TotalsAccumulator();
  const buckets = emptyBuckets(win.bucketStarts.length);
  const models = new Map<string, Breakdown>();
  const errorCodes = new Map<number, number>();

  for (const log of input.logs) {
    const at = Date.parse(log.createdAtIso);
    if (!Number.isFinite(at) || at > input.nowMs) continue;
    if (at >= win.todayStartMs) today.add(log);
    if (at < win.periodStartMs) continue;

    period.add(log);
    const bucket = buckets[Math.floor((at - win.periodStartMs) / bucketSize)];
    if (bucket) {
      bucket.requests += 1;
      if (log.statusCode >= 400) bucket.errors += 1;
      bucket.inputTokens += log.inputTokens;
      bucket.outputTokens += log.outputTokens;
      bucket.cost += BigInt(log.costNanoUsd);
    }
    bump(models, log.publicModel, log);
    if (log.statusCode >= 400) errorCodes.set(log.statusCode, (errorCodes.get(log.statusCode) ?? 0) + 1);
  }

  const series: UsageSeriesPoint[] = buckets.map((b, i) => ({
    startIso: new Date(win.bucketStarts[i]!).toISOString(),
    requests: b.requests,
    errors: b.errors,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costNanoUsd: b.cost.toString(),
  }));

  let peak: AccountUsageStats["peak"] = null;
  for (const point of series) {
    if (point.requests > 0 && (!peak || point.requests > peak.requests)) {
      peak = { startIso: point.startIso, requests: point.requests, costNanoUsd: point.costNanoUsd };
    }
  }

  return {
    generatedAtIso: new Date(input.nowMs).toISOString(),
    accountId: input.accountId,
    range: input.range,
    granularity: win.granularity,
    truncated: input.truncated,
    today: today.toJSON(),
    period: period.toJSON(),
    activeBuckets: series.filter((p) => p.requests > 0).length,
    peak,
    series,
    models: ranked(models).map(({ key, ...rest }) => ({ model: key, ...rest })),
    errorCodes: Array.from(errorCodes.entries())
      .sort(([codeA, a], [codeB, b]) => b - a || codeA - codeB)
      .map(([statusCode, count]) => ({ statusCode, count })),
  };
}
