import {
  effectiveUserCap,
  type AdminGroupApiKeyItem,
  type AdminUserItem,
  type DataPlaneSyncUserLimits,
  type PortalSettings,
  type UserGroupRateEntry,
} from "@slipgate/contracts";

/**
 * Per-user request caps, per-user group rates / RPM overrides and the admin user tooling that
 * reads keys and usage across owners (lane U1, contracts in packages/contracts/src/user_limits.ts).
 *
 * Implemented by MemoryUserLimitsStore and PostgresUserLimitsStore with identical behaviour.
 * Rows go away with their user or group (Postgres: ON DELETE CASCADE; memory: pruned on read).
 */

/** A user's own caps; null = inherit the portal default, 0 = unlimited. */
export interface UserCaps {
  rpmLimit: number | null;
  concurrencyLimit: number | null;
}

/** Patch for setUserCaps: omitted fields are left alone, null clears back to the default. */
export interface UserCapsPatch {
  rpmLimit?: number | null;
  concurrencyLimit?: number | null;
}

/** One user's custom settings in one group. */
export interface UserGroupRateRow {
  userId: string;
  groupId: string;
  /** null = the group's own multiplier. */
  rateMultiplier: number | null;
  /** null = the group's RPM cap; 0 = exempt from it. */
  rpmOverride: number | null;
}

/** Batch target: listed ids, or every user. */
export type UserTargets = { all: true } | { userIds: string[] };

/** Per-user, per-platform spend in [sinceIso, now) and since todayStartIso. */
export interface UserPlatformUsageRow {
  userId: string;
  platform: string;
  todayNano: bigint;
  totalNano: bigint;
}

export interface UserLimitsStore {
  /* ---- User caps ---- */
  /** Caps of the given users (users without a row get { null, null }; unknown ids are omitted). */
  getUserCaps(userIds: string[]): Promise<Map<string, UserCaps>>;
  /** Writes the patch for every existing target user; returns how many users it touched. */
  setUserCaps(targets: UserTargets, patch: UserCapsPatch): Promise<number>;
  /**
   * Adds `delta` to each target's effective concurrency cap (own cap, else `fallback`), floored at
   * 0, and stores the result as the user's own cap. Returns how many users it touched.
   */
  addUserConcurrency(targets: UserTargets, delta: number, fallback: number): Promise<number>;
  /** Latest api_keys.last_used_at per user (users without a used key are omitted). */
  lastApiUse(userIds: string[]): Promise<Map<string, string>>;

  /* ---- Per-user group rates / RPM overrides ---- */
  /** Every user with a custom rate or RPM override in the group, with their profile fields. */
  listGroupRates(groupId: string): Promise<UserGroupRateEntry[]>;
  /**
   * Replaces the group's custom multipliers with `entries` (users not listed lose theirs; their
   * RPM override stays). Unknown users fail bad_request and nothing changes. Returns entries kept.
   */
  syncGroupRateMultipliers(groupId: string, entries: { userId: string; rateMultiplier: number }[]): Promise<number>;
  /** Same as syncGroupRateMultipliers for RPM overrides (null entries clear). */
  syncGroupRpmOverrides(groupId: string, entries: { userId: string; rpmOverride: number | null }[]): Promise<number>;
  /** Clears one kind of setting for every user of the group; returns how many rows changed. */
  clearGroupRates(groupId: string, kind: "rate" | "rpm"): Promise<number>;
  /** The user's rows across groups. */
  listUserGroupRates(userId: string): Promise<UserGroupRateRow[]>;
  /**
   * Patches one user's settings per group: a number sets, null clears, absent keys are left
   * alone. Unknown groups fail bad_request and nothing changes.
   */
  setUserGroupRates(
    userId: string,
    patch: { rates?: Record<string, number | null>; rpmOverrides?: Record<string, number | null> },
  ): Promise<void>;
  /** Every row with a custom rate (settlement pricing cache). */
  listRateOverrides(): Promise<UserGroupRateRow[]>;

  /* ---- Data plane ---- */
  /** Explicit user caps, capped groups and every override row (the snapshot's userLimits). */
  exportUserLimits(defaults: { rpm: number; concurrency: number }): Promise<DataPlaneSyncUserLimits>;

  /* ---- Usage figures ---- */
  /** Spend per (user, platform) since `sinceIso`, with the part since `todayStartIso`. */
  userPlatformUsage(userIds: string[], sinceIso: string, todayStartIso: string): Promise<UserPlatformUsageRow[]>;
  /** Settled requests of one user per group since `sinceIso` (RPM estimate without live counters). */
  requestsSince(userId: string, sinceIso: string): Promise<Map<string, number>>;

  /* ---- Keys across owners ---- */
  /** Owner and group of any key, or null. */
  getApiKeyOwner(keyId: string): Promise<{ userId: string; groupId: string } | null>;
  /** One page of a group's keys (newest first) with the owner's email. */
  listGroupApiKeys(groupId: string, page: number, pageSize: number): Promise<{ items: AdminGroupApiKeyItem[]; total: number }>;
  /** Adds the group to the user's allowedGroupIds; true when it was not there yet. */
  grantGroup(userId: string, groupId: string): Promise<boolean>;
  /**
   * Atomically: grants `toGroupId`, moves every key of the user from `fromGroupId` to it and
   * revokes `fromGroupId`. Returns the moved key count and the new allowedGroupIds.
   */
  replaceUserGroup(userId: string, fromGroupId: string, toGroupId: string): Promise<{ migratedKeys: number; allowedGroupIds: string[] }>;
}

/** Validates a multiplier the way the contracts do (0 < m <= 100), rounded to 6 decimals. */
export function normalizeRate(rate: number): number {
  return Math.round(rate * 1_000_000) / 1_000_000;
}

/** UTC instant of the viewer's local midnight; `tzOffsetMinutes` is `Date#getTimezoneOffset()`. */
export function viewerDayStartMs(nowMs: number, tzOffsetMinutes: number): number {
  const DAY = 86_400_000;
  const shift = tzOffsetMinutes * 60_000;
  return Math.floor((nowMs - shift) / DAY) * DAY + shift;
}

/** Later of two optional ISO instants. */
export function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Fills the admin user row's caps, effective caps and activity fields. */
export function withUserLimitFields(
  user: AdminUserItem,
  caps: UserCaps | undefined,
  lastApiUsedAtIso: string | null,
  settings: Pick<PortalSettings, "defaultUserRpm" | "defaultUserConcurrency">,
): AdminUserItem {
  const rpmLimit = caps?.rpmLimit ?? null;
  const concurrencyLimit = caps?.concurrencyLimit ?? null;
  return {
    ...user,
    rpmLimit,
    concurrencyLimit,
    effectiveRpmLimit: effectiveUserCap(rpmLimit, settings.defaultUserRpm),
    effectiveConcurrencyLimit: effectiveUserCap(concurrencyLimit, settings.defaultUserConcurrency),
    lastApiUsedAtIso,
    lastActiveAtIso: laterIso(user.lastLoginAtIso, lastApiUsedAtIso),
  };
}
