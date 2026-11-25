import { z } from "zod";

export const DashboardRangeSchema = z.enum(["24h", "7d", "30d"]);
export type DashboardRange = z.infer<typeof DashboardRangeSchema>;

/** Bucket size; `hour` is honoured for 24h and 7d (30d always buckets by day). */
export const DashboardGranularitySchema = z.enum(["hour", "day"]);
export type DashboardGranularity = z.infer<typeof DashboardGranularitySchema>;

const Count = z.number().int().nonnegative();
const NanoUsd = z.string().regex(/^\d+$/);

/** Request/token/cost totals over a window. Costs are nano-USD integer strings. */
export const UsageTotalsSchema = z.object({
  requests: Count,
  errors: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  costNanoUsd: NanoUsd,
  /** Mean over requests that reported a duration / first-token time; 0 when none did. */
  avgDurationMs: z.number().nonnegative(),
  avgTtftMs: z.number().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageSeriesPointSchema = z.object({
  startIso: z.string(),
  requests: Count,
  errors: Count,
  inputTokens: Count,
  outputTokens: Count,
  /** Prompt tokens served from the provider cache (admin dashboard series only). */
  cacheReadTokens: Count.optional(),
  costNanoUsd: NanoUsd,
});
export type UsageSeriesPoint = z.infer<typeof UsageSeriesPointSchema>;

const BreakdownBase = {
  requests: Count,
  tokens: Count,
  costNanoUsd: NanoUsd,
};

export const AdminDashboardStatsSchema = z.object({
  generatedAtIso: z.string(),
  range: DashboardRangeSchema,
  granularity: z.enum(["hour", "day"]),
  /** True when the window held more usage rows than the aggregation reads; totals are then a lower bound. */
  truncated: z.boolean(),
  today: UsageTotalsSchema,
  yesterday: UsageTotalsSchema,
  period: UsageTotalsSchema,
  throughput: z.object({ rpm: Count, tpm: Count }),
  users: z.object({ total: Count, newToday: Count, activeToday: Count }),
  apiKeys: z.object({ total: Count, enabled: Count }),
  accounts: z.object({
    total: Count,
    active: Count,
    paused: Count,
    cooldown: Count,
    expired: Count,
    failedTests: Count,
    /** Over a spend-quota limit (the data plane pauses them). */
    quotaExceeded: Count.default(0),
    /** Not expired yet, but expiring within 7 days. */
    expiringSoon: Count.default(0),
  }),
  series: z.array(UsageSeriesPointSchema),
  models: z.array(z.object({ model: z.string(), ...BreakdownBase })),
  topUsers: z.array(z.object({ userId: z.string(), email: z.string(), ...BreakdownBase })),
  /** Per-bucket tokens and spend of the top users (same order as `topUsers`, at most 5). */
  userSeries: z
    .array(
      z.object({
        userId: z.string(),
        email: z.string(),
        tokens: z.array(Count),
        costNanoUsd: z.array(NanoUsd),
      }),
    )
    .default([]),
  groups: z.array(z.object({ groupId: z.string(), name: z.string(), ...BreakdownBase })),
});
export type AdminDashboardStats = z.infer<typeof AdminDashboardStatsSchema>;
