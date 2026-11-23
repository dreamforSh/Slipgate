import {
  USER_LIMIT_MAX,
  type AdminGroupApiKeyItem,
  type DataPlaneSyncUserLimits,
  type GroupItem,
  type UsageLogItem,
  type UserGroupRateEntry,
} from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import type { OpsStore } from "./ops_types.ts";
import { StoreError, type StoredUserRecord } from "./types.ts";
import {
  normalizeRate,
  type UserCaps,
  type UserCapsPatch,
  type UserGroupRateRow,
  type UserLimitsStore,
  type UserPlatformUsageRow,
  type UserTargets,
} from "./user_limits_types.ts";

/** The key fields this store reads from MemoryControlStore's key records (same objects). */
export interface MemoryLimitKeyView {
  id: string;
  name: string;
  userId: string;
  groupId: string;
  keyPrefix: string;
  enabled: boolean;
  rpmLimit: number;
  concurrencyLimit: number;
  quotaNanoUsd: string;
  spentNanoUsd: string;
  expiresAtIso: string | null;
  lastUsedAtIso: string | null;
  createdAtIso: string;
}

type GroupView = Pick<GroupItem, "id" | "enabled" | "isExclusive" | "subscriptionType" | "rpmLimit" | "concurrencyLimit">;

export interface MemoryUserLimitsState {
  users: ReadonlyMap<string, StoredUserRecord>;
  groups: ReadonlyMap<string, GroupView>;
  apiKeys: ReadonlyMap<string, MemoryLimitKeyView>;
  usageLogs: readonly UsageLogItem[];
  /** allowedGroupIds and notes live in the ops store. */
  ops: () => OpsStore;
}

interface RateRecord {
  rateMultiplier: number | null;
  rpmOverride: number | null;
  updatedAtIso: string;
}

const pairKey = (userId: string, groupId: string) => `${userId}\u0000${groupId}`;

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(key(it), it);
  return [...map.values()];
}

/** In-memory twin of PostgresUserLimitsStore (tests and DATABASE_URL-less runs). */
export class MemoryUserLimitsStore implements UserLimitsStore {
  private readonly caps = new Map<string, UserCaps & { updatedAtIso: string }>();
  /** pairKey(user, group) -> custom settings. */
  private readonly rates = new Map<string, RateRecord & { userId: string; groupId: string }>();

  constructor(private readonly state: MemoryUserLimitsState) {}

  /** Postgres cascades deletes; here rows of deleted users or groups are dropped on access. */
  private prune(): void {
    for (const id of this.caps.keys()) if (!this.state.users.has(id)) this.caps.delete(id);
    for (const [k, r] of this.rates) {
      if (!this.state.users.has(r.userId) || !this.state.groups.has(r.groupId)) this.rates.delete(k);
    }
  }

  private targets(targets: UserTargets): string[] {
    if ("all" in targets) return [...this.state.users.keys()];
    return [...new Set(targets.userIds)].filter((id) => this.state.users.has(id));
  }

  private requireGroup(groupId: string): void {
    if (!this.state.groups.has(groupId)) throw new StoreError("not_found", `Group ${groupId} not found`);
  }

  private requireUsers(userIds: string[]): void {
    const missing = userIds.filter((id) => !this.state.users.has(id));
    if (missing.length > 0) throw new StoreError("bad_request", `Unknown user id(s): ${missing.slice(0, 5).join(", ")}`);
  }

  private dropEmpty(): void {
    for (const [k, r] of this.rates) if (r.rateMultiplier === null && r.rpmOverride === null) this.rates.delete(k);
    for (const [id, c] of this.caps) if (c.rpmLimit === null && c.concurrencyLimit === null) this.caps.delete(id);
  }

  /* ---------------- User caps ---------------- */

  async getUserCaps(userIds: string[]): Promise<Map<string, UserCaps>> {
    this.prune();
    const out = new Map<string, UserCaps>();
    for (const id of new Set(userIds)) {
      if (!this.state.users.has(id)) continue;
      const c = this.caps.get(id);
      out.set(id, { rpmLimit: c?.rpmLimit ?? null, concurrencyLimit: c?.concurrencyLimit ?? null });
    }
    return out;
  }

