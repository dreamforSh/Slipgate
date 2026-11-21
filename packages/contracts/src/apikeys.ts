import { z } from "zod";

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
  enabled: z.boolean(),
  expiresAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type ApiKeyItem = z.infer<typeof ApiKeyItemSchema>;

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  groupId: z.string().min(1),
  rpmLimit: z.number().int().min(1).max(100000).default(60),
  concurrencyLimit: z.number().int().min(1).max(1000).default(5),
  ipAllowlist: z.array(z.string().trim().min(1)).default([]),
  expiresAtIso: z.string().nullable().default(null),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const UpdateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  rpmLimit: z.number().int().min(1).max(100000).optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateApiKeyRequest = z.infer<typeof UpdateApiKeyRequestSchema>;

export const CreatedApiKeyResponseSchema = z.object({
  item: ApiKeyItemSchema,
  plaintextKey: z.string().min(1),
});
export type CreatedApiKeyResponse = z.infer<typeof CreatedApiKeyResponseSchema>;
