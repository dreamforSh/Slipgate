import { z } from "zod";
import { ApiKeyItemSchema, UpdateApiKeyRequestSchema } from "./apikeys.ts";
import { GroupPlatformSchema } from "./pool.ts";

/**
 * Per-user request limits, per-user group rates and admin user tooling (lane U1).
 *
 * Limits are whole numbers where 0 means "no cap". A user's own cap may also be null, which means
 * "inherit the portal default" (Settings → defaultUserRpm / defaultUserConcurrency).
 *
 * Enforcement (all at once, any breach rejects with HTTP 429 `rate_limit_error`):
 *  - user RPM / concurrency: one bucket per user across every key and group
 *    (error codes `user_rpm_exceeded`, `user_concurrency_exceeded`);
 *  - group RPM: one bucket per (user, group); the user's rpm override for that group replaces the
 *    group's cap (an override of 0 exempts the user from the group cap; the user cap still applies)
 *    (`group_rpm_exceeded`);
 *  - group concurrency: one in-flight bucket per (user, group) (`group_concurrency_exceeded`).
 * slipgate-net enforces these at the edge from the data-plane snapshot (`userLimits`).
 *
 * A per-user group rate multiplier replaces the group's multiplier for that user: the BFF bills
 * every settled turn at the user's rate (slipgate-core still holds at the group rate).
 */

/** Upper bound of every RPM / concurrency figure (cap, override, default). */
export const USER_LIMIT_MAX = 1_000_000;
/** Same bound as a group's own multiplier. */
export const USER_RATE_MULTIPLIER_MAX = 100;
/** Ids per batch request (bulk delete / limits / stats). */
export const USER_BATCH_MAX = 500;
/** Rolling window of the "total" usage figure in the admin user list (Linksyncx parity: 30 days). */
export const USER_USAGE_TOTAL_WINDOW_DAYS = 30;

/** A cap: 0 = unlimited. */
export const LimitValueSchema = z.number().int().min(0).max(USER_LIMIT_MAX);
/** A user's own cap: null = inherit the portal default, 0 = unlimited. */
export const UserCapSchema = LimitValueSchema.nullable();
export type UserCap = z.infer<typeof UserCapSchema>;

export const UserRateMultiplierSchema = z.number().positive().max(USER_RATE_MULTIPLIER_MAX);

/* ------------------------------------------------------------------------------------------ */
/* Per-user group rates and rpm overrides (admin)                                             */
/* ------------------------------------------------------------------------------------------ */

/** One user's custom settings in a group (GET /admin/groups/:groupId/rate-multipliers). */
export const UserGroupRateEntrySchema = z.object({
  userId: z.string(),
  email: z.string(),
  username: z.string(),
  notes: z.string(),
  status: z.enum(["active", "suspended"]),
  /** null = the group's own multiplier applies. */
  rateMultiplier: z.number().nullable(),
  /** null = the group's RPM cap applies; 0 = exempt from the group cap. */
  rpmOverride: z.number().int().nullable(),
  updatedAtIso: z.string(),
});
export type UserGroupRateEntry = z.infer<typeof UserGroupRateEntrySchema>;

export const GroupRateMultipliersResponseSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  groupRateMultiplier: z.number(),
  /** The group's own per-user RPM cap (0 = none). */
  groupRpmLimit: z.number().int(),
  items: z.array(UserGroupRateEntrySchema),
});
export type GroupRateMultipliersResponse = z.infer<typeof GroupRateMultipliersResponseSchema>;

/**
 * PUT /admin/groups/:groupId/rate-multipliers: the group's complete set of custom rates. Users
 * not listed lose their custom rate (their rpm override is kept).
 */
export const SetGroupRateMultipliersRequestSchema = z.object({
  entries: z
    .array(z.object({ userId: z.string().min(1), rateMultiplier: UserRateMultiplierSchema }))
    .max(5000),
});
export type SetGroupRateMultipliersRequest = z.infer<typeof SetGroupRateMultipliersRequestSchema>;

/**
 * PUT /admin/groups/:groupId/rpm-overrides: the group's complete set of rpm overrides. Users not
 * listed (or listed with null) lose their override (their custom rate is kept).
 */
export const SetGroupRpmOverridesRequestSchema = z.object({
  entries: z
    .array(z.object({ userId: z.string().min(1), rpmOverride: LimitValueSchema.nullable() }))
    .max(5000),
});
export type SetGroupRpmOverridesRequest = z.infer<typeof SetGroupRpmOverridesRequestSchema>;

