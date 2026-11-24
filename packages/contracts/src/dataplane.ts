import { z } from "zod";
import {
  ExecutionModeSchema,
  GroupPlatformSchema,
  GroupSubscriptionTypeSchema,
  ProviderSchema,
  SubscriptionTierSchema,
} from "./pool.ts";
import { DataPlaneSyncUserLimitsSchema } from "./user_limits.ts";

export const CreateCompositeRouteRequestSchema = z.object({
  groupId: z.string().trim().min(1).default("grp_default"),
  publicModel: z.string().trim().min(1).max(128),
  matchType: z.enum(["exact", "prefix"]).default("exact"),
  targetPlatform: ProviderSchema,
  upstreamModel: z.string().trim().max(128).default(""),
  endpoint: z
    .enum([
      "any",
      "messages",
      "count_tokens",
      "responses",
      "chat_completions",
      "embeddings",
      "images",
      "videos",
      "gemini",
    ])
    .default("any"),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
});
export type CreateCompositeRouteRequest = z.infer<typeof CreateCompositeRouteRequestSchema>;

export const StoredCompositeRouteSchema = CreateCompositeRouteRequestSchema.extend({
  id: z.string().min(1),
  createdAtIso: z.string(),
});
export type StoredCompositeRoute = z.infer<typeof StoredCompositeRouteSchema>;

export const DataPlaneSyncGroupSchema = z.object({
  id: z.string().min(1),
  platform: GroupPlatformSchema,
  subscriptionType: GroupSubscriptionTypeSchema,
  rateMultiplier: z.number().positive(),
  modelAllowlist: z.array(z.string()),
  enabled: z.boolean(),
});
export type DataPlaneSyncGroup = z.infer<typeof DataPlaneSyncGroupSchema>;

export const DataPlaneSyncAccountSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().min(1),
  platform: ProviderSchema,
  executionMode: ExecutionModeSchema,
  authKind: z.string(),
  subscriptionTier: SubscriptionTierSchema.default("standard"),
  tierMultiplier: z.number().int().min(1).max(100).default(1),
  credentialsEncHex: z.string(),
  maxConcurrency: z.number().int().positive(),
  priority: z.number().int(),
  status: z.string(),
  window5hUsedBps: z.number().int().min(0).max(10000).default(0),
  window7dUsedBps: z.number().int().min(0).max(10000).default(0),
  window5hResetAtUnixMs: z.number().int().nonnegative().optional(),
  window7dResetAtUnixMs: z.number().int().nonnegative().optional(),
});
export type DataPlaneSyncAccount = z.infer<typeof DataPlaneSyncAccountSchema>;

export const DataPlaneSyncApiKeySchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  groupId: z.string().min(1),
  keyHashHex: z.string().regex(/^[0-9a-f]{64}$/),
  rpmLimit: z.number().int().positive(),
  concurrencyLimit: z.number().int().positive(),
  ipAllowlist: z.array(z.string()).default([]),
  ipDenylist: z.array(z.string()).default([]),
  enabled: z.boolean(),
  expiresAtIso: z.string().nullable().default(null),
});
export type DataPlaneSyncApiKey = z.infer<typeof DataPlaneSyncApiKeySchema>;

export const DataPlaneSyncWalletSchema = z.object({
  userId: z.string().min(1),
  balanceNanoUsd: z.string().regex(/^-?\d+$/),
  heldNanoUsd: z.string().regex(/^\d+$/),
});
export type DataPlaneSyncWallet = z.infer<typeof DataPlaneSyncWalletSchema>;

/**
 * An enabled admin price rule as the data plane applies it (nano-USD per 1M tokens, before the
 * group multiplier). Same matching as matchPricingRule: exact model id first, then the longest
 * "prefix*" pattern; the public model is tried before the upstream model.
 */
export const DataPlaneSyncPriceRuleSchema = z.object({
  pattern: z.string().min(1),
  inputNanoPerMTok: z.string().regex(/^\d+$/),
  outputNanoPerMTok: z.string().regex(/^\d+$/),
  cacheReadNanoPerMTok: z.string().regex(/^\d+$/),
  cacheWriteNanoPerMTok: z.string().regex(/^\d+$/),
  perRequestNanoUsd: z.string().regex(/^\d+$/).optional(),
  perImageNanoUsd: z.string().regex(/^\d+$/).optional(),
  perVideoSecondNanoUsd: z.string().regex(/^\d+$/).optional(),
  longContextThresholdTokens: z.number().int().nonnegative().optional(),
  longContextInputMultiplierMicros: z.number().int().positive().optional(),
  longContextOutputMultiplierMicros: z.number().int().positive().optional(),
  serviceTierFastMultiplierMicros: z.number().int().positive().optional(),
  serviceTierFlexMultiplierMicros: z.number().int().positive().optional(),
  reasoningEffortLowMultiplierMicros: z.number().int().positive().optional(),
  reasoningEffortMediumMultiplierMicros: z.number().int().positive().optional(),
  reasoningEffortHighMultiplierMicros: z.number().int().positive().optional(),
  reasoningEffortXhighMultiplierMicros: z.number().int().positive().optional(),
});
export type DataPlaneSyncPriceRule = z.infer<typeof DataPlaneSyncPriceRuleSchema>;

export const DataPlaneSyncRiskBanSchema = z.object({
  subjectKind: z.enum(["device", "session", "api_key", "ip"]),
  subjectHash: z.string().min(1),
  strikeLevel: z.number().int().min(1).max(3),
  bannedUntilUnixMs: z.number().int(),
});
export type DataPlaneSyncRiskBan = z.infer<typeof DataPlaneSyncRiskBanSchema>;

