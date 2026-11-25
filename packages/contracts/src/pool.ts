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
  "opencode_go",
  "typesafe",
  "command_code",
  "cline",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const AccountModeSchema = z.enum(["payg", "coding", "go", "zen"]);
export type AccountMode = z.infer<typeof AccountModeSchema>;

export const NativeApiProtocolSchema = z.enum(["chat_completions", "anthropic", "responses"]);
export type NativeApiProtocol = z.infer<typeof NativeApiProtocolSchema>;

export const ApiProtocolSchema = z.enum(["adaptive", "chat_completions", "anthropic", "responses"]);
export type ApiProtocol = z.infer<typeof ApiProtocolSchema>;

export const ProtocolRuleSchema = z.object({
  pattern: z.string().min(1).max(128),
  protocol: NativeApiProtocolSchema,
  protocols: z.array(NativeApiProtocolSchema).optional(),
});
export type ProtocolRule = z.infer<typeof ProtocolRuleSchema>;

export interface PlatformModeSpec {
  mode: AccountMode;
  baseUrls: Partial<Record<NativeApiProtocol, string>>;
  protocolRules?: ProtocolRule[];
}

export interface PlatformMultiProtocolSpec {
  defaultMode: AccountMode;
  routing: "by_inbound" | "by_model";
  responsesPath?: string;
  modelCatalog?: boolean;
  defaultTestModel?: string;
  modes: PlatformModeSpec[];
}

/** Multi-protocol provider presets migrated from Wei-Shaw/sub2api (`provider_profile.go`). */
export const PLATFORM_MULTI_PROTOCOL_CATALOG: Partial<Record<Provider, PlatformMultiProtocolSpec>> = {
  kimi: {
    defaultMode: "payg",
    routing: "by_inbound",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://api.moonshot.cn/v1",
          responses: "https://api.moonshot.cn/v1",
          anthropic: "https://api.moonshot.cn/anthropic",
        },
      },
      {
        mode: "coding",
        baseUrls: {
          chat_completions: "https://api.kimi.com/coding/v1",
          responses: "https://api.kimi.com/coding/v1",
          anthropic: "https://api.kimi.com/coding",
        },
      },
    ],
  },
  glm: {
    defaultMode: "payg",
    routing: "by_inbound",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://open.bigmodel.cn/api/paas/v4",
          anthropic: "https://open.bigmodel.cn/api/anthropic",
        },
      },
      {
        mode: "coding",
        baseUrls: {
          chat_completions: "https://open.bigmodel.cn/api/coding/paas/v4",
          anthropic: "https://open.bigmodel.cn/api/anthropic",
        },
      },
    ],
  },
  deepseek: {
    defaultMode: "payg",
    routing: "by_inbound",
    responsesPath: "/responses",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://api.deepseek.com",
          responses: "https://api.deepseek.com",
          anthropic: "https://api.deepseek.com/anthropic",
        },
      },
    ],
  },
  minimax: {
    defaultMode: "payg",
    routing: "by_inbound",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://api.minimaxi.com/v1",
          responses: "https://api.minimaxi.com/v1",
          anthropic: "https://api.minimaxi.com/anthropic",
        },
      },
      {
        mode: "coding",
        baseUrls: {
          chat_completions: "https://api.minimaxi.com/v1",
          responses: "https://api.minimaxi.com/v1",
          anthropic: "https://api.minimaxi.com/anthropic",
        },
      },
    ],
  },
  opencode_go: {
    defaultMode: "go",
    routing: "by_model",
    defaultTestModel: "glm-5.3",
    modes: [
      {
        mode: "go",
        baseUrls: {
          chat_completions: "https://opencode.ai/zen/go/v1",
          responses: "https://opencode.ai/zen/go/v1",
          anthropic: "https://opencode.ai/zen/go",
        },
        protocolRules: [
          { pattern: "grok-*", protocol: "responses" },
          { pattern: "gpt-*", protocol: "responses" },
          { pattern: "muse-spark-*", protocol: "responses" },
          { pattern: "minimax-*", protocol: "anthropic" },
          { pattern: "qwen*", protocol: "anthropic" },
        ],
      },
      {
        mode: "zen",
        baseUrls: {
          chat_completions: "https://opencode.ai/zen/v1",
          responses: "https://opencode.ai/zen/v1",
          anthropic: "https://opencode.ai/zen",
        },
        protocolRules: [
          { pattern: "grok-*", protocol: "responses" },
          { pattern: "gpt-*", protocol: "responses" },
          { pattern: "muse-spark-*", protocol: "responses" },
          { pattern: "claude-*", protocol: "anthropic" },
          { pattern: "qwen3.8-max", protocol: "chat_completions" },
          { pattern: "qwen*", protocol: "anthropic" },
        ],
      },
    ],
  },
  command_code: {
    defaultMode: "payg",
    routing: "by_model",
    modelCatalog: true,
    defaultTestModel: "deepseek/deepseek-v4-flash",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://api.commandcode.ai/provider/v1",
          responses: "https://api.commandcode.ai/provider/v1",
          anthropic: "https://api.commandcode.ai/provider",
        },
        protocolRules: [
          { pattern: "claude-*", protocol: "anthropic" },
          { pattern: "gpt-*", protocol: "responses", protocols: ["responses", "chat_completions"] },
        ],
      },
    ],
  },
  cline: {
    defaultMode: "payg",
    routing: "by_inbound",
    defaultTestModel: "deepseek/deepseek-v4-flash",
    modes: [
      {
        mode: "payg",
        baseUrls: {
          chat_completions: "https://api.cline.bot/api/v1",
        },
      },
    ],
  },
};