/** One group as seen from a user's rate editor (GET /admin/users/:userId/group-rates). */
export const AdminUserGroupRateItemSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  platform: GroupPlatformSchema,
  isExclusive: z.boolean(),
  enabled: z.boolean(),
  groupRateMultiplier: z.number(),
  groupRpmLimit: z.number().int(),
  groupConcurrencyLimit: z.number().int(),
  rateMultiplier: z.number().nullable(),
  rpmOverride: z.number().int().nullable(),
  effectiveRateMultiplier: z.number(),
});
export type AdminUserGroupRateItem = z.infer<typeof AdminUserGroupRateItemSchema>;

export const AdminUserGroupRatesResponseSchema = z.object({
  userId: z.string(),
  items: z.array(AdminUserGroupRateItemSchema),
});
export type AdminUserGroupRatesResponse = z.infer<typeof AdminUserGroupRatesResponseSchema>;

/**
 * PUT /admin/users/:userId/group-rates (Linksyncx UpdateUserRequest.group_rates): only the listed
 * groups change; a number sets, null clears. Omit a map to leave that column alone.
 */
export const SetUserGroupRatesRequestSchema = z
  .object({
    rates: z.record(z.string().min(1), UserRateMultiplierSchema.nullable()).optional(),
    rpmOverrides: z.record(z.string().min(1), LimitValueSchema.nullable()).optional(),
  })
  .refine((v) => v.rates !== undefined || v.rpmOverrides !== undefined, "Provide rates or rpmOverrides")
  .refine(
    (v) => Object.keys(v.rates ?? {}).length + Object.keys(v.rpmOverrides ?? {}).length <= 1000,
    "Too many groups in one request",
  );
export type SetUserGroupRatesRequest = z.infer<typeof SetUserGroupRatesRequestSchema>;

/* ------------------------------------------------------------------------------------------ */
/* User-facing effective rates                                                                */
/* ------------------------------------------------------------------------------------------ */

/** A group the signed-in user can bind keys to, with what it costs and allows for this user. */
export const UserGroupRateItemSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  platform: GroupPlatformSchema,
  /** The group's list multiplier. */
  groupRateMultiplier: z.number(),
  /** The user's custom multiplier in this group, when an admin set one. */
  customRateMultiplier: z.number().nullable(),
  /** What this user is billed at in this group (custom, else the group's). */
  effectiveRateMultiplier: z.number(),
  /** Requests per minute this user may send to this group across all keys (0 = no group cap). */
  rpmLimit: z.number().int(),
  /** Concurrent requests this user may run in this group (0 = no group cap). */
  concurrencyLimit: z.number().int(),
});
export type UserGroupRateItem = z.infer<typeof UserGroupRateItemSchema>;

export const UserGroupRatesResponseSchema = z.object({
  /** groupId -> custom multiplier, custom rates only (Linksyncx GET /groups/rates). */
  rates: z.record(z.string(), z.number()),
  items: z.array(UserGroupRateItemSchema),
  /** The user's own caps across every group (0 = unlimited). */
  userRpmLimit: z.number().int(),
  userConcurrencyLimit: z.number().int(),
});
export type UserGroupRatesResponse = z.infer<typeof UserGroupRatesResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Admin user tooling                                                                         */
/* ------------------------------------------------------------------------------------------ */

const UserIdsSchema = z.array(z.string().min(1)).min(1).max(USER_BATCH_MAX);
/** Batch targets: the listed users, or every user when `all` is true (userIds then ignored). */
const BatchTargetShape = {
  userIds: z.array(z.string().min(1)).max(USER_BATCH_MAX).default([]),
  all: z.boolean().default(false),
};
const hasTargets = (v: { userIds: string[]; all: boolean }) => v.all || v.userIds.length > 0;
const TARGETS_MESSAGE = { message: "Provide userIds or all: true", path: ["userIds"] };

/** POST /admin/users/batch-limits: give the users these caps (null = back to the portal default). */
export const AdminBatchUserLimitsRequestSchema = z
  .object({
    ...BatchTargetShape,
    rpmLimit: UserCapSchema.optional(),
    concurrencyLimit: UserCapSchema.optional(),
  })
  .refine(hasTargets, TARGETS_MESSAGE)
  .refine((v) => v.rpmLimit !== undefined || v.concurrencyLimit !== undefined, "Provide rpmLimit or concurrencyLimit");
