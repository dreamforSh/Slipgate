import type {
  AdminDashboardStats,
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

/** Rows read per dashboard request; beyond this the period totals become a lower bound. */
export const DASHBOARD_MAX_ROWS = 100_000;
const BREAKDOWN_LIMIT = 10;

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
export function dashboardWindow(range: DashboardRange, nowMs: number, tzOffsetMinutes: number): DashboardWindow {
  const offsetMs = tzOffsetMinutes * MINUTE_MS;
  const floorLocal = (ms: number, unit: number) => Math.floor((ms - offsetMs) / unit) * unit + offsetMs;

  const todayStartMs = floorLocal(nowMs, DAY_MS);
  const yesterdayStartMs = todayStartMs - DAY_MS;

  let granularity: "hour" | "day";
  let bucketStarts: number[];
  if (range === "24h") {
    granularity = "hour";
    const currentHour = floorLocal(nowMs, HOUR_MS);
    bucketStarts = Array.from({ length: 24 }, (_, i) => currentHour - (23 - i) * HOUR_MS);
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

class TotalsAccumulator {
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

interface Breakdown {
  requests: number;
  tokens: number;
  cost: bigint;
}

function bump(map: Map<string, Breakdown>, key: string, log: UsageLogItem) {
  const entry = map.get(key) ?? { requests: 0, tokens: 0, cost: 0n };
  entry.requests += 1;
  entry.tokens += log.inputTokens + log.outputTokens;
  entry.cost += BigInt(log.costNanoUsd);
  map.set(key, entry);
}

function ranked(map: Map<string, Breakdown>, limit = BREAKDOWN_LIMIT) {
  return Array.from(map.entries())
    .sort(([, a], [, b]) => b.tokens - a.tokens || b.requests - a.requests)
    .slice(0, limit)
    .map(([key, v]) => ({ key, requests: v.requests, tokens: v.tokens, costNanoUsd: v.cost.toString() }));
}

export interface DashboardInputs {
  range: DashboardRange;
  nowMs: number;
  tzOffsetMinutes: number;
  /** Usage rows created at or after `dashboardWindow(...).sinceMs`, any order. */
  logs: UsageLogItem[];
  truncated: boolean;
  users: UserProfile[];
  groups: GroupItem[];
  accounts: UpstreamAccount[];
  apiKeys: { enabled: boolean }[];
}

export function buildDashboardStats(input: DashboardInputs): AdminDashboardStats {
  const win = dashboardWindow(input.range, input.nowMs, input.tzOffsetMinutes);
  const bucketSize = win.granularity === "hour" ? HOUR_MS : DAY_MS;

  const today = new TotalsAccumulator();
  const yesterday = new TotalsAccumulator();
  const period = new TotalsAccumulator();
  const buckets = win.bucketStarts.map(() => ({
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0n,
  }));
  const models = new Map<string, Breakdown>();
  const users = new Map<string, Breakdown>();
  const groups = new Map<string, Breakdown>();
  const activeToday = new Set<string>();
  let rpm = 0;
  let tpm = 0;

  for (const log of input.logs) {
    const at = Date.parse(log.createdAtIso);
    if (!Number.isFinite(at) || at > input.nowMs) continue;

    if (at >= win.todayStartMs) {
      today.add(log);
      activeToday.add(log.userId);
    } else if (at >= win.yesterdayStartMs) {
      yesterday.add(log);
    }
    if (at > input.nowMs - MINUTE_MS) {
      rpm += 1;
      tpm += log.inputTokens + log.outputTokens;
    }
    if (at < win.periodStartMs) continue;

    period.add(log);
    const idx = Math.floor((at - win.periodStartMs) / bucketSize);
    const bucket = buckets[idx];
    if (bucket) {
      bucket.requests += 1;
      if (log.statusCode >= 400) bucket.errors += 1;
      bucket.inputTokens += log.inputTokens;
      bucket.outputTokens += log.outputTokens;
      bucket.cost += BigInt(log.costNanoUsd);
    }
    bump(models, log.publicModel, log);
    bump(users, log.userId, log);
    bump(groups, log.groupId, log);
  }

  const emailById = new Map(input.users.map((u) => [u.id, u.email]));
  const groupNameById = new Map(input.groups.map((g) => [g.id, g.name]));

  const series: UsageSeriesPoint[] = buckets.map((b, i) => ({
    startIso: new Date(win.bucketStarts[i]!).toISOString(),
    requests: b.requests,
    errors: b.errors,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costNanoUsd: b.cost.toString(),
  }));

  const countStatus = (status: UpstreamAccount["status"]) => input.accounts.filter((a) => a.status === status).length;

  return {
    generatedAtIso: new Date(input.nowMs).toISOString(),
    range: input.range,
    granularity: win.granularity,
    truncated: input.truncated,
    today: today.toJSON(),
    yesterday: yesterday.toJSON(),
    period: period.toJSON(),
    throughput: { rpm, tpm },
    users: {
      total: input.users.length,
      newToday: input.users.filter((u) => Date.parse(u.createdAtIso) >= win.todayStartMs).length,
      activeToday: activeToday.size,
    },
    apiKeys: {
      total: input.apiKeys.length,
      enabled: input.apiKeys.filter((k) => k.enabled).length,
    },
    accounts: {
      total: input.accounts.length,
      active: countStatus("active"),
      paused: countStatus("paused"),
      cooldown: countStatus("cooldown"),
      expired: countStatus("expired"),
      failedTests: input.accounts.filter((a) => a.lastTest && !a.lastTest.ok).length,
    },
    series,
    models: ranked(models).map(({ key, ...rest }) => ({ model: key, ...rest })),
    topUsers: ranked(users).map(({ key, ...rest }) => ({ userId: key, email: emailById.get(key) ?? key, ...rest })),
    groups: ranked(groups).map(({ key, ...rest }) => ({ groupId: key, name: groupNameById.get(key) ?? key, ...rest })),
  };
}
