import { z } from "zod";
import { SubscriptionTierSchema } from "./pool.ts";

export const AccountOAuthProviderSchema = z.enum([
  "anthropic",
  "codex",
  "gemini",
  "antigravity",
  "qwen",
]);
export type AccountOAuthProvider = z.infer<typeof AccountOAuthProviderSchema>;

export const AccountOAuthMethodSchema = z.enum(["oauth", "setup_token"]);
export type AccountOAuthMethod = z.infer<typeof AccountOAuthMethodSchema>;

export const StartAccountOAuthRequestSchema = z.object({
  platform: AccountOAuthProviderSchema,
  addMethod: AccountOAuthMethodSchema.default("oauth"),
  redirectUri: z.string().trim().max(500).optional(),
  clientId: z.string().trim().max(256).optional(),
  clientSecret: z.string().trim().max(256).optional(),
  projectId: z.string().trim().max(128).optional(),
  accountId: z.string().trim().max(64).optional(),
});
export type StartAccountOAuthRequest = z.infer<typeof StartAccountOAuthRequestSchema>;

export const StartAccountOAuthResponseSchema = z.object({
  sessionId: z.string().min(1),
  authorizeUrl: z.string().url(),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
  instructions: z.string(),
});
export type StartAccountOAuthResponse = z.infer<typeof StartAccountOAuthResponseSchema>;

export const ExchangeAccountOAuthRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  codeInput: z.string().trim().min(1).max(8192),
  accountId: z.string().trim().max(64).optional(),
});
export type ExchangeAccountOAuthRequest = z.infer<typeof ExchangeAccountOAuthRequestSchema>;

export const ExchangeAccountOAuthResponseSchema = z.object({
  credentialSecret: z.string().min(1),
  email: z.string().default(""),
  subscriptionTier: SubscriptionTierSchema.default("standard"),
  projectId: z.string().optional(),
  accountIdHint: z.string().optional(),
  expiresAtIso: z.string().nullable().default(null),
});
export type ExchangeAccountOAuthResponse = z.infer<typeof ExchangeAccountOAuthResponseSchema>;

/** `POST /api/v1/admin/accounts/:id/oauth/refresh`: slipgate-net renewed (and persisted) the token now. */
export const RefreshAccountOAuthResponseSchema = z.object({
  ok: z.literal(true),
  subscriptionTier: z.string().default(""),
  /** New access-token expiry; 0 when the upstream did not say. */
  expiresAtUnixMs: z.number().int().nonnegative().default(0),
});
export type RefreshAccountOAuthResponse = z.infer<typeof RefreshAccountOAuthResponseSchema>;