  async setUserCaps(targets: UserTargets, patch: UserCapsPatch): Promise<number> {
    this.prune();
    if (patch.rpmLimit === undefined && patch.concurrencyLimit === undefined) return 0;
    const ids = this.targets(targets);
    const now = new Date().toISOString();
    for (const id of ids) {
      const cur = this.caps.get(id) ?? { rpmLimit: null, concurrencyLimit: null, updatedAtIso: now };
      if (patch.rpmLimit !== undefined) cur.rpmLimit = patch.rpmLimit;
      if (patch.concurrencyLimit !== undefined) cur.concurrencyLimit = patch.concurrencyLimit;
      cur.updatedAtIso = now;
      this.caps.set(id, cur);
    }
    this.dropEmpty();
    return ids.length;
  }

  async addUserConcurrency(targets: UserTargets, delta: number, fallback: number): Promise<number> {
    this.prune();
    const ids = this.targets(targets);
    const now = new Date().toISOString();
    for (const id of ids) {
      const cur = this.caps.get(id) ?? { rpmLimit: null, concurrencyLimit: null, updatedAtIso: now };
      const base = cur.concurrencyLimit ?? Math.max(0, fallback);
      cur.concurrencyLimit = Math.min(USER_LIMIT_MAX, Math.max(0, base + delta));
      cur.updatedAtIso = now;
      this.caps.set(id, cur);
    }
    return ids.length;
  }

  async lastApiUse(userIds: string[]): Promise<Map<string, string>> {
    const wanted = new Set(userIds);
    const out = new Map<string, string>();
    for (const k of this.state.apiKeys.values()) {
      if (!wanted.has(k.userId) || !k.lastUsedAtIso) continue;
      const cur = out.get(k.userId);
      if (!cur || Date.parse(k.lastUsedAtIso) > Date.parse(cur)) out.set(k.userId, k.lastUsedAtIso);
    }
    return out;
  }

  /* ---------------- Per-user group rates ---------------- */

  async listGroupRates(groupId: string): Promise<UserGroupRateEntry[]> {
    this.prune();
    this.requireGroup(groupId);
    const out: UserGroupRateEntry[] = [];
    for (const r of this.rates.values()) {
      if (r.groupId !== groupId) continue;
      const u = this.state.users.get(r.userId)!;
      const admin = await this.state.ops().getAdminUser(r.userId);
      out.push({
        userId: r.userId,
        email: u.email,
        username: u.username ?? "",
        notes: admin?.notes ?? "",
        status: u.status === "suspended" ? "suspended" : "active",
        rateMultiplier: r.rateMultiplier,
        rpmOverride: r.rpmOverride,
        updatedAtIso: r.updatedAtIso,
      });
    }
    return out.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  }

  private upsert(userId: string, groupId: string, now: string): RateRecord {
    const key = pairKey(userId, groupId);
    let rec = this.rates.get(key);
    if (!rec) {
      rec = { userId, groupId, rateMultiplier: null, rpmOverride: null, updatedAtIso: now };
      this.rates.set(key, rec);
    }
    return rec;
  }

  async syncGroupRateMultipliers(groupId: string, entries: { userId: string; rateMultiplier: number }[]): Promise<number> {
    this.prune();
    this.requireGroup(groupId);
    const list = dedupeBy(entries, (e) => e.userId);
    this.requireUsers(list.map((e) => e.userId));
    const now = new Date().toISOString();
    const kept = new Set(list.map((e) => e.userId));
    for (const r of this.rates.values()) {
      if (r.groupId === groupId && r.rateMultiplier !== null && !kept.has(r.userId)) {
        r.rateMultiplier = null;
        r.updatedAtIso = now;
      }
    }
    for (const e of list) {
      const rec = this.upsert(e.userId, groupId, now);
      rec.rateMultiplier = normalizeRate(e.rateMultiplier);
      rec.updatedAtIso = now;
    }
    this.dropEmpty();
    return list.length;
  }

  async syncGroupRpmOverrides(groupId: string, entries: { userId: string; rpmOverride: number | null }[]): Promise<number> {
    this.prune();
    this.requireGroup(groupId);
    this.requireUsers([...new Set(entries.map((e) => e.userId))]);
    const list = dedupeBy(entries, (e) => e.userId).filter(
      (e): e is { userId: string; rpmOverride: number } => e.rpmOverride !== null,
    );
    const now = new Date().toISOString();
    const kept = new Set(list.map((e) => e.userId));
    for (const r of this.rates.values()) {
      if (r.groupId === groupId && r.rpmOverride !== null && !kept.has(r.userId)) {
        r.rpmOverride = null;
        r.updatedAtIso = now;
      }
    }
    for (const e of list) {
      const rec = this.upsert(e.userId, groupId, now);
      rec.rpmOverride = e.rpmOverride;
      rec.updatedAtIso = now;
    }
    this.dropEmpty();
    return list.length;
  }

