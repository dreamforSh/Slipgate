import { z } from "zod";
import { ExecutionModeSchema, GroupPlatformSchema, GroupSubscriptionTypeSchema, ProviderSchema } from "./pool.ts";

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

export const DataPlaneSyncSnapshotSchema = z.object({
  revisionUnixMs: z.number().int().nonnegative(),
  groups: z.array(DataPlaneSyncGroupSchema),
  routes: z.array(StoredCompositeRouteSchema),
  accounts: z.array(DataPlaneSyncAccountSchema),
  apiKeys: z.array(DataPlaneSyncApiKeySchema),
  wallets: z.array(DataPlaneSyncWalletSchema),
});
export type DataPlaneSyncSnapshot = z.infer<typeof DataPlaneSyncSnapshotSchema>;

export const TurnSettlementEventSchema = z.object({
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

export const UsageLogItemSchema = TurnSettlementEventSchema.extend({
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
