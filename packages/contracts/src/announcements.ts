import { z } from "zod";
import { UserRoleSchema, UserStatusSchema } from "./iam.ts";

/**
 * Announcement targeting conditions and per-user read status.
 *
 * Targeting narrows an announcement's audience beyond its role audience (all / users / admins):
 * `{ anyOf: [{ allOf: [condition, …] }, …] }` is an OR across groups and an AND inside each group.
 * An empty `anyOf` adds no restriction. Conditions look at the account's wallet balance (nano-USD)
 * and at the groups it holds an active, unexpired subscription in.
 *
 * Self-contained leaf module: commerce.ts imports the targeting schemas, so nothing here may import
 * commerce.ts (an ES module cycle would leave these constants uninitialised).
 */

/** Signed nano-USD integer string (balances may be negative). */
const SignedNanoSchema = z.string().regex(/^-?\d{1,30}$/, "Expected a nano-USD integer string");

const NANO_PER_USD_LOCAL = 1_000_000_000n;
const USD_TEXT = /^(-)?\$?(\d{1,12})(?:\.(\d{1,9}))?$/;

/** "12.5" / "$0.000001" / "-3" → nano-USD integer string; null when not a USD amount. */
export function announcementUsdToNano(text: string): string | null {
  const m = USD_TEXT.exec(text.trim());
  if (!m) return null;
  const nano = BigInt(m[2]!) * NANO_PER_USD_LOCAL + BigInt((m[3] ?? "").padEnd(9, "0"));
  return (m[1] && nano !== 0n ? -nano : nano).toString();
}

export const AnnouncementBalanceOperatorSchema = z.enum(["gt", "gte", "lt", "lte", "eq"]);
export type AnnouncementBalanceOperator = z.infer<typeof AnnouncementBalanceOperatorSchema>;

/** Upper bounds keep stored rules (and their evaluation per user) small. */
export const ANNOUNCEMENT_TARGETING_MAX_GROUPS = 20;
export const ANNOUNCEMENT_TARGETING_MAX_CONDITIONS = 20;
export const ANNOUNCEMENT_TARGETING_MAX_GROUP_IDS = 100;

/** The account holds an active, unexpired subscription in at least one of these groups. */
export const AnnouncementSubscriptionConditionSchema = z.object({
  type: z.literal("subscription"),
  operator: z.literal("in"),
  groupIds: z.array(z.string().trim().min(1).max(128)).min(1, "Pick at least one group").max(ANNOUNCEMENT_TARGETING_MAX_GROUP_IDS),
});
export type AnnouncementSubscriptionCondition = z.infer<typeof AnnouncementSubscriptionConditionSchema>;

/** The account's wallet balance compared with a threshold (nano-USD). */
export const AnnouncementBalanceConditionSchema = z.object({
  type: z.literal("balance"),
  operator: AnnouncementBalanceOperatorSchema,
  valueNanoUsd: SignedNanoSchema,
});
export type AnnouncementBalanceCondition = z.infer<typeof AnnouncementBalanceConditionSchema>;

export const AnnouncementConditionSchema = z.discriminatedUnion("type", [
  AnnouncementSubscriptionConditionSchema,
  AnnouncementBalanceConditionSchema,
]);
export type AnnouncementCondition = z.infer<typeof AnnouncementConditionSchema>;

export const AnnouncementConditionGroupSchema = z.object({
  allOf: z.array(AnnouncementConditionSchema).min(1, "A condition group needs at least one condition").max(ANNOUNCEMENT_TARGETING_MAX_CONDITIONS),
});
export type AnnouncementConditionGroup = z.infer<typeof AnnouncementConditionGroupSchema>;

/** Stored / returned form. */
export const AnnouncementTargetingSchema = z.object({
  anyOf: z.array(AnnouncementConditionGroupSchema).max(ANNOUNCEMENT_TARGETING_MAX_GROUPS).default([]),
});
export type AnnouncementTargeting = z.infer<typeof AnnouncementTargetingSchema>;

export function emptyAnnouncementTargeting(): AnnouncementTargeting {
  return { anyOf: [] };
}

/** A balance threshold may be typed in USD (`valueUsd`, e.g. "5" or "0.5") instead of `valueNanoUsd`. */
function balanceUsdInput(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const c = raw as Record<string, unknown>;
  if (c.type !== "balance" || c.valueNanoUsd !== undefined || c.valueUsd === undefined) return raw;
  const { valueUsd, ...rest } = c;
  const nano = typeof valueUsd === "string" ? announcementUsdToNano(valueUsd) : typeof valueUsd === "number" ? announcementUsdToNano(String(valueUsd)) : null;
  if (nano === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valueUsd"], message: "Expected a USD amount such as 10 or 2.50" });
    return rest;
  }
  return { ...rest, valueNanoUsd: nano };
}

