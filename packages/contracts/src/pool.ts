import { z } from "zod";

export const ProviderSchema = z.enum([
  "anthropic",
  "openai",
  "codex",
  "gemini",
  "antigravity",
  "grok",
  "deepseek",
  "glm",
  "kimi",
  "minimax",
  "qwen",
  "bedrock",
  "vertex",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const SubscriptionTierSchema = z.enum([
  "standard",
  "plus",
  "pro",
  "pro_5x",
  "pro_10x",
  "pro_25x",
  "max",
  "ultra",
]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

export interface SubscriptionTierOption {
  tier: SubscriptionTier;
  label: string;
  multiplier: number;
}

export function allowedSubscriptionTiersForProvider(platform: Provider): SubscriptionTierOption[] {
  if (platform === "codex" || platform === "openai") {
    return [
      { tier: "plus", label: "Plus (1x)", multiplier: 1 },
      { tier: "pro_5x", label: "Pro 5x (5x)", multiplier: 5 },
      { tier: "pro_10x", label: "Pro 10x (10x)", multiplier: 10 },
      { tier: "pro_25x", label: "Pro 25x (25x)", multiplier: 25 },
      { tier: "standard", label: "Standard / API Key (1x)", multiplier: 1 },
    ];
  }
  if (platform === "anthropic") {
    return [
      { tier: "pro", label: "Pro (1x)", multiplier: 1 },
      { tier: "max", label: "Max (5x)", multiplier: 5 },
      { tier: "ultra", label: "Ultra (20x)", multiplier: 20 },
      { tier: "standard", label: "Standard / API Key (1x)", multiplier: 1 },
    ];
  }
  if (platform === "antigravity") {
    return [
      { tier: "pro", label: "Pro (5x)", multiplier: 5 },
      { tier: "ultra", label: "Ultra (20x)", multiplier: 20 },
      { tier: "standard", label: "Standard (1x)", multiplier: 1 },
    ];
  }
  return [
    { tier: "standard", label: "Standard (1x)", multiplier: 1 },
    { tier: "pro", label: "Pro (1x)", multiplier: 1 },
    { tier: "max", label: "Max (5x)", multiplier: 5 },
    { tier: "ultra", label: "Ultra (20x)", multiplier: 20 },
  ];
}

export function isSubscriptionTierAllowedForProvider(
  platform: Provider,
  tier: SubscriptionTier,
): boolean {
  return allowedSubscriptionTiersForProvider(platform).some((opt) => opt.tier === tier);
}

/**
 * Tier an account is stored and scheduled with. API keys bill per token and carry no plan, so
 * they are always `standard` (1x) whatever tier a request names.
 */
export function effectiveSubscriptionTier(authKind: AccountAuthKind, tier: SubscriptionTier): SubscriptionTier {
  return authKind === "api_key" ? "standard" : tier;
}

export function subscriptionTierMultiplier(platform: Provider, tier: SubscriptionTier): number {
  switch (tier) {
    case "pro_5x":
    case "max":
      return 5;
    case "pro_10x":
      return 10;
    case "ultra":
      return 20;
    case "pro_25x":
      return 25;
    case "pro":
      return platform === "antigravity" ? 5 : 1;
    case "plus":
    case "standard":
    default:
      return 1;
  }
}

export function recommendedMaxConcurrencyForTier(
  platform: Provider,
  tier: SubscriptionTier,
): number {
  const mult = subscriptionTierMultiplier(platform, tier);
  if (mult >= 25) return 32;
  if (mult >= 20) return 28;
  if (mult >= 10) return 20;
  if (mult >= 5) return 12;
  return 5;
}

export const ExecutionModeSchema = z.enum(["stealth_http", "vm_slot", "direct_api"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const GroupPlatformSchema = z.union([ProviderSchema, z.literal("composite")]);
export type GroupPlatform = z.infer<typeof GroupPlatformSchema>;

export const GroupSubscriptionTypeSchema = z.enum(["balance", "subscription"]);
export type GroupSubscriptionType = z.infer<typeof GroupSubscriptionTypeSchema>;

/** USD decimal typed by an admin for a subscription cap; "0" means unlimited. */
const GroupLimitUsdSchema = z
  .string()
  .trim()
  .regex(/^\$?\d{1,12}(?:\.\d{1,9})?$/, "Expected a USD amount such as 10 or 2.50");

export const GroupItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  platform: GroupPlatformSchema,
  subscriptionType: GroupSubscriptionTypeSchema,
  rateMultiplier: z.number().positive(),
  modelAllowlist: z.array(z.string()),
  /** Exclusive groups are hidden from regular users; only admins can bind API keys to them. */
  isExclusive: z.boolean(),
  sortOrder: z.number().int(),
  enabled: z.boolean(),
  accountCount: z.number().int().nonnegative(),
  activeAccountCount: z.number().int().nonnegative(),
  apiKeyCount: z.number().int().nonnegative(),
  /** Subscription-billed groups: rolling spend caps per subscriber, nano-USD ("0" = unlimited). */
  dailyLimitNanoUsd: z.string().regex(/^\d+$/).default("0"),
  weeklyLimitNanoUsd: z.string().regex(/^\d+$/).default("0"),
  monthlyLimitNanoUsd: z.string().regex(/^\d+$/).default("0"),
  /** Validity offered when a subscription is assigned without an explicit length. */
  defaultValidityDays: z.number().int().min(1).max(3650).default(30),
  /** Per-user caps inside this group, across the user's keys (0 = none; see user_limits.ts). */
  rpmLimit: z.number().int().min(0).default(0),
  concurrencyLimit: z.number().int().min(0).default(0),
  createdAtIso: z.string(),
});
export type GroupItem = z.infer<typeof GroupItemSchema>;

export const CreateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).default(""),
  platform: GroupPlatformSchema,
  subscriptionType: GroupSubscriptionTypeSchema.default("balance"),
  rateMultiplier: z.number().positive().max(100).default(1),
  modelAllowlist: z.array(z.string().trim().min(1)).default([]),
  isExclusive: z.boolean().default(false),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
  enabled: z.boolean().default(true),
  dailyLimitUsd: GroupLimitUsdSchema.default("0"),
  weeklyLimitUsd: GroupLimitUsdSchema.default("0"),
  monthlyLimitUsd: GroupLimitUsdSchema.default("0"),
  defaultValidityDays: z.number().int().min(1).max(3650).default(30),
  rpmLimit: z.number().int().min(0).max(1_000_000).default(0),
  concurrencyLimit: z.number().int().min(0).max(1_000_000).default(0),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

/** Platform is fixed at creation time (accounts and routes depend on it). */
export const UpdateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(500).optional(),
  subscriptionType: GroupSubscriptionTypeSchema.optional(),
  rateMultiplier: z.number().positive().max(100).optional(),
  modelAllowlist: z.array(z.string().trim().min(1)).optional(),
  isExclusive: z.boolean().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  enabled: z.boolean().optional(),
  dailyLimitUsd: GroupLimitUsdSchema.optional(),
  weeklyLimitUsd: GroupLimitUsdSchema.optional(),
  monthlyLimitUsd: GroupLimitUsdSchema.optional(),
  defaultValidityDays: z.number().int().min(1).max(3650).optional(),
  rpmLimit: z.number().int().min(0).max(1_000_000).optional(),
  concurrencyLimit: z.number().int().min(0).max(1_000_000).optional(),
});
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequestSchema>;