export type AdminBatchUserLimitsRequest = z.infer<typeof AdminBatchUserLimitsRequestSchema>;

/**
 * POST /admin/users/batch-concurrency (Linksyncx parity): `set` writes `value`; `add` adds it
 * (may be negative) to each user's effective concurrency cap, floored at 0.
 */
export const AdminBatchUserConcurrencyRequestSchema = z
  .object({
    ...BatchTargetShape,
    mode: z.enum(["set", "add"]),
    value: z.number().int().min(-USER_LIMIT_MAX).max(USER_LIMIT_MAX),
  })
  .refine(hasTargets, TARGETS_MESSAGE)
  .refine((v) => v.mode === "add" || v.value >= 0, { message: "value must be 0 or more", path: ["value"] });
export type AdminBatchUserConcurrencyRequest = z.infer<typeof AdminBatchUserConcurrencyRequestSchema>;

export const AdminBatchUserLimitsResponseSchema = z.object({ updated: z.number().int().nonnegative() });
export type AdminBatchUserLimitsResponse = z.infer<typeof AdminBatchUserLimitsResponseSchema>;

/** POST /admin/users/batch-delete. The caller's own id is never deleted (reported as failed). */
export const AdminBatchDeleteUsersRequestSchema = z.object({ userIds: UserIdsSchema });
export type AdminBatchDeleteUsersRequest = z.infer<typeof AdminBatchDeleteUsersRequestSchema>;

export const AdminBatchDeleteUsersResponseSchema = z.object({
  deleted: z.array(z.string()),
  /** `error`: self | not_found | conflict (payment orders, rebates, last admin) | internal_error. */
  failed: z.array(z.object({ userId: z.string(), error: z.string(), message: z.string() })),
});
export type AdminBatchDeleteUsersResponse = z.infer<typeof AdminBatchDeleteUsersResponseSchema>;

/** Where a group-level RPM cap came from. */
export const RpmLimitSourceSchema = z.enum(["override", "group", "none"]);
export type RpmLimitSource = z.infer<typeof RpmLimitSourceSchema>;

/** GET /admin/users/:userId/rpm-status: current minute and in-flight requests against the caps. */
export const AdminUserRpmStatusSchema = z.object({
  userId: z.string(),
  /** true when the counters came from slipgate-net; false = RPM estimated from usage logs, in-flight unknown. */
  live: z.boolean(),
  rpm: z.object({ used: z.number().int(), limit: z.number().int() }),
  concurrency: z.object({ inFlight: z.number().int().nullable(), limit: z.number().int() }),
  groups: z.array(
    z.object({
      groupId: z.string(),
      groupName: z.string(),
      rpm: z.object({ used: z.number().int(), limit: z.number().int(), source: RpmLimitSourceSchema }),
      concurrency: z.object({ inFlight: z.number().int().nullable(), limit: z.number().int() }),
    }),
  ),
});
export type AdminUserRpmStatus = z.infer<typeof AdminUserRpmStatusSchema>;

/** GET /admin/user-stats/live?userIds=a,b: live concurrency and RPM per user (list column). */
export const AdminUserLiveStatsResponseSchema = z.object({
  live: z.boolean(),
  items: z.array(
    z.object({
      userId: z.string(),
      inFlight: z.number().int().nullable(),
      rpmUsed: z.number().int().nullable(),
      concurrencyLimit: z.number().int(),
      rpmLimit: z.number().int(),
    }),
  ),
});
export type AdminUserLiveStatsResponse = z.infer<typeof AdminUserLiveStatsResponseSchema>;

export const PlatformUsageSchema = z.object({
  platform: z.string(),
  todayNanoUsd: z.string().regex(/^\d+$/),
  totalNanoUsd: z.string().regex(/^\d+$/),
});
export type PlatformUsage = z.infer<typeof PlatformUsageSchema>;

/** GET /admin/user-stats/usage?userIds=a,b&tz=<getTimezoneOffset()>: today and 30-day spend. */
export const AdminUserUsageStatsResponseSchema = z.object({
  windowDays: z.number().int(),
  todayStartIso: z.string(),
  items: z.array(
    z.object({
      userId: z.string(),
      todayNanoUsd: z.string().regex(/^\d+$/),
      totalNanoUsd: z.string().regex(/^\d+$/),
      byPlatform: z.array(PlatformUsageSchema),
    }),
  ),
});
export type AdminUserUsageStatsResponse = z.infer<typeof AdminUserUsageStatsResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Admin management of a user's API keys                                                      */
/* ------------------------------------------------------------------------------------------ */