/**
 * Plan tiers (sub2api naming per platform; ids are stable storage values):
 * - ChatGPT / Codex: free, go, plus, pro_5x = Pro 100, pro_10x = Pro 200, pro_25x = Pro 500, team
 *   (Business), enterprise, edu.
 * - Claude: pro, max = Max 5x, ultra (20x), team, enterprise.
 * - XPass (provider id `grok`): plus 1x, premium 4x, super 15x, ultra 50x (usage vs Plus).
 * - Gemini: free = Google One Free, pro = Google AI Pro, ultra = Google AI Ultra, standard = GCP
 *   Standard, enterprise = GCP Enterprise. Antigravity: free, pro, ultra.
 * - standard = no plan (API keys) or unknown.
 */
export const SubscriptionTierSchema = z.enum([
  "standard",
  "free",
  "go",
  "plus",
  "pro",
  "pro_5x",
  "pro_10x",
  "pro_25x",
  "max",
  "ultra",
  "premium",
  "super",
  "team",
  "enterprise",
  "edu",
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
      { tier: "free", label: "Free (1x)", multiplier: 1 },
      { tier: "go", label: "Go (1x)", multiplier: 1 },
      { tier: "plus", label: "Plus (1x)", multiplier: 1 },
      { tier: "pro_5x", label: "Pro 100 (5x)", multiplier: 5 },
      { tier: "pro_10x", label: "Pro 200 (10x)", multiplier: 10 },
      { tier: "pro_25x", label: "Pro 500 (25x)", multiplier: 25 },
      { tier: "team", label: "Business / Team (1x)", multiplier: 1 },
      { tier: "enterprise", label: "Enterprise (1x)", multiplier: 1 },
      { tier: "edu", label: "Edu (1x)", multiplier: 1 },
      { tier: "standard", label: "Standard / API Key (1x)", multiplier: 1 },
    ];
  }
  if (platform === "anthropic") {
    return [
      { tier: "pro", label: "Pro (1x)", multiplier: 1 },
      { tier: "max", label: "Max 5x (5x)", multiplier: 5 },
      { tier: "ultra", label: "Ultra (20x)", multiplier: 20 },
      { tier: "team", label: "Team (1x)", multiplier: 1 },
      { tier: "enterprise", label: "Enterprise (1x)", multiplier: 1 },
      { tier: "standard", label: "Standard / API Key (1x)", multiplier: 1 },
    ];
  }
  if (platform === "antigravity") {
    return [
      { tier: "free", label: "Free (1x)", multiplier: 1 },
      { tier: "pro", label: "Pro (5x)", multiplier: 5 },
      { tier: "ultra", label: "Ultra (20x)", multiplier: 20 },
      { tier: "standard", label: "Standard (1x)", multiplier: 1 },
    ];
  }
  if (platform === "grok") {
    // XPass plans: usage relative to Plus (shared pool).
    return [
      { tier: "plus", label: "Plus (1x)", multiplier: 1 },
      { tier: "premium", label: "Premium (4x)", multiplier: 4 },
      { tier: "super", label: "Super (15x)", multiplier: 15 },
      { tier: "ultra", label: "Ultra (50x)", multiplier: 50 },
      { tier: "standard", label: "Standard / API Key (1x)", multiplier: 1 },
    ];
  }
  if (platform === "gemini") {
    return [
      { tier: "free", label: "Google One Free (1x)", multiplier: 1 },
      { tier: "pro", label: "Google AI Pro (1x)", multiplier: 1 },
      { tier: "ultra", label: "Google AI Ultra (20x)", multiplier: 20 },
      { tier: "standard", label: "GCP Standard / API Key (1x)", multiplier: 1 },
      { tier: "enterprise", label: "GCP Enterprise (1x)", multiplier: 1 },
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
    case "premium":
      return 4;
    case "super":
      return 15;
    case "ultra":
      return platform === "grok" ? 50 : 20;
    case "pro_25x":
      return 25;
    case "pro":
      return platform === "antigravity" ? 5 : 1;
    // free / go / plus / team / enterprise / edu / standard
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

/**
 * Temporary-unschedulable rule: when an upstream answers with an error that matches, the data
 * plane puts the account into cooldown for `durationMinutes` and fails the request over.
 * `statusCode` 0 matches any HTTP error (>= 400); `keywords` (any of them, case-insensitive)
 * are searched in the error body, empty = the status alone decides.
 */
export const TempUnschedRuleSchema = z.object({
  statusCode: z.number().int().min(0).max(599).default(0),
  keywords: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  durationMinutes: z.number().int().min(1).max(10080),
  description: z.string().trim().max(100).default(""),
});
export type TempUnschedRule = z.infer<typeof TempUnschedRuleSchema>;

/** At most 10 rules per account; the first matching rule wins. */
export const TempUnschedRulesSchema = z
  .array(TempUnschedRuleSchema)
  .max(10)
  .refine((rules) => rules.every((r) => r.statusCode === 0 || r.statusCode >= 400), {
    message: "statusCode must be 0 (any error) or an HTTP error status (>= 400)",
  });

/** Cooldown reason the data plane records when a rule fires (`temp_unsched:<description or status>`). */
export const TEMP_UNSCHED_REASON_PREFIX = "temp_unsched:";

/* ---------------- Account spend quota (sub2api "quota limit") ---------------- */

/** USD amount an admin types for an account quota; "0" = no limit. */
export const AccountQuotaUsdSchema = z
  .string()
  .trim()
  .regex(/^\$?\d{1,12}(?:\.\d{1,9})?$/, "Expected a USD amount such as 50 or 12.5");

/** Rolling windows of the daily / weekly quota (measured back from now). */
export const ACCOUNT_QUOTA_DAY_MS = 24 * 3_600_000;
export const ACCOUNT_QUOTA_WEEK_MS = 7 * ACCOUNT_QUOTA_DAY_MS;

/** Which limit currently stops the account; `ok` = within every limit (or none set). */
export const AccountQuotaStateSchema = z.enum(["ok", "daily_exceeded", "weekly_exceeded", "total_exceeded"]);
export type AccountQuotaState = z.infer<typeof AccountQuotaStateSchema>;

const NanoDigitsSchema = z.string().regex(/^\d+$/);

/**
 * Spend caps on what the account served (the billed cost of its requests), nano-USD; "0" = no limit.
 * Daily / weekly are rolling 24 h / 7 d windows, total counts everything since `resetAtIso`. Usage
 * before `resetAtIso` ("reset quota") no longer counts in any window. Reaching any limit takes the
 * account out of scheduling until usage falls back under it (or the quota is reset / raised).
 */
export const AccountQuotaSchema = z.object({
  dailyLimitNanoUsd: NanoDigitsSchema,
  weeklyLimitNanoUsd: NanoDigitsSchema,
  totalLimitNanoUsd: NanoDigitsSchema,
  dailyUsedNanoUsd: NanoDigitsSchema,
  weeklyUsedNanoUsd: NanoDigitsSchema,
  totalUsedNanoUsd: NanoDigitsSchema,
  resetAtIso: z.string().nullable(),
  state: AccountQuotaStateSchema,
});
export type AccountQuota = z.infer<typeof AccountQuotaSchema>;

type QuotaLimits = Pick<AccountQuota, "dailyLimitNanoUsd" | "weeklyLimitNanoUsd" | "totalLimitNanoUsd">;

/** Whether any of the three limits is set. */
export function accountQuotaLimited(q: QuotaLimits): boolean {
  return q.dailyLimitNanoUsd !== "0" || q.weeklyLimitNanoUsd !== "0" || q.totalLimitNanoUsd !== "0";
}

/** The limit that blocks the account (total, then weekly, then daily), or `ok`. */
export function accountQuotaState(
  limits: QuotaLimits,
  used: { daily: bigint; weekly: bigint; total: bigint },
): AccountQuotaState {
  const over = (limit: string, spent: bigint) => limit !== "0" && spent >= BigInt(limit);
  if (over(limits.totalLimitNanoUsd, used.total)) return "total_exceeded";
  if (over(limits.weeklyLimitNanoUsd, used.weekly)) return "weekly_exceeded";
  if (over(limits.dailyLimitNanoUsd, used.daily)) return "daily_exceeded";
  return "ok";
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

/**
 * Result of the admin "set privacy" action on an OAuth account:
 * - ChatGPT / Codex: training_off (model training on the account's data switched off),
 *   training_set_failed, training_set_cf_blocked (chatgpt.com answered with a Cloudflare challenge).
 * - Antigravity: privacy_set (telemetry and marketing emails off, verified), privacy_set_failed.
 */
export const AccountPrivacyModeSchema = z.enum([
  "training_off",
  "training_set_failed",
  "training_set_cf_blocked",
  "privacy_set",
  "privacy_set_failed",
]);
export type AccountPrivacyMode = z.infer<typeof AccountPrivacyModeSchema>;

/** Privacy modes that mean the provider no longer uses the account's data. */
export function isPrivacyApplied(mode: AccountPrivacyMode | null | undefined): boolean {
  return mode === "training_off" || mode === "privacy_set";
}

/**
 * Whether "set privacy" applies: OAuth accounts of ChatGPT / Codex (training) and Antigravity
 * (telemetry), sent from the network service, so not VM-slot accounts.
 */
export function accountSupportsPrivacy(account: {
  platform: string;
  authKind: string;
  executionMode: string;
}): boolean {
  if (account.authKind !== "oauth" || account.executionMode === "vm_slot") return false;
  return account.platform === "codex" || account.platform === "openai" || account.platform === "antigravity";
}

export const UpstreamAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  notes: z.string(),
  /** Empty string = ungrouped (see `UNGROUPED_ACCOUNT_GROUP_ID`). */
  groupId: z.string(),
  /** Empty string when the account is ungrouped. */
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
  /** Error rules that put the account into a temporary cooldown (see TempUnschedRuleSchema). */
  tempUnschedRules: z.array(TempUnschedRuleSchema),
  /** Last "set privacy" outcome; `null` = never set. */
  privacyMode: AccountPrivacyModeSchema.nullable(),
  privacyCheckedAtIso: z.string().nullable(),
  /** Spend quota and current usage (see AccountQuotaSchema). */
  quota: AccountQuotaSchema,
  createdAtIso: z.string(),
});
export type UpstreamAccount = z.infer<typeof UpstreamAccountSchema>;

/**
 * `groupId` of an account that belongs to no group. Ungrouped accounts stay in the pool (they can
 * be tested, edited and later assigned) but no single-platform group schedules them; composite
 * groups, which draw on every account of a platform, still can.
 */
export const UNGROUPED_ACCOUNT_GROUP_ID = "";

export const CreateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(500).default(""),
  /** Optional: omitted or `""` creates an ungrouped account. */
  groupId: z.string().trim().max(128).default(UNGROUPED_ACCOUNT_GROUP_ID),
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
  tempUnschedRules: TempUnschedRulesSchema.default([]),
  /** Spend quota in USD; omitted or "0" = no limit. */
  quotaDailyLimitUsd: AccountQuotaUsdSchema.optional(),
  quotaWeeklyLimitUsd: AccountQuotaUsdSchema.optional(),
  quotaTotalLimitUsd: AccountQuotaUsdSchema.optional(),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

/**
 * Platform is fixed at creation time; omit `credentialSecret` to keep the stored credential.
 * `groupId: ""` moves the account out of its group.
 * Setting `status` to anything but `cooldown` clears the cooldown deadline unless
 * `cooldownUntilIso` is sent in the same patch.
 */
export const UpdateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(500).optional(),
  groupId: z.string().trim().max(128).optional(),
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
  /** Replaces the whole rule list; `[]` clears it. */
  tempUnschedRules: TempUnschedRulesSchema.optional(),
  /** Spend quota in USD; "0" removes that limit. Changing a limit keeps the usage counted so far. */
  quotaDailyLimitUsd: AccountQuotaUsdSchema.optional(),
  quotaWeeklyLimitUsd: AccountQuotaUsdSchema.optional(),
  quotaTotalLimitUsd: AccountQuotaUsdSchema.optional(),
  /** "Reset quota": usage up to now stops counting toward every limit. */
  resetQuota: z.literal(true).optional(),
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
  quotaDailyLimitUsd: true,
  quotaWeeklyLimitUsd: true,
  quotaTotalLimitUsd: true,
  resetQuota: true,
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

/**
 * `GET /api/v1/admin/accounts/:id/models`: models the account can use, asked from the provider over
 * the account's egress (`upstream`), or the built-in suggestions (`default`, with the reason).
 */
export const AccountModelsResponseSchema = z.object({
  models: z.array(z.string()),
  source: z.enum(["upstream", "default"]),
  message: z.string(),
  fetchedAtIso: z.string(),
});
export type AccountModelsResponse = z.infer<typeof AccountModelsResponseSchema>;

/** Per-account scheduled test (sub2api "定时测试"); runs whatever the account's status. */
export const AccountTestScheduleSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
  /** Empty = the platform's default test model. */
  model: z.string().trim().max(128).default(""),
  /** After a passing test, end the account's cooldown (temporary unschedulable state). */
  autoRecover: z.boolean().default(false),
});
export type AccountTestSchedule = z.infer<typeof AccountTestScheduleSchema>;