export const AccountAuthKindSchema = z.enum(["oauth", "setup_token", "api_key", "vm_cli_seed"]);
export type AccountAuthKind = z.infer<typeof AccountAuthKindSchema>;

export const AccountStatusSchema = z.enum(["active", "paused", "cooldown", "expired"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** Statuses an account may be created or imported with (cooldown/expired are runtime states). */
export const AccountInitialStatusSchema = z.enum(["active", "paused"]);
export type AccountInitialStatus = z.infer<typeof AccountInitialStatusSchema>;

/** ISO-8601 instant; offsets are accepted and normalized by `new Date(...)` on the server. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export interface AccountLifecycleFields {
  status: AccountStatus;
  expiresAtIso: string | null;
  autoPauseOnExpired: boolean;
  cooldownUntilIso: string | null;
}

/**
 * Scheduling status the data plane acts on: the stored status refined by the expiry and
 * cooldown deadlines, so a lapsed subscription stops and a finished cooldown resumes
 * without anyone editing the row.
 *
 * - `paused` / `expired` set by an admin always win.
 * - An elapsed `expiresAt` with auto-pause enabled reads as `expired`.
 * - A future `cooldownUntil` reads as `cooldown`; once it passes the account is `active` again.
 * - `cooldown` without a deadline stays in cooldown until an admin resumes it.
 */
export function effectiveAccountStatus(acc: AccountLifecycleFields, nowMs: number = Date.now()): AccountStatus {
  if (acc.status === "paused" || acc.status === "expired") return acc.status;
  if (acc.autoPauseOnExpired && acc.expiresAtIso) {
    const expiresAt = Date.parse(acc.expiresAtIso);
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return "expired";
  }
  if (acc.cooldownUntilIso) {
    const until = Date.parse(acc.cooldownUntilIso);
    if (Number.isFinite(until) && until > nowMs) return "cooldown";
    return "active";
  }
  return acc.status === "cooldown" ? "cooldown" : "active";
}

/** Outcome of the most recent admin connectivity test for an account. */
export const AccountTestResultSchema = z.object({
  ok: z.boolean(),
  atIso: z.string(),
  model: z.string(),
  durationMs: z.number().int().nonnegative(),
  message: z.string(),
});
export type AccountTestResult = z.infer<typeof AccountTestResultSchema>;

export const UpstreamAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  notes: z.string(),
  groupId: z.string().min(1),
  groupName: z.string(),
  platform: ProviderSchema,
  executionMode: ExecutionModeSchema,
  authKind: AccountAuthKindSchema,
  subscriptionTier: SubscriptionTierSchema,
  tierMultiplier: z.number().int().min(1).max(100),
  credentialPreview: z.string(),
  maxConcurrency: z.number().int().min(1).max(64),
  priority: z.number().int(),
  /** Stored (admin-set) status. */
  status: AccountStatusSchema,
  /** What the scheduler acts on; see `effectiveAccountStatus`. */
  effectiveStatus: AccountStatusSchema,
  /** Subscription / key expiry; `null` = never expires. */
  expiresAtIso: z.string().nullable(),
  /** Stop scheduling once `expiresAtIso` has passed. */
  autoPauseOnExpired: z.boolean(),
  /** Temporary unschedulable deadline; the account resumes on its own afterwards. */
  cooldownUntilIso: z.string().nullable(),
  cooldownReason: z.string(),
  window5hUsedBps: z.number().int().min(0).max(10000),
  window7dUsedBps: z.number().int().min(0).max(10000),
  lastTest: AccountTestResultSchema.nullable(),
  /** Time of the most recent settled request routed to this account. */
  lastUsedAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type UpstreamAccount = z.infer<typeof UpstreamAccountSchema>;

export const CreateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(500).default(""),
  groupId: z.string().min(1),
  platform: ProviderSchema,
  executionMode: ExecutionModeSchema.default("stealth_http"),
  authKind: AccountAuthKindSchema.default("oauth"),
  subscriptionTier: SubscriptionTierSchema.default("standard"),
  credentialSecret: z.string().trim().min(1),
  maxConcurrency: z.number().int().min(1).max(64).default(5),
  priority: z.number().int().min(0).max(10000).default(100),
  status: AccountInitialStatusSchema.default("active"),
  expiresAtIso: IsoDateTimeSchema.nullable().default(null),
  autoPauseOnExpired: z.boolean().default(true),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

/**
 * Platform is fixed at creation time; omit `credentialSecret` to keep the stored credential.
 * Setting `status` to anything but `cooldown` clears the cooldown deadline unless
 * `cooldownUntilIso` is sent in the same patch.
 */
export const UpdateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(500).optional(),
  groupId: z.string().min(1).optional(),
  executionMode: ExecutionModeSchema.optional(),
  authKind: AccountAuthKindSchema.optional(),
  subscriptionTier: SubscriptionTierSchema.optional(),
  credentialSecret: z.string().trim().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  status: AccountStatusSchema.optional(),
  expiresAtIso: IsoDateTimeSchema.nullable().optional(),
  autoPauseOnExpired: z.boolean().optional(),
  cooldownUntilIso: IsoDateTimeSchema.nullable().optional(),
  cooldownReason: z.string().trim().max(200).optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;

const AccountIdListSchema = z.array(z.string().min(1)).min(1).max(500);

/** Fields the bulk editor may change; credentials, names and notes stay per-account. */
export const AccountBulkPatchSchema = UpdateAccountRequestSchema.pick({
  groupId: true,
  status: true,
  executionMode: true,
  subscriptionTier: true,
  maxConcurrency: true,
  priority: true,
  expiresAtIso: true,
  autoPauseOnExpired: true,
  cooldownUntilIso: true,
  cooldownReason: true,
});
export type AccountBulkPatch = z.infer<typeof AccountBulkPatchSchema>;

/** Apply the same non-credential changes to many accounts at once. */
export const AccountBulkUpdateRequestSchema = z.object({
  accountIds: AccountIdListSchema,
  patch: AccountBulkPatchSchema.refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "patch must change at least one field",
  }),
});
export type AccountBulkUpdateRequest = z.infer<typeof AccountBulkUpdateRequestSchema>;

