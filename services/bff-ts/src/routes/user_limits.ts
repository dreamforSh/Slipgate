import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  AdminBatchDeleteUsersRequestSchema,
  AdminBatchUserConcurrencyRequestSchema,
  AdminBatchUserLimitsRequestSchema,
  AdminUpdateApiKeyRequestSchema,
  effectiveUserCap,
  ReplaceUserGroupRequestSchema,
  SetGroupRateMultipliersRequestSchema,
  SetGroupRpmOverridesRequestSchema,
  SetUserGroupRatesRequestSchema,
  USER_BATCH_MAX,
  USER_USAGE_TOTAL_WINDOW_DAYS,
  type AdminBatchDeleteUsersResponse,
  type AdminUpdateApiKeyResponse,
  type AdminUserGroupRateItem,
  type AdminUserItem,
  type AdminUserLiveStatsResponse,
  type AdminUserRpmStatus,
  type AdminUserUsageStatsResponse,
  type DataPlaneSyncApiKey,
  type DataPlaneSyncSnapshot,
  type DataPlaneSyncUserLimits,
  type GroupItem,
  type ModelPricingRule,
  type PortalSettings,
  type TurnSettlementEvent,
  type UserGroupRateItem,
  type UserGroupRatesResponse,
} from "@slipgate/contracts";
import { cached } from "../insights.ts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { viewerDayStartMs, withUserLimitFields, type UserCapsPatch } from "../store/user_limits_types.ts";
import { repriceSettlement } from "./pricing.ts";

/*
 * Lane U1: per-user caps, per-user group rates / RPM overrides, bulk user operations, admin user
 * list figures and admin management of any user's API keys. Contracts: user_limits.ts.
 *
 * Enforcement: slipgate-net admits every dispatched turn against the snapshot's `userLimits`
 * (services/net-go/internal/dataplane/user_limits.go); the snapshot also clamps each key's own
 * RPM / concurrency to the caps that cover it, so slipgate-core's per-key buckets never allow
 * more than the user may have. Billing: the BFF prices every settled turn of a user with a
 * custom group rate at that rate (repriceForUser), whatever slipgate-core held.
 */

type App = Hono<AuthEnv>;

/** What slipgate-net reports for one user (POST /internal/net/dataplane/user-limits/stats). */
export interface NetUserLiveStats {
  userId: string;
  rpmUsed: number;
  inFlight: number;
  groups: { groupId: string; rpmUsed: number; inFlight: number }[];
}

/** Fetches live counters from slipgate-net; null when it is not configured or unreachable. */
export type NetUserStatsFetcher = (userIds: string[]) => Promise<NetUserLiveStats[] | null>;

