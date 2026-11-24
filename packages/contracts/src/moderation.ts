import { z } from "zod";

export const ModerationRuleKindSchema = z.enum(["keyword", "regex"]);
export type ModerationRuleKind = z.infer<typeof ModerationRuleKindSchema>;

export const ModerationActionSchema = z.enum(["block", "log_only", "strike"]);
export type ModerationAction = z.infer<typeof ModerationActionSchema>;

export const ModerationSourceSchema = z.enum(["local_rule", "external_api"]);
export type ModerationSource = z.infer<typeof ModerationSourceSchema>;

export const ModerationSettingsSchema = z.object({
  enabled: z.boolean(),
  externalEnabled: z.boolean(),
  externalEndpoint: z.string(),
  externalApiKeySet: z.boolean(),
  externalModel: z.string(),
  externalTimeoutMs: z.number().int().min(500).max(15000),
  externalFailOpen: z.boolean(),
  updatedAtIso: z.string(),
});
export type ModerationSettings = z.infer<typeof ModerationSettingsSchema>;

export const UpdateModerationSettingsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    externalEnabled: z.boolean().optional(),
    externalEndpoint: z.string().trim().max(500).optional(),
    /** Omitted preserves existing key; empty string clears it; non-empty replaces it. */
    externalApiKey: z.string().max(500).optional(),
    externalModel: z.string().trim().min(1).max(120).optional(),
    externalTimeoutMs: z.number().int().min(500).max(15000).optional(),
    externalFailOpen: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.externalEndpoint !== undefined && val.externalEndpoint !== "") {
      try {
        const u = new URL(val.externalEndpoint);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["externalEndpoint"],
            message: "External endpoint must use http:// or https://",
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["externalEndpoint"],
          message: "External endpoint must be a valid URL",
        });
      }
    }
  });
export type UpdateModerationSettingsRequest = z.infer<typeof UpdateModerationSettingsRequestSchema>;

export const ModerationRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  enabled: z.boolean(),
  kind: ModerationRuleKindSchema,
  pattern: z.string().min(1).max(500),
  caseSensitive: z.boolean(),
  action: ModerationActionSchema,
  scopePlatforms: z.array(z.string()),
  scopeGroupIds: z.array(z.string()),
  rejectMessage: z.string().min(1).max(300),
  priority: z.number().int().min(1).max(10000),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type ModerationRule = z.infer<typeof ModerationRuleSchema>;

export const UpsertModerationRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    kind: ModerationRuleKindSchema,
    pattern: z.string().trim().min(1).max(500),
    caseSensitive: z.boolean().default(false),
    action: ModerationActionSchema.default("block"),
    scopePlatforms: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
    scopeGroupIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    rejectMessage: z.string().trim().min(1).max(300).default("Request blocked by content moderation policy"),
    priority: z.number().int().min(1).max(10000).default(100),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "regex") {
      try {
        new RegExp(val.pattern, val.caseSensitive ? "" : "i");
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pattern"],
          message: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  });
export type UpsertModerationRuleRequest = z.infer<typeof UpsertModerationRuleRequestSchema>;

export const ModerationEventSchema = z.object({
  id: z.string().min(1),
  requestId: z.string(),
  userId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  groupId: z.string().nullable(),
  platform: z.string(),
  publicModel: z.string(),
  ruleId: z.string().nullable(),
  ruleName: z.string(),
  source: ModerationSourceSchema,
  action: ModerationActionSchema,
  matchedExcerpt: z.string(),
  createdAtIso: z.string(),
});
export type ModerationEvent = z.infer<typeof ModerationEventSchema>;

export const RecordModerationEventInputSchema = z.object({
  requestId: z.string().max(128).default(""),
  userId: z.string().max(128).nullable().optional(),
  apiKeyId: z.string().max(128).nullable().optional(),
  groupId: z.string().max(128).nullable().optional(),
  platform: z.string().max(64).default(""),
  publicModel: z.string().max(160).default(""),
  ruleId: z.string().max(128).nullable().optional(),
  ruleName: z.string().max(128).default(""),
  source: ModerationSourceSchema,
  action: ModerationActionSchema,
  matchedExcerpt: z.string().max(512).default(""),
});
export type RecordModerationEventInput = z.infer<typeof RecordModerationEventInputSchema>;

export const ModerationEventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: ModerationActionSchema.optional(),
  source: ModerationSourceSchema.optional(),
});
export type ModerationEventQuery = z.infer<typeof ModerationEventQuerySchema>;

export const ModerationTestRequestSchema = z.object({
  text: z.string().min(1).max(16_384),
  platform: z.string().trim().max(64).optional(),
  groupId: z.string().trim().max(64).optional(),
});
export type ModerationTestRequest = z.infer<typeof ModerationTestRequestSchema>;

export const ModerationTestResponseSchema = z.object({
  matched: z.boolean(),
  action: ModerationActionSchema.nullable(),
  ruleId: z.string().nullable(),
  ruleName: z.string().nullable(),
  rejectMessage: z.string().nullable(),
  matchedExcerpt: z.string().nullable(),
});
export type ModerationTestResponse = z.infer<typeof ModerationTestResponseSchema>;

export const AdminRiskUnbanRequestSchema = z.object({
  subjectKind: z.enum(["device", "session", "api_key", "ip"]),
  subjectHash: z.string().min(1).max(256),
});
export type AdminRiskUnbanRequest = z.infer<typeof AdminRiskUnbanRequestSchema>;

export const DataPlaneSyncModerationSchema = z.object({
  enabled: z.boolean(),
  externalEnabled: z.boolean(),
  externalEndpoint: z.string(),
  externalApiKeyEncHex: z.string().default(""),
  externalModel: z.string(),
  externalTimeoutMs: z.number().int(),
  externalFailOpen: z.boolean(),
  rules: z.array(ModerationRuleSchema),
});
export type DataPlaneSyncModeration = z.infer<typeof DataPlaneSyncModerationSchema>;
