import { z } from "zod";

export const UserAttributeTypeSchema = z.enum(["text", "number", "select", "multiselect", "date", "url"]);
export type UserAttributeType = z.infer<typeof UserAttributeTypeSchema>;

export const UserAttributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, digits and underscores, starting with a letter");

export const UserAttributeOptionsSchema = z.array(z.string().trim().min(1).max(120)).max(64);

export const UserAttributeDefinitionSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  type: UserAttributeTypeSchema,
  options: z.array(z.string()),
  required: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type UserAttributeDefinition = z.infer<typeof UserAttributeDefinitionSchema>;

export const CreateUserAttributeRequestSchema = z
  .object({
    key: UserAttributeKeySchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).default(""),
    type: UserAttributeTypeSchema.default("text"),
    options: UserAttributeOptionsSchema.default([]),
    required: z.boolean().default(false),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(-9999).max(9999).default(0),
  })
  .superRefine((v, ctx) => {
    if ((v.type === "select" || v.type === "multiselect") && v.options.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Select attributes require at least one option" });
    }
  });
export type CreateUserAttributeRequest = z.infer<typeof CreateUserAttributeRequestSchema>;

export const UpdateUserAttributeRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(400).optional(),
  type: UserAttributeTypeSchema.optional(),
  options: UserAttributeOptionsSchema.optional(),
  required: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
});
export type UpdateUserAttributeRequest = z.infer<typeof UpdateUserAttributeRequestSchema>;

export const UserAttributeValueItemSchema = z.object({
  attributeId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  type: UserAttributeTypeSchema,
  options: z.array(z.string()),
  required: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  value: z.string(),
  updatedAtIso: z.string().nullable(),
});
export type UserAttributeValueItem = z.infer<typeof UserAttributeValueItemSchema>;

export const UpdateUserAttributeValuesRequestSchema = z.object({
  values: z.record(z.string().min(1).max(128), z.string().max(4000)),
});
export type UpdateUserAttributeValuesRequest = z.infer<typeof UpdateUserAttributeValuesRequestSchema>;

export const AdminApiKeyItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  expiresAtIso: z.string().nullable(),
  lastUsedAtIso: z.string().nullable(),
  revokedAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type AdminApiKeyItem = z.infer<typeof AdminApiKeyItemSchema>;

export const CreateAdminApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export type CreateAdminApiKeyRequest = z.infer<typeof CreateAdminApiKeyRequestSchema>;

export const CreateAdminApiKeyResponseSchema = z.object({
  item: AdminApiKeyItemSchema,
  token: z.string().min(1),
});
export type CreateAdminApiKeyResponse = z.infer<typeof CreateAdminApiKeyResponseSchema>;
