import { z } from "zod";

export const ProviderSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "antigravity",
  "grok",
  "deepseek",
  "glm",
  "kimi",
  "minimax",
]);
export type Provider = z.infer<typeof ProviderSchema>;

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
  credentialSecret: z.string().trim().min(1),
  maxConcurrency: z.number().int().min(1).max(64).default(5),
  priority: z.number().int().min(0).max(10000).default(100),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const UpdateAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  groupId: z.string().min(1).optional(),
  executionMode: ExecutionModeSchema.optional(),
  credentialSecret: z.string().trim().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  status: AccountStatusSchema.optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;