  async clearGroupRates(groupId: string, kind: "rate" | "rpm"): Promise<number> {
    this.prune();
    this.requireGroup(groupId);
    const now = new Date().toISOString();
    let n = 0;
    for (const r of this.rates.values()) {
      if (r.groupId !== groupId) continue;
      if (kind === "rate" && r.rateMultiplier !== null) {
        r.rateMultiplier = null;
        r.updatedAtIso = now;
        n++;
      } else if (kind === "rpm" && r.rpmOverride !== null) {
        r.rpmOverride = null;
        r.updatedAtIso = now;
        n++;
      }
    }
    this.dropEmpty();
    return n;
  }

  async listUserGroupRates(userId: string): Promise<UserGroupRateRow[]> {
    this.prune();
    return [...this.rates.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
      .map((r) => ({ userId, groupId: r.groupId, rateMultiplier: r.rateMultiplier, rpmOverride: r.rpmOverride }));
  }

  async setUserGroupRates(
    userId: string,
    patch: { rates?: Record<string, number | null>; rpmOverrides?: Record<string, number | null> },
  ): Promise<void> {
    this.prune();
    if (!this.state.users.has(userId)) throw new StoreError("not_found", `User ${userId} not found`);
    const rates = patch.rates ?? {};
    const rpms = patch.rpmOverrides ?? {};
    const groupIds = [...new Set([...Object.keys(rates), ...Object.keys(rpms)])];
    const missing = groupIds.filter((g) => !this.state.groups.has(g));
    if (missing.length > 0) throw new StoreError("bad_request", `Unknown group id(s): ${missing.slice(0, 5).join(", ")}`);
    const now = new Date().toISOString();
    for (const groupId of groupIds) {
      const rec = this.upsert(userId, groupId, now);
      if (Object.prototype.hasOwnProperty.call(rates, groupId)) {
        const v = rates[groupId];
        rec.rateMultiplier = v === null || v === undefined ? null : normalizeRate(v);
      }
      if (Object.prototype.hasOwnProperty.call(rpms, groupId)) rec.rpmOverride = rpms[groupId] ?? null;
      rec.updatedAtIso = now;
    }
    this.dropEmpty();
  }

  async listRateOverrides(): Promise<UserGroupRateRow[]> {
    this.prune();
    return [...this.rates.values()]
      .filter((r) => r.rateMultiplier !== null)
      .map((r) => ({ userId: r.userId, groupId: r.groupId, rateMultiplier: r.rateMultiplier, rpmOverride: r.rpmOverride }));
  }

  /* ---------------- Data plane ---------------- */

  async exportUserLimits(defaults: { rpm: number; concurrency: number }): Promise<DataPlaneSyncUserLimits> {
    this.prune();
    const byId = <T>(get: (t: T) => string) => (a: T, b: T) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0);
    return {
      defaultRpmLimit: Math.max(0, defaults.rpm),
      defaultConcurrencyLimit: Math.max(0, defaults.concurrency),
      users: [...this.caps.entries()]
        .filter(([, c]) => c.rpmLimit !== null || c.concurrencyLimit !== null)
        .map(([userId, c]) => ({ userId, rpmLimit: c.rpmLimit, concurrencyLimit: c.concurrencyLimit }))
        .sort(byId((u) => u.userId)),
      groups: [...this.state.groups.values()]
        .filter((g) => g.rpmLimit > 0 || g.concurrencyLimit > 0)
        .map((g) => ({ groupId: g.id, rpmLimit: g.rpmLimit, concurrencyLimit: g.concurrencyLimit }))
        .sort(byId((g) => g.groupId)),
      overrides: [...this.rates.values()]
        .map((r) => ({ userId: r.userId, groupId: r.groupId, rpmOverride: r.rpmOverride, rateMultiplier: r.rateMultiplier }))
        .sort(byId((o) => pairKey(o.userId, o.groupId))),
    };
  }

  /* ---------------- Usage figures ---------------- */

