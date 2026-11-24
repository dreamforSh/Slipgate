import { z } from "zod";
import { GroupPlatformSchema } from "./pool.ts";

/**
 * Per-user per-platform spend quotas and per-window reset contracts (Lane U2).
 *
 * Caps are non-negative nano-USD integer strings where `"0"` means unlimited. When a user exceeds
 * any active daily / weekly / monthly cap on a platform, `blockedPlatforms` carries the pair into
 * the DataPlane snapshot so slipgate-net rejects new turns on that platform with HTTP 429 before
 * hitting upstream.
 */

const NonNegativeNanoUsdSchema = z.string().regex(/^\d+$/, "Expected a non-negative nano-USD integer string");

export const QuotaWindowKindSchema = z.enum(["daily", "weekly", "monthly"]);
export type QuotaWindowKind = z.infer<typeof QuotaWindowKindSchema>;

export const QuotaResetWindowSchema = z.enum(["all", "daily", "weekly", "monthly"]);
export type QuotaResetWindow = z.infer<typeof QuotaResetWindowSchema>;

export const UserPlatformQuotaItemSchema = z.object({
  userId: z.string(),
  platform: GroupPlatformSchema,
  dailyLimitNanoUsd: NonNegativeNanoUsdSchema,
  weeklyLimitNanoUsd: NonNegativeNanoUsdSchema,
  monthlyLimitNanoUsd: NonNegativeNanoUsdSchema,
  dailyUsedNanoUsd: NonNegativeNanoUsdSchema,
  weeklyUsedNanoUsd: NonNegativeNanoUsdSchema,
  monthlyUsedNanoUsd: NonNegativeNanoUsdSchema,
  dailyResetAtIso: z.string().nullable(),
  weeklyResetAtIso: z.string().nullable(),
  monthlyResetAtIso: z.string().nullable(),
  overLimit: z.boolean(),
  overLimitWindow: QuotaWindowKindSchema.nullable(),
  updatedAtIso: z.string(),
});
export type UserPlatformQuotaItem = z.infer<typeof UserPlatformQuotaItemSchema>;

export const UpsertUserPlatformQuotaEntrySchema = z.object({
  platform: GroupPlatformSchema,
  dailyLimitNanoUsd: NonNegativeNanoUsdSchema.default("0"),
  weeklyLimitNanoUsd: NonNegativeNanoUsdSchema.default("0"),
  monthlyLimitNanoUsd: NonNegativeNanoUsdSchema.default("0"),
});
export type UpsertUserPlatformQuotaEntry = z.infer<typeof UpsertUserPlatformQuotaEntrySchema>;

export const SetUserPlatformQuotasRequestSchema = z.object({
  items: z.array(UpsertUserPlatformQuotaEntrySchema).max(32),
});
export type SetUserPlatformQuotasRequest = z.infer<typeof SetUserPlatformQuotasRequestSchema>;

export const ResetUserPlatformQuotaRequestSchema = z.object({
  window: QuotaResetWindowSchema.default("all"),
});
export type ResetUserPlatformQuotaRequest = z.infer<typeof ResetUserPlatformQuotaRequestSchema>;

export const UserPlatformQuotasResponseSchema = z.object({
  userId: z.string(),
  items: z.array(UserPlatformQuotaItemSchema),
});
export type UserPlatformQuotasResponse = z.infer<typeof UserPlatformQuotasResponseSchema>;

export const DataPlaneBlockedPlatformSchema = z.object({
  userId: z.string().min(1),
  platform: z.string().min(1),
  window: QuotaWindowKindSchema,
});
export type DataPlaneBlockedPlatform = z.infer<typeof DataPlaneBlockedPlatformSchema>;