export interface UserLimitRouteContext {
  store: ControlStore;
  sessions: SessionManager;
  /** Pushes a fresh snapshot to the data plane; never throws. */
  syncDataPlane: () => Promise<void>;
  /** Live counters from slipgate-net (defaults to netUserStatsFetcher(internalToken)). */
  netStats?: NetUserStatsFetcher;
  internalToken?: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers (snapshot, billing)                                                           */
/* ------------------------------------------------------------------------------------------ */

const pair = (userId: string, groupId: string) => `${userId}\u0000${groupId}`;

/** The caps that cover one (user, group): 0 = none. Mirrors slipgate-net's admission. */
export function capsFor(limits: DataPlaneSyncUserLimits, userId: string, groupId: string) {
  const user = limits.users.find((u) => u.userId === userId);
  const group = limits.groups.find((g) => g.groupId === groupId);
  const override = limits.overrides.find((o) => o.userId === userId && o.groupId === groupId);
  const groupRpm = override && override.rpmOverride !== null ? override.rpmOverride : (group?.rpmLimit ?? 0);
  return {
    userRpm: effectiveUserCap(user?.rpmLimit, limits.defaultRpmLimit),
    userConcurrency: effectiveUserCap(user?.concurrencyLimit, limits.defaultConcurrencyLimit),
    groupRpm,
    groupRpmSource: (override && override.rpmOverride !== null ? "override" : groupRpm > 0 ? "group" : "none") as
      | "override"
      | "group"
      | "none",
    groupConcurrency: group?.concurrencyLimit ?? 0,
  };
}

/**
 * Lowers each key's own RPM / concurrency to the tightest user or group cap covering it. The
 * edge enforces the caps across keys; this keeps slipgate-core's per-key buckets inside them too.
 */
export function clampKeysToUserLimits(keys: DataPlaneSyncApiKey[], limits: DataPlaneSyncUserLimits): DataPlaneSyncApiKey[] {
  const users = new Map(limits.users.map((u) => [u.userId, u]));
  const groups = new Map(limits.groups.map((g) => [g.groupId, g]));
  const overrides = new Map(limits.overrides.map((o) => [pair(o.userId, o.groupId), o]));
  const tightest = (own: number, ...caps: number[]) => caps.reduce((acc, c) => (c > 0 && c < acc ? c : acc), own);
  return keys.map((k) => {
    const u = users.get(k.userId);
    const g = groups.get(k.groupId);
    const o = overrides.get(pair(k.userId, k.groupId));
    const groupRpm = o && o.rpmOverride !== null ? o.rpmOverride : (g?.rpmLimit ?? 0);
    const rpm = tightest(k.rpmLimit, effectiveUserCap(u?.rpmLimit, limits.defaultRpmLimit), groupRpm);
    const conc = tightest(
      k.concurrencyLimit,
      effectiveUserCap(u?.concurrencyLimit, limits.defaultConcurrencyLimit),
      g?.concurrencyLimit ?? 0,
    );
    return rpm === k.rpmLimit && conc === k.concurrencyLimit ? k : { ...k, rpmLimit: rpm, concurrencyLimit: conc };
  });
}

/** Adds `userLimits` (and the clamped key limits + blocked platforms) to an exported snapshot. */
export async function withUserLimits(store: ControlStore, snapshot: DataPlaneSyncSnapshot): Promise<DataPlaneSyncSnapshot> {
  const [settings, blockedPlatforms] = await Promise.all([
    store.ops.getSettings(),
    store.platformQuotas.listBlockedUserPlatforms(),
  ]);
  const limits = {
    ...(await store.userLimits.exportUserLimits({
      rpm: settings.defaultUserRpm,
      concurrency: settings.defaultUserConcurrency,
    })),
    blockedPlatforms,
  };
  return { ...snapshot, apiKeys: clampKeysToUserLimits(snapshot.apiKeys, limits), userLimits: limits };
}

function micros(rate: number): bigint {
  return BigInt(Math.max(1, Math.round(rate * 1_000_000)));
}

/**
 * repriceSettlement at the user's custom rate. slipgate-core already prices with the user's rate
 * once it has synced, so a turn it charged with no BFF price rule (built-in rates) is only scaled
 * from the rate it reports having used (coreRateMultiplierMicros) to the user's current rate,
 * rounding up. Without that report the core's cost already carries the user's rate.
 */
export function repriceForUser(
  ev: TurnSettlementEvent,
  rules: readonly ModelPricingRule[],
  groupRate: number,
  userRate: number | null,
): TurnSettlementEvent {
  const repriced = repriceSettlement(ev, rules, userRate ?? groupRate);
  if (userRate === null || repriced !== ev || ev.coreRateMultiplierMicros === undefined) return repriced;
  const cost = BigInt(ev.costNanoUsd);
  if (cost <= 0n || ev.statusCode >= 400) return ev;
  const num = cost * micros(userRate);
  const den = BigInt(ev.coreRateMultiplierMicros);
  const scaled = (num + den - 1n) / den;
  return scaled === cost ? ev : { ...ev, costNanoUsd: scaled.toString() };
}

/** Settlement-path cache of custom rates: one load per 30 s (or per data-plane sync). */
export class UserRateCache {
  private load: () => Promise<Map<string, number>>;

  constructor(private readonly store: ControlStore) {
    this.load = this.fresh();
  }