/** Trims and de-duplicates group ids (order kept). */
export function normalizeAnnouncementTargeting(t: AnnouncementTargeting): AnnouncementTargeting {
  return {
    anyOf: t.anyOf.map((g) => ({
      allOf: g.allOf.map((c) => (c.type === "subscription" ? { ...c, groupIds: [...new Set(c.groupIds.map((id) => id.trim()))] } : { ...c })),
    })),
  };
}

/**
 * Admin input: absent / null / `{}` means no restriction; balance thresholds accept `valueUsd`.
 * Every group must hold at least one condition (an empty AND group would match everyone).
 */
export const AnnouncementTargetingInputSchema = z
  .object({
    anyOf: z
      .array(
        z.object({
          allOf: z
            .array(z.preprocess(balanceUsdInput, AnnouncementConditionSchema))
            .min(1, "A condition group needs at least one condition")
            .max(ANNOUNCEMENT_TARGETING_MAX_CONDITIONS),
        }),
      )
      .max(ANNOUNCEMENT_TARGETING_MAX_GROUPS)
      .default([]),
  })
  .transform((t) => normalizeAnnouncementTargeting(t as AnnouncementTargeting));
export type AnnouncementTargetingInput = z.input<typeof AnnouncementTargetingInputSchema>;

/** Every subscription group id a targeting rule references (for validation and pickers). */
export function announcementTargetingGroupIds(t: AnnouncementTargeting): string[] {
  const ids = new Set<string>();
  for (const g of t.anyOf) for (const c of g.allOf) if (c.type === "subscription") for (const id of c.groupIds) ids.add(id);
  return [...ids];
}

/* ------------------------------------------------------------------------------------------ */
/* Read status (admin)                                                                        */
/* ------------------------------------------------------------------------------------------ */

export const AnnouncementReadFilterSchema = z.enum(["all", "read", "unread"]);
export type AnnouncementReadFilter = z.infer<typeof AnnouncementReadFilterSchema>;

export const AnnouncementEligibleFilterSchema = z.enum(["all", "eligible", "ineligible"]);
export type AnnouncementEligibleFilter = z.infer<typeof AnnouncementEligibleFilterSchema>;

/**
 * `read_at_*` keep unread accounts last and `username_*` accounts without a username last; balance
 * compares the wallet balance as a number. Ties fall back to email, then the user id.
 */
export const AnnouncementReadStatusSortSchema = z.enum([
  "email_asc",
  "email_desc",
  "read_at_desc",
  "read_at_asc",
  "username_asc",
  "username_desc",
  "balance_desc",
  "balance_asc",
]);
export type AnnouncementReadStatusSort = z.infer<typeof AnnouncementReadStatusSortSchema>;

/** GET /api/v1/admin/announcements/:id/read-status query. */
export const AnnouncementReadStatusQuerySchema = z.object({
  /** Email or username substring (case-insensitive). */
  q: z.string().trim().max(200).optional().catch(undefined),
  read: AnnouncementReadFilterSchema.catch("all").default("all"),
  eligible: AnnouncementEligibleFilterSchema.catch("all").default("all"),
  sort: AnnouncementReadStatusSortSchema.catch("email_asc").default("email_asc"),
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(20).default(20),
});
export type AnnouncementReadStatusQuery = z.infer<typeof AnnouncementReadStatusQuerySchema>;

export const AnnouncementReadStatusItemSchema = z.object({
  userId: z.string(),
  email: z.string(),
  username: z.string(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  balanceNanoUsd: SignedNanoSchema,
  read: z.boolean(),
  readAtIso: z.string().nullable(),
  /** The account's role matches the audience and it meets the targeting conditions right now. */
  eligible: z.boolean(),
});
export type AnnouncementReadStatusItem = z.infer<typeof AnnouncementReadStatusItemSchema>;

export const AnnouncementReadStatusResponseSchema = z.object({
  items: z.array(AnnouncementReadStatusItemSchema),
  /** Accounts matching q / read / eligible (for pagination). */
  total: z.number().int().nonnegative(),
  /** Over every account, ignoring q / read / eligible. */
  stats: z.object({
    users: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    eligibleRead: z.number().int().nonnegative(),
  }),
});
export type AnnouncementReadStatusResponse = z.infer<typeof AnnouncementReadStatusResponseSchema>;