  async userPlatformUsage(userIds: string[], sinceIso: string, todayStartIso: string): Promise<UserPlatformUsageRow[]> {
    const wanted = new Set(userIds);
    const since = Date.parse(sinceIso);
    const today = Date.parse(todayStartIso);
    const sums = new Map<string, UserPlatformUsageRow>();
    for (const l of this.state.usageLogs) {
      if (!wanted.has(l.userId)) continue;
      const at = Date.parse(l.createdAtIso);
      if (at < since) continue;
      const key = pairKey(l.userId, l.platform);
      let row = sums.get(key);
      if (!row) {
        row = { userId: l.userId, platform: l.platform, todayNano: 0n, totalNano: 0n };
        sums.set(key, row);
      }
      const cost = BigInt(l.costNanoUsd);
      row.totalNano += cost;
      if (at >= today) row.todayNano += cost;
    }
    return [...sums.values()];
  }

  async requestsSince(userId: string, sinceIso: string): Promise<Map<string, number>> {
    const since = Date.parse(sinceIso);
    const out = new Map<string, number>();
    for (const l of this.state.usageLogs) {
      if (l.userId !== userId || Date.parse(l.createdAtIso) < since) continue;
      out.set(l.groupId, (out.get(l.groupId) ?? 0) + 1);
    }
    return out;
  }

  /* ---------------- Keys across owners ---------------- */

  async getApiKeyOwner(keyId: string): Promise<{ userId: string; groupId: string } | null> {
    const k = this.state.apiKeys.get(keyId);
    return k ? { userId: k.userId, groupId: k.groupId } : null;
  }

  async listGroupApiKeys(groupId: string, page: number, pageSize: number): Promise<{ items: AdminGroupApiKeyItem[]; total: number }> {
    this.requireGroup(groupId);
    const all = [...this.state.apiKeys.values()]
      .filter((k) => k.groupId === groupId)
      .sort((a, b) => (a.createdAtIso !== b.createdAtIso ? (a.createdAtIso < b.createdAtIso ? 1 : -1) : a.id < b.id ? -1 : 1));
    const { offset, limit } = clampPage(page, pageSize);
    return {
      items: all.slice(offset, offset + limit).map((k) => ({
        id: k.id,
        name: k.name,
        userId: k.userId,
        userEmail: this.state.users.get(k.userId)?.email ?? "",
        keyPrefix: k.keyPrefix,
        enabled: k.enabled,
        rpmLimit: k.rpmLimit,
        concurrencyLimit: k.concurrencyLimit,
        quotaNanoUsd: k.quotaNanoUsd,
        spentNanoUsd: k.spentNanoUsd,
        expiresAtIso: k.expiresAtIso,
        lastUsedAtIso: k.lastUsedAtIso ?? null,
        createdAtIso: k.createdAtIso,
      })),
      total: all.length,
    };
  }

  async grantGroup(userId: string, groupId: string): Promise<boolean> {
    const ops = this.state.ops();
    const user = await ops.getAdminUser(userId);
    if (!user) throw new StoreError("not_found", `User ${userId} not found`);
    if (user.allowedGroupIds.includes(groupId)) return false;
    await ops.updateUser(userId, { allowedGroupIds: [...user.allowedGroupIds, groupId] });
    return true;
  }

  async replaceUserGroup(userId: string, fromGroupId: string, toGroupId: string): Promise<{ migratedKeys: number; allowedGroupIds: string[] }> {
    if (fromGroupId === toGroupId) throw new StoreError("bad_request", "The groups must differ");
    const ops = this.state.ops();
    const user = await ops.getAdminUser(userId);
    if (!user) throw new StoreError("not_found", `User ${userId} not found`);
    const target = this.state.groups.get(toGroupId);
    if (!target) throw new StoreError("not_found", `Group ${toGroupId} not found`);
    if (!target.enabled) throw new StoreError("bad_request", "The target group is disabled");
    if (!target.isExclusive) throw new StoreError("bad_request", "The target group is not exclusive");
    if (target.subscriptionType === "subscription") {
      throw new StoreError("bad_request", "Subscription groups cannot be the target of a group replacement");
    }
    let migratedKeys = 0;
    for (const k of this.state.apiKeys.values()) {
      if (k.userId === userId && k.groupId === fromGroupId) {
        k.groupId = toGroupId;
        migratedKeys++;
      }
    }
    const allowed = user.allowedGroupIds.filter((g) => g !== fromGroupId && g !== toGroupId);
    allowed.push(toGroupId);
    await ops.updateUser(userId, { allowedGroupIds: allowed });
    return { migratedKeys, allowedGroupIds: allowed };
  }
}