/** POST /admin/users/:userId/replace-group: move the user from one group to an exclusive one. */
export const ReplaceUserGroupRequestSchema = z
  .object({ fromGroupId: z.string().min(1), toGroupId: z.string().min(1) })
  .refine((v) => v.fromGroupId !== v.toGroupId, { message: "The groups must differ", path: ["toGroupId"] });
export type ReplaceUserGroupRequest = z.infer<typeof ReplaceUserGroupRequestSchema>;

export const ReplaceUserGroupResponseSchema = z.object({
  /** Keys moved from fromGroupId to toGroupId. */
  migratedKeys: z.number().int().nonnegative(),
  /** The user's allowedGroupIds afterwards (toGroupId added, fromGroupId removed). */
  allowedGroupIds: z.array(z.string()),
});
export type ReplaceUserGroupResponse = z.infer<typeof ReplaceUserGroupResponseSchema>;

/**
 * PATCH /admin/api-keys/:keyId: an administrator edits any user's key (same fields as the owner's
 * PATCH, plus moves into exclusive groups the owner was not granted: access is then granted).
 */
export const AdminUpdateApiKeyRequestSchema = UpdateApiKeyRequestSchema;
export type AdminUpdateApiKeyRequest = z.infer<typeof AdminUpdateApiKeyRequestSchema>;

export const AdminUpdateApiKeyResponseSchema = z.object({
  item: ApiKeyItemSchema,
  /** true when the move granted the owner the (exclusive) target group. */
  autoGrantedGroupAccess: z.boolean(),
  grantedGroupId: z.string().nullable(),
});
export type AdminUpdateApiKeyResponse = z.infer<typeof AdminUpdateApiKeyResponseSchema>;

/** A key as listed under its group (GET /admin/groups/:groupId/api-keys); no spend windows. */
export const AdminGroupApiKeyItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  keyPrefix: z.string(),
  enabled: z.boolean(),
  rpmLimit: z.number().int(),
  concurrencyLimit: z.number().int(),
  quotaNanoUsd: z.string(),
  spentNanoUsd: z.string(),
  expiresAtIso: z.string().nullable(),
  lastUsedAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type AdminGroupApiKeyItem = z.infer<typeof AdminGroupApiKeyItemSchema>;

export const AdminGroupApiKeysResponseSchema = z.object({
  items: z.array(AdminGroupApiKeyItemSchema),
  total: z.number().int().nonnegative(),
});
export type AdminGroupApiKeysResponse = z.infer<typeof AdminGroupApiKeysResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Data-plane snapshot                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * `userLimits` of the data-plane snapshot. slipgate-net enforces RPM and concurrency from it;
 * rateMultiplier travels for completeness only (the BFF bills per-user rates; slipgate-core keeps
 * holding at the group rate, so slipgate-net does not forward it).
 */
export const DataPlaneSyncUserLimitsSchema = z.object({
  /** Applied to users without an explicit cap (0 = unlimited). */
  defaultRpmLimit: z.number().int().min(0),
  defaultConcurrencyLimit: z.number().int().min(0),
  /** Users with an explicit cap (0 = unlimited even when the default is set). */
  users: z.array(
    z.object({
      userId: z.string().min(1),
      rpmLimit: z.number().int().min(0).nullable(),
      concurrencyLimit: z.number().int().min(0).nullable(),
    }),
  ),
  /** Groups with a per-user cap. */
  groups: z.array(
    z.object({
      groupId: z.string().min(1),
      rpmLimit: z.number().int().min(0),
      concurrencyLimit: z.number().int().min(0),
    }),
  ),
  overrides: z.array(
    z.object({
      userId: z.string().min(1),
      groupId: z.string().min(1),
      rpmOverride: z.number().int().min(0).nullable(),
      rateMultiplier: z.number().positive().nullable(),
    }),
  ),
});
export type DataPlaneSyncUserLimits = z.infer<typeof DataPlaneSyncUserLimitsSchema>;

/** Effective cap: an explicit user value wins, null inherits the default. */
export function effectiveUserCap(own: number | null | undefined, fallback: number): number {
  return own === null || own === undefined ? Math.max(0, fallback) : Math.max(0, own);
}
