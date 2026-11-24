import { z } from "zod";
import { NanoUsdStringSchema } from "./commerce.ts";

export const UsageRollupGranularitySchema = z.enum(["hourly", "daily"]);
export type UsageRollupGranularity = z.infer<typeof UsageRollupGranularitySchema>;

export const UsageRollupStatusSchema = z.object({
  rollupEnabled: z.boolean(),
  usageRetentionDays: z.number().int().min(0).max(3650),
  lastHourlyAtIso: z.string().nullable(),
  lastDailyAtIso: z.string().nullable(),
  lastCleanupAtIso: z.string().nullable(),
  lastCleanupDeleted: z.number().int().nonnegative(),
  hourlyRows: z.number().int().nonnegative(),
  dailyRows: z.number().int().nonnegative(),
  oldestLogIso: z.string().nullable(),
});
export type UsageRollupStatus = z.infer<typeof UsageRollupStatusSchema>;

export const UpdateUsageRollupConfigRequestSchema = z.object({
  rollupEnabled: z.boolean().optional(),
  usageRetentionDays: z
    .number()
    .int()
    .refine((v) => v === 0 || (v >= 7 && v <= 3650), "Must be 0 (keep forever) or 7..3650 days")
    .optional(),
});
export type UpdateUsageRollupConfigRequest = z.infer<typeof UpdateUsageRollupConfigRequestSchema>;

export const UsageRollupBackfillRequestSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
  granularity: z.enum(["hourly", "daily", "both"]).default("both"),
});
export type UsageRollupBackfillRequest = z.infer<typeof UsageRollupBackfillRequestSchema>;

export const UsageRollupBackfillResponseSchema = z.object({
  hourlyUpserted: z.number().int().nonnegative(),
  dailyUpserted: z.number().int().nonnegative(),
  sinceIso: z.string(),
  untilIso: z.string(),
});
export type UsageRollupBackfillResponse = z.infer<typeof UsageRollupBackfillResponseSchema>;

export const UsageRollupCleanupRequestSchema = z.object({
  dryRun: z.boolean().default(false),
  retentionDays: z.number().int().min(7).max(3650).optional(),
});
export type UsageRollupCleanupRequest = z.infer<typeof UsageRollupCleanupRequestSchema>;

export const UsageRollupCleanupResponseSchema = z.object({
  dryRun: z.boolean(),
  cutoffIso: z.string(),
  matchedOrDeleted: z.number().int().nonnegative(),
  rolledUpBeforeDelete: z.boolean(),
});
export type UsageRollupCleanupResponse = z.infer<typeof UsageRollupCleanupResponseSchema>;

export const UsageRollupSeriesQuerySchema = z.object({
  granularity: UsageRollupGranularitySchema.default("daily"),
  days: z.coerce.number().int().min(1).max(365).default(30),
  userId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1).optional(),
  publicModel: z.string().trim().min(1).optional(),
});
export type UsageRollupSeriesQuery = z.infer<typeof UsageRollupSeriesQuerySchema>;

export const UsageRollupSeriesPointSchema = z.object({
  bucketIso: z.string(),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costNanoUsd: NanoUsdStringSchema,
  avgDurationMs: z.number().nonnegative(),
  avgTtftMs: z.number().nonnegative(),
});
export type UsageRollupSeriesPoint = z.infer<typeof UsageRollupSeriesPointSchema>;

export const UsageRollupSeriesResponseSchema = z.object({
  granularity: UsageRollupGranularitySchema,
  sinceIso: z.string(),
  untilIso: z.string(),
  totals: z.object({
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costNanoUsd: NanoUsdStringSchema,
    avgDurationMs: z.number().nonnegative(),
    avgTtftMs: z.number().nonnegative(),
  }),
  points: z.array(UsageRollupSeriesPointSchema),
});
export type UsageRollupSeriesResponse = z.infer<typeof UsageRollupSeriesResponseSchema>;
