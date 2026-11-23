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
  statusCode: z.number().int().min(100).max(599),
});
export type TurnSettlementEvent = z.infer<typeof TurnSettlementEventSchema>;

export const UsageLogItemSchema = TurnSettlementEventSchema.omit({ settlementId: true, coreSettled: true }).extend({
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