export const AccountBatchDeleteRequestSchema = z.object({
  accountIds: AccountIdListSchema,
});
export type AccountBatchDeleteRequest = z.infer<typeof AccountBatchDeleteRequestSchema>;

export const AccountBulkResultSchema = z.object({
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), message: z.string().optional() })),
});
export type AccountBulkResult = z.infer<typeof AccountBulkResultSchema>;

export const AccountTestRequestSchema = z.object({
  model: z.string().trim().max(128).optional(),
  prompt: z.string().trim().max(2000).optional(),
});
export type AccountTestRequest = z.infer<typeof AccountTestRequestSchema>;

/**
 * One SSE `data:` payload of `POST /api/v1/admin/accounts/:id/test`.
 * Sequence: start, then delta events, then done; or a single error when the test cannot be dispatched.
 */
export const AccountTestEventSchema = z.object({
  type: z.enum(["start", "delta", "done", "error"]),
  model: z.string().optional(),
  text: z.string().optional(),
  success: z.boolean().optional(),
  status: z.number().int().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  ttftMs: z.number().optional(),
  durationMs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
export type AccountTestEvent = z.infer<typeof AccountTestEventSchema>;

/** Suggested test models per provider (first entry matches the data-plane default). */
export const ACCOUNT_TEST_MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
  codex: ["gpt-5-codex", "gpt-5"],
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
  antigravity: ["gemini-2.5-flash", "claude-sonnet-4-5"],
  grok: ["grok-3-mini", "grok-4"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  glm: ["glm-4.5-air", "glm-4.6"],
  kimi: ["kimi-k2-0905-preview"],
  minimax: ["MiniMax-M2"],
  qwen: ["qwen-plus", "qwen-max"],
  bedrock: ["anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-haiku-4-5-20251001-v1:0"],
  vertex: ["gemini-2.5-flash", "gemini-2.5-pro", "claude-sonnet-4-5@20250929"],
};