export const AccountTestScheduleItemSchema = AccountTestScheduleSchema.extend({
  accountId: z.string(),
  lastRunAtIso: z.string().nullable(),
  nextRunAtIso: z.string().nullable(),
});
export type AccountTestScheduleItem = z.infer<typeof AccountTestScheduleItemSchema>;

/** One impersonated client in the CLI fingerprint report (`GET /api/v1/admin/cli-fingerprint`). */
export const CliFingerprintToolSchema = z.object({
  key: z.string(),
  name: z.string(),
  effective: z.string(),
  builtin: z.string(),
  synced: z.string().default(""),
  latest: z.string().default(""),
  /** Where the effective version comes from: an env override, the hourly release sync, or the built-in pin. */
  source: z.enum(["env", "synced", "builtin"]),
  userAgent: z.string(),
  syncable: z.boolean(),
  error: z.string().default(""),
});
export type CliFingerprintTool = z.infer<typeof CliFingerprintToolSchema>;

export const CliFingerprintReportSchema = z.object({
  syncEnabled: z.boolean(),
  lastSyncAtUnixMs: z.number().int().nonnegative().default(0),
  tools: z.array(CliFingerprintToolSchema),
});
export type CliFingerprintReport = z.infer<typeof CliFingerprintReportSchema>;

/** Suggested test models per provider (first entry matches the data-plane default). */
export const ACCOUNT_TEST_MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-sonnet-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-haiku-4-5"],
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
  opencode_go: ["glm-5.3", "grok-4.7", "minimax-m3"],
  typesafe: ["jev-latest"],
  command_code: ["deepseek/deepseek-v4-flash", "claude-sonnet-4-6"],
  cline: ["deepseek/deepseek-v4-flash", "cline-pass/glm-5.3-flash"],
};