export const DataPlaneSyncSnapshotSchema = z.object({
  revisionUnixMs: z.number().int().nonnegative(),
  groups: z.array(DataPlaneSyncGroupSchema),
  routes: z.array(StoredCompositeRouteSchema),
  accounts: z.array(DataPlaneSyncAccountSchema),
  apiKeys: z.array(DataPlaneSyncApiKeySchema),
  wallets: z.array(DataPlaneSyncWalletSchema),
  /** Lets slipgate-core hold and settle at the same prices the BFF bills (empty = built-in rates). */
  priceRules: z.array(DataPlaneSyncPriceRuleSchema).optional(),
  /** Active risk bans restored into slipgate-core across restarts. */
  riskBans: z.array(DataPlaneSyncRiskBanSchema).optional(),
  /** Per-user / per-group RPM and concurrency caps slipgate-net enforces at the edge (user_limits.ts). */
  userLimits: DataPlaneSyncUserLimitsSchema.optional(),
  /** SWR-discovered upstream model IDs per provider from active accounts. */
  discoveredModels: z.record(z.string(), z.array(z.string())).optional(),
});
export type DataPlaneSyncSnapshot = z.infer<typeof DataPlaneSyncSnapshotSchema>;

/** Server-minted settlement ids: never a client-supplied value such as X-Request-Id. */
export const SettlementIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const TurnSettlementEventSchema = z.object({
  /**
   * Billing idempotency key minted by slipgate-net once per settled turn and reused on every
   * delivery retry. When absent (older edge builds) the BFF mints one, so the turn is charged.
   */
  settlementId: SettlementIdSchema.optional(),
  /**
   * false when slipgate-core could not settle the hold (IPC failure, or the hold was lost when the
   * core restarted): costNanoUsd is then "0" and the BFF prices the reported tokens itself.
   */
  coreSettled: z.boolean().optional(),
  /** Caller's X-Request-Id (or an edge-generated one): correlation and display only, never billing. */
  requestId: z.string().min(1),
  userId: z.string().min(1),
  apiKeyId: z.string().min(1),
  accountId: z.string().min(1),
  groupId: z.string().min(1),
  platform: ProviderSchema,
  publicModel: z.string().min(1),
  upstreamModel: z.string().min(1),
  ingressCodec: z.string().min(1),
  egressCodec: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  costNanoUsd: z.string().regex(/^\d+$/),
  ttftMs: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  window5hUsedBps: z.number().int().min(0).max(10000).default(0),
  window7dUsedBps: z.number().int().min(0).max(10000).default(0),
  window5hResetAtUnixMs: z.number().int().nonnegative().optional(),
  window7dResetAtUnixMs: z.number().int().nonnegative().optional(),
  serviceTier: z.string().max(32).optional(),
  reasoningEffort: z.string().max(32).optional(),
  imageCount: z.number().int().nonnegative().optional(),
  videoSeconds: z.number().nonnegative().optional(),
  statusCode: z.number().int().min(100).max(599),
  /**
   * Rate multiplier (x1e6) slipgate-core priced costNanoUsd at: the user's custom group rate when
   * it had synced, else the group's. Absent: the core's cost already carries the user's rate.
   */
  coreRateMultiplierMicros: z.number().int().positive().optional(),
});
export type TurnSettlementEvent = z.infer<typeof TurnSettlementEventSchema>;

const SETTLEMENT_DIMENSION_MAX = 32;

/**
 * Settlement reports are turns that already ran and must be billed: a malformed optional pricing
 * dimension or an out-of-range metric is dropped or clamped here rather than failing
 * TurnSettlementEventSchema, because a rejected settlement is a turn nobody pays for.
 */
export function coerceTurnSettlementInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const ev: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ["serviceTier", "reasoningEffort"]) {
    const v = ev[key];
    if (v !== undefined && (typeof v !== "string" || v.length > SETTLEMENT_DIMENSION_MAX)) delete ev[key];
  }
  for (const key of ["window5hUsedBps", "window7dUsedBps"]) {
    const v = ev[key];
    if (typeof v === "number" && Number.isFinite(v)) ev[key] = Math.min(10_000, Math.max(0, Math.trunc(v)));
  }
  const status = ev.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && (status < 100 || status > 599)) ev.statusCode = 502;
  return ev;
}

export const UsageLogItemSchema = TurnSettlementEventSchema.omit({
  settlementId: true,
  coreSettled: true,
  coreRateMultiplierMicros: true,
}).extend({
  id: z.string().min(1),
  formattedCostUsd: z.string(),
  createdAtIso: z.string(),
});
export type UsageLogItem = z.infer<typeof UsageLogItemSchema>;

export const RecordRiskBanInputSchema = z.object({
  subjectKind: z.enum(["device", "session", "api_key", "ip"]),
  subjectHash: z.string().min(1),
  strikeLevel: z.number().int().min(1).max(3),
  banDuration: z.enum(["10m", "24h", "permanent"]),
  reason: z.string().min(1),
  sourceRequestId: z.string().optional(),
  ordinaryUpstream400Count: z.number().int().nonnegative().default(0),
  downgradedCount: z.number().int().nonnegative().default(0),
});
export type RecordRiskBanInput = z.infer<typeof RecordRiskBanInputSchema>;
