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

export const GroupItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: GroupPlatformSchema,
  subscriptionType: GroupSubscriptionTypeSchema,
  rateMultiplier: z.number().positive(),
  modelAllowlist: z.array(z.string()),
  enabled: z.boolean(),
  accountCount: z.number().int().nonnegative(),
  createdAtIso: z.string(),
});
export type GroupItem = z.infer<typeof GroupItemSchema>;

export const CreateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: GroupPlatformSchema,
  subscriptionType: GroupSubscriptionTypeSchema.default("balance"),
  rateMultiplier: z.number().positive().max(100).default(1),
  modelAllowlist: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

export const UpdateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  rateMultiplier: z.number().positive().max(100).optional(),
  modelAllowlist: z.array(z.string().trim().min(1)).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequestSchema>;

export const AccountAuthKindSchema = z.enum(["oauth", "setup_token", "api_key", "vm_cli_seed"]);
export type AccountAuthKind = z.infer<typeof AccountAuthKindSchema>;

export const AccountStatusSchema = z.enum(["active", "paused", "cooldown", "expired"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const UpstreamAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
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
  status: AccountStatusSchema,
  window5hUsedBps: z.number().int().min(0).max(10000),
  window7dUsedBps: z.number().int().min(0).max(10000),
  createdAtIso: z.string(),
});
export type UpstreamAccount = z.infer<typeof UpstreamAccountSchema>;

export const CreateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  groupId: z.string().min(1),
  platform: ProviderSchema,
  executionMode: ExecutionModeSchema.default("stealth_http"),
  authKind: AccountAuthKindSchema.default("oauth"),
  subscriptionTier: SubscriptionTierSchema.default("standard"),
  credentialSecret: z.string().trim().min(1),
  maxConcurrency: z.number().int().min(1).max(64).default(5),
  priority: z.number().int().min(0).max(10000).default(100),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const UpdateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  groupId: z.string().min(1).optional(),
  executionMode: ExecutionModeSchema.optional(),
  subscriptionTier: SubscriptionTierSchema.optional(),
  credentialSecret: z.string().trim().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  status: AccountStatusSchema.optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;
