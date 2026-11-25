import { z } from "zod";
import { PageQuerySchema } from "./commerce.ts";
import { DashboardRangeSchema, UsageSeriesPointSchema, UsageTotalsSchema } from "./dashboard.ts";
import { UsageLogItemSchema } from "./dataplane.ts";

/**
 * Usage-log browsing (admin and self-service), CSV export, the user dashboard, the public
 * key-usage lookup, the model plaza and the channel status page.
 */

export const UsageOutcomeSchema = z.enum(["success", "error"]);
export type UsageOutcome = z.infer<typeof UsageOutcomeSchema>;

export const UsageQuerySchema = PageQuerySchema.extend({
  userId: z.string().trim().max(64).optional().catch(undefined),
  apiKeyId: z.string().trim().max(64).optional().catch(undefined),
  groupId: z.string().trim().max(64).optional().catch(undefined),
  accountId: z.string().trim().max(64).optional().catch(undefined),
  /** Substring match on the public model name. */
  model: z.string().trim().max(128).optional().catch(undefined),
  outcome: UsageOutcomeSchema.optional().catch(undefined),
  /** Self-service: absent means the USAGE_DEFAULT_WINDOW_DAYS before `untilIso` (or now). */
  sinceIso: z.string().datetime({ offset: true }).optional().catch(undefined),
  untilIso: z.string().datetime({ offset: true }).optional().catch(undefined),
  /**
   * `false`/`0` skips the COUNT/SUM summary over every matching row: for callers that only list
   * rows (the dashboard's recent-requests widget) or page through a result whose summary they
   * already have. The response then carries `summary: null` and no exact `total`.
   */
  summary: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((v) => v === true || v === "true" || v === "1")
    .optional()
    .catch(undefined),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const UsageRowSchema = UsageLogItemSchema.extend({
  userEmail: z.string(),
  apiKeyName: z.string(),
  groupName: z.string(),
  accountName: z.string(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const UsageSummarySchema = z.object({
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costNanoUsd: z.string().regex(/^\d+$/),
  avgDurationMs: z.number().nonnegative(),
  avgTtftMs: z.number().nonnegative(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsagePageResponseSchema = z.object({
  items: z.array(UsageRowSchema),
  /** Matching rows. With `summary=false` nothing is counted: this is only offset + items.length. */
  total: z.number().int().nonnegative(),
  /** null when the request asked for `summary=false`. */
  summary: UsageSummarySchema.nullable(),
});
export type UsagePageResponse = z.infer<typeof UsagePageResponseSchema>;

/** Rows a CSV export may contain; larger windows must be narrowed first. */
export const USAGE_EXPORT_MAX_ROWS = 50_000;

/**
 * Self-service browsing and export without `sinceIso` cover this many days before `untilIso`
 * (or now): usage history is never pruned, and the summary aggregates every matching row.
 */
export const USAGE_DEFAULT_WINDOW_DAYS = 90;

/**
 * Self-service paging reaches at most this many rows (`page * pageSize`): OFFSET walks every
 * row it skips, so deeper pages are refused; narrow the window or export instead.
 */
export const USAGE_QUERY_MAX_PAGED_ROWS = 50_000;

/* ------------------------------------------------------------------------------------------ */
/* User dashboard                                                                             */
/* ------------------------------------------------------------------------------------------ */

const Count = z.number().int().nonnegative();
const NanoUsd = z.string().regex(/^\d+$/);

export const UserDashboardStatsSchema = z.object({
  generatedAtIso: z.string(),
  range: DashboardRangeSchema,
  granularity: z.enum(["hour", "day"]),
  /** Always false: the store aggregates every row of the window. Kept for older consoles. */
  truncated: z.boolean(),
  balanceNanoUsd: z.string().regex(/^-?\d+$/),
  spentNanoUsd: z.string().regex(/^-?\d+$/),
  today: UsageTotalsSchema,
  period: UsageTotalsSchema,
  apiKeys: z.object({ total: Count, enabled: Count }),
  subscriptions: z.object({ active: Count }),
  series: z.array(UsageSeriesPointSchema),
  models: z.array(z.object({ model: z.string(), requests: Count, tokens: Count, costNanoUsd: NanoUsd })),
  keys: z.array(z.object({ apiKeyId: z.string(), name: z.string(), requests: Count, tokens: Count, costNanoUsd: NanoUsd })),
});
export type UserDashboardStats = z.infer<typeof UserDashboardStatsSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Admin usage statistics (the usage page's charts and user ranking)                          */
/* ------------------------------------------------------------------------------------------ */

export const UsageRankBySchema = z.enum(["requests", "tokens", "cost"]);
export type UsageRankBy = z.infer<typeof UsageRankBySchema>;

/** Users the ranking may list. */
export const USAGE_RANK_LIMITS = [10, 20, 50, 100] as const;

/**
 * Widest window the usage charts bucket by hour: 7 days plus an hour of slack, so a "last 7 days"
 * window whose start the browser computed a moment before the server's now still qualifies.
 */
export const USAGE_STATS_HOURLY_MAX_MS = 7 * 86_400_000 + 3_600_000;

/**
 * The usage list's filters (no paging) plus the chart options. Without `sinceIso` the window is
 * the 30 days before `untilIso` (or now); a start more than 400 days before the end is moved up.
 * `granularity` is a hint: hourly buckets only up to USAGE_STATS_HOURLY_MAX_MS (default: hourly up to 2 days).
 */
export const UsageStatsQuerySchema = UsageQuerySchema.omit({ page: true, pageSize: true, summary: true }).extend({
  granularity: z.enum(["hour", "day"]).optional().catch(undefined),
  rankBy: UsageRankBySchema.catch("tokens").default("tokens"),
  rankLimit: z.coerce.number().int().min(1).max(100).catch(20).default(20),
});
export type UsageStatsQuery = z.infer<typeof UsageStatsQuerySchema>;

const UsageStatsSums = {
  requests: Count,
  errors: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  costNanoUsd: NanoUsd,
};

export const UsageStatsResponseSchema = z.object({
  generatedAtIso: z.string(),
  /** The window actually charted. */
  sinceIso: z.string(),
  untilIso: z.string(),
  /** The requested start was moved up to 400 days before the end. */
  clamped: z.boolean(),
  granularity: z.enum(["hour", "day"]),
  totals: z.object(UsageStatsSums),
  series: z.array(UsageSeriesPointSchema),
  /** Every model / group of the window by tokens (at most 200 each); the page re-sorts them. */
  models: z.array(z.object({ model: z.string(), ...UsageStatsSums })),
  groups: z.array(z.object({ groupId: z.string(), name: z.string(), ...UsageStatsSums })),
  /** Top `rankLimit` users by `rankBy`. */
  users: z.array(z.object({ userId: z.string(), email: z.string(), ...UsageStatsSums })),
  /** Distinct users with traffic in the window. */
  userCount: Count,
  rankBy: UsageRankBySchema,
});
export type UsageStatsResponse = z.infer<typeof UsageStatsResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Public key-usage lookup                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const KeyUsageLookupRequestSchema = z.object({
  apiKey: z.string().trim().regex(/^[A-Za-z0-9_-]{16,140}$/, "Not a valid API key"),
});
export type KeyUsageLookupRequest = z.infer<typeof KeyUsageLookupRequestSchema>;

export const KeyUsageLookupResponseSchema = z.object({
  keyName: z.string(),
  keyPrefix: z.string(),
  enabled: z.boolean(),
  expiresAtIso: z.string().nullable(),
  groupName: z.string(),
  billing: z.enum(["balance", "subscription"]),
  balanceNanoUsd: z.string().regex(/^-?\d+$/),
  today: UsageTotalsSchema,
  last30d: UsageTotalsSchema,
  series: z.array(UsageSeriesPointSchema),
  models: z.array(z.object({ model: z.string(), requests: Count, tokens: Count, costNanoUsd: NanoUsd })),
  recent: z.array(
    z.object({
      createdAtIso: z.string(),
      model: z.string(),
      inputTokens: Count,
      outputTokens: Count,
      costNanoUsd: NanoUsd,
      statusCode: z.number().int(),
      durationMs: Count,
    }),
  ),
});
export type KeyUsageLookupResponse = z.infer<typeof KeyUsageLookupResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Model plaza                                                                                */
/* ------------------------------------------------------------------------------------------ */

export const ModelPriceSchema = z.object({
  /** Nano-USD per token before the group multiplier. */
  inputNanoPerToken: z.number().nonnegative(),
  outputNanoPerToken: z.number().nonnegative(),
  cacheReadNanoPerToken: z.number().nonnegative(),
  cacheWriteNanoPerToken: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PlazaModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  source: z.enum(["allowlist", "route", "builtin", "discovered"]),
  price: ModelPriceSchema,
});
export type PlazaModel = z.infer<typeof PlazaModelSchema>;

export const PlazaGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  platform: z.string(),
  billing: z.enum(["balance", "subscription"]),
  rateMultiplier: z.number().positive(),
  activeAccounts: Count,
  models: z.array(PlazaModelSchema),
});
export type PlazaGroup = z.infer<typeof PlazaGroupSchema>;

export const ModelPlazaResponseSchema = z.object({
  generatedAtIso: z.string(),
  groups: z.array(PlazaGroupSchema),
});
export type ModelPlazaResponse = z.infer<typeof ModelPlazaResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Channel status page                                                                        */
/* ------------------------------------------------------------------------------------------ */

export const ChannelHealthSchema = z.enum(["operational", "degraded", "outage", "idle", "no_capacity"]);
export type ChannelHealth = z.infer<typeof ChannelHealthSchema>;

export const ChannelStatusBucketSchema = z.object({
  startIso: z.string(),
  requests: Count,
  errors: Count,
  /** null when the bucket saw no traffic. */
  successRate: z.number().min(0).max(1).nullable(),
  avgTtftMs: z.number().nonnegative(),
});
export type ChannelStatusBucket = z.infer<typeof ChannelStatusBucketSchema>;

export const ChannelStatusItemSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  platform: z.string(),
  health: ChannelHealthSchema,
  activeAccounts: Count,
  totalAccounts: Count,
  requests24h: Count,
  successRate24h: z.number().min(0).max(1).nullable(),
  avgTtftMs24h: z.number().nonnegative(),
  avgDurationMs24h: z.number().nonnegative(),
  lastRequestAtIso: z.string().nullable(),
  buckets: z.array(ChannelStatusBucketSchema),
});
export type ChannelStatusItem = z.infer<typeof ChannelStatusItemSchema>;

export const ChannelStatusResponseSchema = z.object({
  generatedAtIso: z.string(),
  bucketMinutes: z.number().int().positive(),
  overall: ChannelHealthSchema,
  channels: z.array(ChannelStatusItemSchema),
});
export type ChannelStatusResponse = z.infer<typeof ChannelStatusResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Ops monitoring                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const OpsRangeSchema = z.enum(["1h", "6h", "24h"]);
export type OpsRange = z.infer<typeof OpsRangeSchema>;

const Ms = z.number().nonnegative();

export const OpsOverviewSchema = z.object({
  generatedAtIso: z.string(),
  range: OpsRangeSchema,
  bucketMinutes: z.number().int().positive(),
  /** Always false: every row of the window is aggregated (exact totals and percentiles). */
  truncated: z.boolean(),
  totals: z.object({
    requests: Count,
    errors: Count,
    errorRate: z.number().min(0).max(1),
    rpm: z.number().nonnegative(),
    tpm: z.number().nonnegative(),
    inputTokens: Count,
    outputTokens: Count,
    costNanoUsd: NanoUsd,
    ttftP50: Ms,
    ttftP95: Ms,
    durationP50: Ms,
    durationP95: Ms,
    durationP99: Ms,
  }),
  series: z.array(
    z.object({
      startIso: z.string(),
      requests: Count,
      errors: Count,
      tokens: Count,
      ttftP50: Ms,
      durationP95: Ms,
    }),
  ),
  statusCodes: z.array(z.object({ code: z.number().int(), count: Count })),
  accounts: z.array(
    z.object({ accountId: z.string(), name: z.string(), platform: z.string(), requests: Count, errors: Count, errorRate: z.number(), ttftP50: Ms }),
  ),
  models: z.array(
    z.object({ model: z.string(), requests: Count, errors: Count, errorRate: z.number(), ttftP50: Ms, durationP95: Ms, tokens: Count }),
  ),
  recentErrors: z.array(
    z.object({
      createdAtIso: z.string(),
      requestId: z.string(),
      userEmail: z.string(),
      model: z.string(),
      accountName: z.string(),
      groupName: z.string(),
      statusCode: z.number().int(),
      durationMs: Count,
    }),
  ),
  fleet: z.object({ accounts: Count, active: Count, cooldown: Count, paused: Count, failedTests: Count }),
});
export type OpsOverview = z.infer<typeof OpsOverviewSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Model pricing overrides                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Price per 1M tokens in USD as typed by an admin. */
const PerMillionUsdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(?:\.\d{1,6})?$/, "Expected a price such as 3 or 0.25");

const PerUnitUsdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(?:\.\d{1,9})?$/, "Expected a USD amount such as 0.04 or 0.005");

const PriceMultiplierSchema = z.number().positive().max(100);

export const ReasoningEffortMultipliersSchema = z.object({
  low: PriceMultiplierSchema.optional(),
  medium: PriceMultiplierSchema.optional(),
  high: PriceMultiplierSchema.optional(),
  xhigh: PriceMultiplierSchema.optional(),
});
export type ReasoningEffortMultipliers = z.infer<typeof ReasoningEffortMultipliersSchema>;

export const ModelPricingRuleSchema = z.object({
  id: z.string(),
  /** Exact model id, or a prefix ending in "*" (e.g. "claude-opus-*"). */
  pattern: z.string(),
  /** Nano-USD per 1M tokens (integer strings). */
  inputNanoPerMTok: z.string().regex(/^\d+$/),
  outputNanoPerMTok: z.string().regex(/^\d+$/),
  cacheReadNanoPerMTok: z.string().regex(/^\d+$/),
  cacheWriteNanoPerMTok: z.string().regex(/^\d+$/),
  /** Optional flat per-request & multimodal unit fees in nano-USD. */
  perRequestNanoUsd: z.string().regex(/^\d+$/).optional(),
  perImageNanoUsd: z.string().regex(/^\d+$/).optional(),
  perVideoSecondNanoUsd: z.string().regex(/^\d+$/).optional(),
  /** Long-context tiered pricing (> threshold input tokens, e.g. 200000). */
  longContextThresholdTokens: z.number().int().nonnegative().optional(),
  longContextInputMultiplier: PriceMultiplierSchema.optional(),
  longContextOutputMultiplier: PriceMultiplierSchema.optional(),
  /** Service tier multipliers ("fast" / "priority" vs "flex"). */
  serviceTierFastMultiplier: PriceMultiplierSchema.optional(),
  serviceTierFlexMultiplier: PriceMultiplierSchema.optional(),
  /** Optional per-reasoning-effort multipliers. */
  reasoningEffortMultipliers: ReasoningEffortMultipliersSchema.optional(),
  enabled: z.boolean(),
  notes: z.string(),
  updatedAtIso: z.string(),
});
export type ModelPricingRule = z.infer<typeof ModelPricingRuleSchema>;

export const UpsertModelPricingRuleSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:/@-]+\*?$/, "Model id, optionally ending with * for a prefix"),
  inputPerMTokUsd: PerMillionUsdSchema,
  outputPerMTokUsd: PerMillionUsdSchema,
  /** Defaults: cache read 10% and cache write 125% of the input price. */
  cacheReadPerMTokUsd: PerMillionUsdSchema.optional(),
  cacheWritePerMTokUsd: PerMillionUsdSchema.optional(),
  perRequestUsd: PerUnitUsdSchema.optional(),
  perImageUsd: PerUnitUsdSchema.optional(),
  perVideoSecondUsd: PerUnitUsdSchema.optional(),
  longContextThresholdTokens: z.number().int().min(0).max(10_000_000).optional(),
  longContextInputMultiplier: PriceMultiplierSchema.optional(),
  longContextOutputMultiplier: PriceMultiplierSchema.optional(),
  serviceTierFastMultiplier: PriceMultiplierSchema.optional(),
  serviceTierFlexMultiplier: PriceMultiplierSchema.optional(),
  reasoningEffortMultipliers: ReasoningEffortMultipliersSchema.optional(),
  enabled: z.boolean().default(true),
  notes: z.string().trim().max(200).default(""),
});
export type UpsertModelPricingRule = z.infer<typeof UpsertModelPricingRuleSchema>;

/** Most specific enabled rule: exact match first, then the longest prefix. */
export function matchPricingRule(rules: readonly ModelPricingRule[], model: string): ModelPricingRule | null {
  let best: ModelPricingRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.pattern === model) return rule;
    if (rule.pattern.endsWith("*") && model.startsWith(rule.pattern.slice(0, -1))) {
      if (!best || rule.pattern.length > best.pattern.length) best = rule;
    }
  }
  return best;
}
