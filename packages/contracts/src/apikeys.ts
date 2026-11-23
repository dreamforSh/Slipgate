import { z } from "zod";

/** USD decimal typed by a person for a key limit; "0" = unlimited. */
const KeyLimitUsdSchema = z
  .string()
  .trim()
  .regex(/^\$?\d{1,12}(?:\.\d{1,9})?$/, "Expected a USD amount such as 10 or 2.50");

const IpEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, "Expected an IP address or CIDR");

/** Why a key is currently refusing traffic because of its own spend limits. */
export const ApiKeyLimitStateSchema = z.enum(["ok", "quota_exhausted", "window_exhausted"]);
export type ApiKeyLimitState = z.infer<typeof ApiKeyLimitStateSchema>;

export const ApiKeyItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  userId: z.string().min(1),
  groupId: z.string().min(1),
  groupName: z.string(),
  keyPrefix: z.string().min(1),
  rpmLimit: z.number().int().positive(),
  concurrencyLimit: z.number().int().positive(),
  ipAllowlist: z.array(z.string()),
  /** Blocked client IPs/CIDRs (wins over the allowlist). */
  ipDenylist: z.array(z.string()).default([]),
  enabled: z.boolean(),
  expiresAtIso: z.string().nullable(),
  createdAtIso: z.string(),
  /** Lifetime spend cap, nano-USD ("0" = unlimited), and spend since the last reset. */
  quotaNanoUsd: z.string().regex(/^\d+$/).default("0"),
  spentNanoUsd: z.string().regex(/^\d+$/).default("0"),
  /** Rolling spend caps ("0" = unlimited) and current spend in each window. */
  limit5hNanoUsd: z.string().regex(/^\d+$/).default("0"),
  limit1dNanoUsd: z.string().regex(/^\d+$/).default("0"),
  limit7dNanoUsd: z.string().regex(/^\d+$/).default("0"),
  usage5hNanoUsd: z.string().regex(/^\d+$/).default("0"),
  usage1dNanoUsd: z.string().regex(/^\d+$/).default("0"),
  usage7dNanoUsd: z.string().regex(/^\d+$/).default("0"),
  lastUsedAtIso: z.string().nullable().default(null),
  limitState: ApiKeyLimitStateSchema.default("ok"),
});
export type ApiKeyItem = z.infer<typeof ApiKeyItemSchema>;

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  groupId: z.string().min(1),
  rpmLimit: z.number().int().min(1).max(100000).default(60),
  concurrencyLimit: z.number().int().min(1).max(1000).default(5),
  ipAllowlist: z.array(IpEntrySchema).max(200).default([]),
  ipDenylist: z.array(IpEntrySchema).max(200).default([]),
  expiresAtIso: z.string().nullable().default(null),
  quotaUsd: KeyLimitUsdSchema.optional(),
  limit5hUsd: KeyLimitUsdSchema.optional(),
  limit1dUsd: KeyLimitUsdSchema.optional(),
  limit7dUsd: KeyLimitUsdSchema.optional(),
  /** Bring-your-own key text instead of a generated sk-sg- key. */
  customKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,128}$/, "16-128 letters, digits, - or _")
    .optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const UpdateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  groupId: z.string().min(1).optional(),
  rpmLimit: z.number().int().min(1).max(100000).optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
  ipAllowlist: z.array(IpEntrySchema).max(200).optional(),
  ipDenylist: z.array(IpEntrySchema).max(200).optional(),
  /** null clears the expiry. */
  expiresAtIso: z.string().datetime({ offset: true }).nullable().optional(),
  quotaUsd: KeyLimitUsdSchema.optional(),
  limit5hUsd: KeyLimitUsdSchema.optional(),
  limit1dUsd: KeyLimitUsdSchema.optional(),
  limit7dUsd: KeyLimitUsdSchema.optional(),
  /** Zero the lifetime spend counter. */
  resetQuota: z.boolean().optional(),
  /** Start the rolling windows over from now. */
  resetWindows: z.boolean().optional(),
});
export type UpdateApiKeyRequest = z.infer<typeof UpdateApiKeyRequestSchema>;

export const CreatedApiKeyResponseSchema = z.object({
  item: ApiKeyItemSchema,
  plaintextKey: z.string().min(1),
});
export type CreatedApiKeyResponse = z.infer<typeof CreatedApiKeyResponseSchema>;

export const BulkUpdateApiKeysRequestSchema = z.object({
  keyIds: z.array(z.string().min(1)).min(1).max(200),
  patch: UpdateApiKeyRequestSchema.omit({ name: true }),
});
export type BulkUpdateApiKeysRequest = z.infer<typeof BulkUpdateApiKeysRequestSchema>;