  private fresh() {
    return cached(30_000, async () => {
      const rows = await this.store.userLimits.listRateOverrides();
      return new Map(rows.filter((r) => r.rateMultiplier !== null).map((r) => [pair(r.userId, r.groupId), r.rateMultiplier!]));
    });
  }

  invalidate(): void {
    this.load = this.fresh();
  }

  /** The user's custom multiplier in the group, or null (the group's applies). */
  async rateFor(userId: string, groupId: string): Promise<number | null> {
    return (await this.load()).get(pair(userId, groupId)) ?? null;
  }
}

/** Fills rpmLimit / concurrencyLimit of a raw key-create body from the portal defaults when absent. */
export function withApiKeyDefaults(raw: unknown, settings: Pick<PortalSettings, "defaultApiKeyRpm" | "defaultApiKeyConcurrency">): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  return {
    ...body,
    rpmLimit: body.rpmLimit ?? settings.defaultApiKeyRpm,
    concurrencyLimit: body.concurrencyLimit ?? settings.defaultApiKeyConcurrency,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Admin user rows                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Adds caps, effective caps and last-use fields to admin user rows (three reads for any count). */
export async function decorateAdminUsers(store: ControlStore, items: AdminUserItem[]): Promise<AdminUserItem[]> {
  if (items.length === 0) return items;
  const ids = items.map((u) => u.id);
  const [settings, caps, lastUse] = await Promise.all([
    store.ops.getSettings(),
    store.userLimits.getUserCaps(ids),
    store.userLimits.lastApiUse(ids),
  ]);
  return items.map((u) => withUserLimitFields(u, caps.get(u.id), lastUse.get(u.id) ?? null, settings));
}

/** Writes the caps of an admin create/update request (only the fields it carries). */
export async function applyUserCaps(
  store: ControlStore,
  userId: string,
  req: { rpmLimit?: number | null; concurrencyLimit?: number | null },
): Promise<void> {
  const patch: UserCapsPatch = {};
  if (req.rpmLimit !== undefined) patch.rpmLimit = req.rpmLimit;
  if (req.concurrencyLimit !== undefined) patch.concurrencyLimit = req.concurrencyLimit;
  if (Object.keys(patch).length > 0) await store.userLimits.setUserCaps({ userIds: [userId] }, patch);
}

/**
 * Checks the limit fields of an admin user update (caps, Linksyncx `groupRates`) before the user
 * is saved, and returns the step that writes them afterwards. Unknown groups fail bad_request.
 */
export async function prepareUserLimitFields(
  store: ControlStore,
  req: { rpmLimit?: number | null; concurrencyLimit?: number | null; groupRates?: Record<string, number | null> },
): Promise<(userId: string) => Promise<void>> {
  const rates = req.groupRates && Object.keys(req.groupRates).length > 0 ? req.groupRates : null;
  if (rates) {
    const known = new Set((await store.listGroups(false)).map((g) => g.id));
    const missing = Object.keys(rates).filter((id) => !known.has(id));
    if (missing.length > 0) throw new StoreError("bad_request", `Unknown group id(s): ${missing.slice(0, 5).join(", ")}`);
  }
  return async (userId) => {
    await applyUserCaps(store, userId, req);
    if (rates) await store.userLimits.setUserGroupRates(userId, { rates });
  };
}

/* ------------------------------------------------------------------------------------------ */
/* slipgate-net live counters                                                                 */
/* ------------------------------------------------------------------------------------------ */

export function netUserStatsFetcher(internalToken: string): NetUserStatsFetcher {
  return async (userIds) => {
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    if (!internalUrl || !internalToken || userIds.length === 0) return null;
    try {
      const res = await fetch(`${internalUrl}/internal/net/dataplane/user-limits/stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Slipgate-Internal-Token": internalToken },
        body: JSON.stringify({ userIds }),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as { items?: unknown };
      return Array.isArray(payload.items) ? (payload.items as NetUserLiveStats[]) : null;
    } catch {
      return null;
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Request helpers                                                                            */
/* ------------------------------------------------------------------------------------------ */

function bad(issues: z.ZodIssue[]): never {
  const message = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

/** `?userIds=a,b` (also repeated params), deduplicated, at most USER_BATCH_MAX. */
function userIdsParam(c: Context): string[] {
  const values = [...(c.req.queries("userIds") ?? []), ...(c.req.queries("userIds[]") ?? [])];
  const ids = [...new Set(values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
  if (ids.length > USER_BATCH_MAX) throw new StoreError("bad_request", `At most ${USER_BATCH_MAX} user ids`);
  return ids;
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function targetsOf(req: { userIds: string[]; all: boolean }) {
  return req.all ? ({ all: true } as const) : { userIds: req.userIds };
}

/* ------------------------------------------------------------------------------------------ */
/* Routes                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export function registerUserLimitRoutes(app: App, ctx: UserLimitRouteContext): void {
  const { store, sessions, syncDataPlane } = ctx;
  const limits = store.userLimits;
  const netStats = ctx.netStats ?? netUserStatsFetcher(ctx.internalToken ?? "");

  async function requireGroup(groupId: string): Promise<GroupItem> {
    const group = (await store.listGroups(false)).find((g) => g.id === groupId);
    if (!group) throw new StoreError("not_found", "Group not found");
    return group;
  }

  async function requireUser(userId: string): Promise<AdminUserItem> {
    const user = await store.ops.getAdminUser(userId);
    if (!user) throw new StoreError("not_found", "User not found");
    return user;
  }

  /* ---------------- User: own effective rates ---------------- */

  app.get("/api/v1/user/groups/rates", async (c) => {
    const claims = c.get("authUser");
    const [groups, rows, caps, settings, granted] = await Promise.all([
      store.listGroups(true),
      limits.listUserGroupRates(claims.sub),
      limits.getUserCaps([claims.sub]),
      store.ops.getSettings(),
      claims.role === "admin" ? Promise.resolve(null) : store.ops.getAdminUser(claims.sub).then((u) => new Set(u?.allowedGroupIds ?? [])),
    ]);
    const byGroup = new Map(rows.map((r) => [r.groupId, r]));
    const visible = groups.filter((g) => !g.isExclusive || !granted || granted.has(g.id));
    const rates: Record<string, number> = {};
    const items: UserGroupRateItem[] = visible.map((g) => {
      const row = byGroup.get(g.id);
      const custom = row?.rateMultiplier ?? null;
      if (custom !== null) rates[g.id] = custom;
      return {
        groupId: g.id,
        groupName: g.name,
        platform: g.platform,
        groupRateMultiplier: g.rateMultiplier,
        customRateMultiplier: custom,
        effectiveRateMultiplier: custom ?? g.rateMultiplier,
        rpmLimit: row && row.rpmOverride !== null ? row.rpmOverride : g.rpmLimit,
        concurrencyLimit: g.concurrencyLimit,
      };
    });
    const own = caps.get(claims.sub);
    const response: UserGroupRatesResponse = {
      rates,
      items,
      userRpmLimit: effectiveUserCap(own?.rpmLimit, settings.defaultUserRpm),
      userConcurrencyLimit: effectiveUserCap(own?.concurrencyLimit, settings.defaultUserConcurrency),
    };
    return c.json(response);
  });

  /* ---------------- Admin: per-group user rates / RPM overrides ---------------- */

  app.get("/api/v1/admin/groups/:groupId/rate-multipliers", async (c) => {
    const group = await requireGroup(c.req.param("groupId"));
    const items = await limits.listGroupRates(group.id);
    return c.json({
      groupId: group.id,
      groupName: group.name,
      groupRateMultiplier: group.rateMultiplier,
      groupRpmLimit: group.rpmLimit,
      items,
    });
  });

  app.put("/api/v1/admin/groups/:groupId/rate-multipliers", async (c) => {
    const groupId = c.req.param("groupId");
    const req = await body(c, SetGroupRateMultipliersRequestSchema);
    const updated = await limits.syncGroupRateMultipliers(groupId, req.entries);
    await syncDataPlane();
    return c.json({ updated });
  });

  app.delete("/api/v1/admin/groups/:groupId/rate-multipliers", async (c) => {
    const cleared = await limits.clearGroupRates(c.req.param("groupId"), "rate");
    await syncDataPlane();
    return c.json({ cleared });
  });

  app.put("/api/v1/admin/groups/:groupId/rpm-overrides", async (c) => {
    const groupId = c.req.param("groupId");
    const req = await body(c, SetGroupRpmOverridesRequestSchema);
    const updated = await limits.syncGroupRpmOverrides(groupId, req.entries);
    await syncDataPlane();
    return c.json({ updated });
  });

  app.delete("/api/v1/admin/groups/:groupId/rpm-overrides", async (c) => {
    const cleared = await limits.clearGroupRates(c.req.param("groupId"), "rpm");
    await syncDataPlane();
    return c.json({ cleared });
  });

  app.get("/api/v1/admin/groups/:groupId/api-keys", async (c) => {
    const page = intParam(c.req.query("page"), 1, 1, 100_000);
    const pageSize = intParam(c.req.query("pageSize"), 20, 1, 200);
    return c.json(await limits.listGroupApiKeys(c.req.param("groupId"), page, pageSize));
  });

  /* ---------------- Admin: one user's group rates ---------------- */

  async function userGroupRates(userId: string) {
    const [groups, rows] = await Promise.all([store.listGroups(false), limits.listUserGroupRates(userId)]);
    const byGroup = new Map(rows.map((r) => [r.groupId, r]));
    const items: AdminUserGroupRateItem[] = groups.map((g) => {
      const row = byGroup.get(g.id);
      const rate = row?.rateMultiplier ?? null;
      return {
        groupId: g.id,
        groupName: g.name,
        platform: g.platform,
        isExclusive: g.isExclusive,
        enabled: g.enabled,
        groupRateMultiplier: g.rateMultiplier,
        groupRpmLimit: g.rpmLimit,
        groupConcurrencyLimit: g.concurrencyLimit,
        rateMultiplier: rate,
        rpmOverride: row?.rpmOverride ?? null,
        effectiveRateMultiplier: rate ?? g.rateMultiplier,
      };
    });
    return { userId, items };
  }

  app.get("/api/v1/admin/users/:userId/group-rates", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    return c.json(await userGroupRates(user.id));
  });

  app.put("/api/v1/admin/users/:userId/group-rates", async (c) => {
    const userId = c.req.param("userId");
    const req = await body(c, SetUserGroupRatesRequestSchema);
    await limits.setUserGroupRates(userId, req);
    await syncDataPlane();
    return c.json(await userGroupRates(userId));
  });

  /* ---------------- Admin: caps and bulk user operations ---------------- */

  app.post("/api/v1/admin/users/batch-limits", async (c) => {
    const req = await body(c, AdminBatchUserLimitsRequestSchema);
    const patch: UserCapsPatch = {};
    if (req.rpmLimit !== undefined) patch.rpmLimit = req.rpmLimit;
    if (req.concurrencyLimit !== undefined) patch.concurrencyLimit = req.concurrencyLimit;
    const updated = await limits.setUserCaps(targetsOf(req), patch);
    await syncDataPlane();
    return c.json({ updated });
  });

  app.post("/api/v1/admin/users/batch-concurrency", async (c) => {
    const req = await body(c, AdminBatchUserConcurrencyRequestSchema);
    const settings = await store.ops.getSettings();
    const updated =
      req.mode === "set"
        ? await limits.setUserCaps(targetsOf(req), { concurrencyLimit: req.value })
        : await limits.addUserConcurrency(targetsOf(req), req.value, settings.defaultUserConcurrency);
    await syncDataPlane();
    return c.json({ updated });
  });

  app.post("/api/v1/admin/users/batch-delete", async (c) => {
    const req = await body(c, AdminBatchDeleteUsersRequestSchema);
    const self = c.get("authUser").sub;
    const result: AdminBatchDeleteUsersResponse = { deleted: [], failed: [] };
    for (const userId of new Set(req.userIds)) {
      if (userId === self) {
        result.failed.push({ userId, error: "self", message: "You cannot delete your own account" });
        continue;
      }
      try {
        await store.ops.deleteUser(userId);
        result.deleted.push(userId);
      } catch (err) {
        if (err instanceof StoreError) result.failed.push({ userId, error: err.code, message: err.message });
        else result.failed.push({ userId, error: "internal_error", message: err instanceof Error ? err.message : "Delete failed" });
      }
    }
    if (result.deleted.length > 0) {
      sessions.invalidate(...result.deleted);
      await syncDataPlane();
    }
    return c.json(result);
  });

  app.get("/api/v1/admin/users/:userId/rpm-status", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    const nowMs = Date.now();
    const minuteStart = new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
    const [settings, groups, rows, caps, keys, live] = await Promise.all([
      store.ops.getSettings(),
      store.listGroups(false),
      limits.listUserGroupRates(user.id),
      limits.getUserCaps([user.id]),
      store.listUserApiKeys(user.id),
      netStats([user.id]),
    ]);
    const liveUser = live?.find((s) => s.userId === user.id) ?? (live ? { userId: user.id, rpmUsed: 0, inFlight: 0, groups: [] } : null);
    const estimated = liveUser ? null : await limits.requestsSince(user.id, minuteStart);
    const own = caps.get(user.id);
    const snapshotLimits: DataPlaneSyncUserLimits = {
      defaultRpmLimit: settings.defaultUserRpm,
      defaultConcurrencyLimit: settings.defaultUserConcurrency,
      users: [{ userId: user.id, rpmLimit: own?.rpmLimit ?? null, concurrencyLimit: own?.concurrencyLimit ?? null }],
      groups: groups.map((g) => ({ groupId: g.id, rpmLimit: g.rpmLimit, concurrencyLimit: g.concurrencyLimit })),
      overrides: rows.map((r) => ({ userId: r.userId, groupId: r.groupId, rpmOverride: r.rpmOverride, rateMultiplier: r.rateMultiplier })),
    };
    // Groups worth showing: where the user has keys, a custom setting, or current traffic.
    const shown = new Set<string>([
      ...keys.map((k) => k.groupId),
      ...rows.map((r) => r.groupId),
      ...(liveUser?.groups.map((g) => g.groupId) ?? []),
      ...(estimated ? [...estimated.keys()] : []),
    ]);
    const liveGroups = new Map((liveUser?.groups ?? []).map((g) => [g.groupId, g]));
    const status: AdminUserRpmStatus = {
      userId: user.id,
      live: liveUser !== null,
      rpm: {
        used: liveUser ? liveUser.rpmUsed : [...(estimated?.values() ?? [])].reduce((a, b) => a + b, 0),
        limit: effectiveUserCap(own?.rpmLimit, settings.defaultUserRpm),
      },
      concurrency: {
        inFlight: liveUser ? liveUser.inFlight : null,
        limit: effectiveUserCap(own?.concurrencyLimit, settings.defaultUserConcurrency),
      },
      groups: groups
        .filter((g) => shown.has(g.id))
        .map((g) => {
          const capsHere = capsFor(snapshotLimits, user.id, g.id);
          const lg = liveGroups.get(g.id);
          return {
            groupId: g.id,
            groupName: g.name,
            rpm: {
              used: liveUser ? (lg?.rpmUsed ?? 0) : (estimated?.get(g.id) ?? 0),
              limit: capsHere.groupRpm,
              source: capsHere.groupRpmSource,
            },
            concurrency: { inFlight: liveUser ? (lg?.inFlight ?? 0) : null, limit: capsHere.groupConcurrency },
          };
        }),
    };
    return c.json(status);
  });

  /* ---------------- Admin: user list figures ---------------- */

  app.get("/api/v1/admin/user-stats/live", async (c) => {
    const ids = userIdsParam(c);
    const [settings, caps, live] = await Promise.all([store.ops.getSettings(), limits.getUserCaps(ids), netStats(ids)]);
    const byUser = new Map((live ?? []).map((s) => [s.userId, s]));
    const response: AdminUserLiveStatsResponse = {
      live: live !== null,
      items: [...caps.keys()].map((userId) => {
        const own = caps.get(userId);
        const s = byUser.get(userId);
        return {
          userId,
          inFlight: live ? (s?.inFlight ?? 0) : null,
          rpmUsed: live ? (s?.rpmUsed ?? 0) : null,
          concurrencyLimit: effectiveUserCap(own?.concurrencyLimit, settings.defaultUserConcurrency),
          rpmLimit: effectiveUserCap(own?.rpmLimit, settings.defaultUserRpm),
        };
      }),
    };
    return c.json(response);
  });

  app.get("/api/v1/admin/user-stats/usage", async (c) => {
    const ids = userIdsParam(c);
    const tz = intParam(c.req.query("tz"), 0, -840, 840);
    const nowMs = Date.now();
    const todayStartIso = new Date(viewerDayStartMs(nowMs, tz)).toISOString();
    const sinceMs = Math.min(Date.parse(todayStartIso), nowMs - USER_USAGE_TOTAL_WINDOW_DAYS * 86_400_000);
    const rows = await limits.userPlatformUsage(ids, new Date(sinceMs).toISOString(), todayStartIso);
    const perUser = new Map<string, { today: bigint; total: bigint; platforms: { platform: string; today: bigint; total: bigint }[] }>();
    for (const id of ids) perUser.set(id, { today: 0n, total: 0n, platforms: [] });
    for (const r of rows) {
      const u = perUser.get(r.userId);
      if (!u) continue;
      u.today += r.todayNano;
      u.total += r.totalNano;
      u.platforms.push({ platform: r.platform, today: r.todayNano, total: r.totalNano });
    }
    const response: AdminUserUsageStatsResponse = {
      windowDays: USER_USAGE_TOTAL_WINDOW_DAYS,
      todayStartIso,
      items: [...perUser.entries()].map(([userId, u]) => ({
        userId,
        todayNanoUsd: u.today.toString(),
        totalNanoUsd: u.total.toString(),
        byPlatform: u.platforms
          .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.platform.localeCompare(b.platform)))
          .map((p) => ({ platform: p.platform, todayNanoUsd: p.today.toString(), totalNanoUsd: p.total.toString() })),
      })),
    };
    return c.json(response);
  });

  /* ---------------- Admin: any user's API keys ---------------- */

  app.patch("/api/v1/admin/api-keys/:keyId", async (c) => {
    const keyId = c.req.param("keyId");
    const req = await body(c, AdminUpdateApiKeyRequestSchema);
    const owner = await limits.getApiKeyOwner(keyId);
    if (!owner) throw new StoreError("not_found", "API key not found");
    const item = await store.updateUserApiKey(owner.userId, keyId, req);
    let granted = false;
    if (req.groupId !== undefined) {
      const group = (await store.listGroups(false)).find((g) => g.id === req.groupId);
      const ownerUser = await store.ops.getAdminUser(owner.userId);
      // Linksyncx auto-grant: moving a key into an exclusive group gives its owner that group.
      if (group?.isExclusive && ownerUser && ownerUser.role !== "admin") {
        granted = await limits.grantGroup(owner.userId, group.id);
      }
    }
    await syncDataPlane();
    const response: AdminUpdateApiKeyResponse = {
      item,
      autoGrantedGroupAccess: granted,
      grantedGroupId: granted ? (req.groupId ?? null) : null,
    };
    return c.json(response);
  });

  app.post("/api/v1/admin/users/:userId/replace-group", async (c) => {
    const userId = c.req.param("userId");
    const req = await body(c, ReplaceUserGroupRequestSchema);
    const result = await limits.replaceUserGroup(userId, req.fromGroupId, req.toGroupId);
    await syncDataPlane();
    return c.json(result);
  });
}
