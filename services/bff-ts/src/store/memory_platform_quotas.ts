import type {
  DataPlaneBlockedPlatform,
  GroupPlatform,
  QuotaResetWindow,
  UpsertUserPlatformQuotaEntry,
  UsageLogItem,
  UserPlatformQuotaItem,
} from "@slipgate/contracts";
import {
  evaluatePlatformQuota,
  isZeroPlatformQuota,
  PLATFORM_QUOTA_WINDOWS_MS,
  type PlatformQuotasStore,
} from "./platform_quotas_types.ts";
import { StoreError, type StoredUserRecord } from "./types.ts";

export interface MemoryPlatformQuotasState {
  users: ReadonlyMap<string, StoredUserRecord>;
  usageLogs: readonly UsageLogItem[];
}

interface QuotaRecord {
  userId: string;
  platform: GroupPlatform;
  dailyLimitNanoUsd: string;
  weeklyLimitNanoUsd: string;
  monthlyLimitNanoUsd: string;
  dailyResetAtIso: string | null;
  weeklyResetAtIso: string | null;
  monthlyResetAtIso: string | null;
  updatedAtIso: string;
}

const keyOf = (userId: string, platform: string) => `${userId}\u0000${platform}`;

/** In-memory twin of PostgresPlatformQuotasStore (tests and DATABASE_URL-less runs). */
export class MemoryPlatformQuotasStore implements PlatformQuotasStore {
  private readonly records = new Map<string, QuotaRecord>();

  constructor(private readonly state: MemoryPlatformQuotasState) {}

  private prune(): void {
    for (const [k, rec] of this.records) {
      if (!this.state.users.has(rec.userId)) this.records.delete(k);
    }
  }

  private usageFor(rec: QuotaRecord, nowMs: number) {
    const sinceMonthly = nowMs - PLATFORM_QUOTA_WINDOWS_MS.monthly;
    const sinceWeekly = nowMs - PLATFORM_QUOTA_WINDOWS_MS.weekly;
    const sinceDaily = nowMs - PLATFORM_QUOTA_WINDOWS_MS.daily;
    const dailyReset = rec.dailyResetAtIso ? Date.parse(rec.dailyResetAtIso) : Number.NEGATIVE_INFINITY;
    const weeklyReset = rec.weeklyResetAtIso ? Date.parse(rec.weeklyResetAtIso) : Number.NEGATIVE_INFINITY;
    const monthlyReset = rec.monthlyResetAtIso ? Date.parse(rec.monthlyResetAtIso) : Number.NEGATIVE_INFINITY;

    let d = 0n;
    let w = 0n;
    let m = 0n;
    for (const log of this.state.usageLogs) {
      if (log.userId !== rec.userId || log.platform !== rec.platform) continue;
      const t = Date.parse(log.createdAtIso);
      if (t < sinceMonthly) continue;
      const cost = BigInt(log.costNanoUsd);
      if (t > monthlyReset) m += cost;
      if (t >= sinceWeekly && t > weeklyReset) w += cost;
      if (t >= sinceDaily && t > dailyReset) d += cost;
    }
    return {
      dailyNanoUsd: d.toString(),
      weeklyNanoUsd: w.toString(),
      monthlyNanoUsd: m.toString(),
    };
  }

  private toItem(rec: QuotaRecord, nowMs: number): UserPlatformQuotaItem {
    const limits = {
      dailyLimitNanoUsd: rec.dailyLimitNanoUsd,
      weeklyLimitNanoUsd: rec.weeklyLimitNanoUsd,
      monthlyLimitNanoUsd: rec.monthlyLimitNanoUsd,
    };
    const usage = this.usageFor(rec, nowMs);
    const status = evaluatePlatformQuota(limits, usage);
    return {
      userId: rec.userId,
      platform: rec.platform,
      ...limits,
      dailyUsedNanoUsd: usage.dailyNanoUsd,
      weeklyUsedNanoUsd: usage.weeklyNanoUsd,
      monthlyUsedNanoUsd: usage.monthlyNanoUsd,
      dailyResetAtIso: rec.dailyResetAtIso,
      weeklyResetAtIso: rec.weeklyResetAtIso,
      monthlyResetAtIso: rec.monthlyResetAtIso,
      overLimit: status.overLimit,
      overLimitWindow: status.overLimitWindow,
      updatedAtIso: rec.updatedAtIso,
    };
  }

  async listUserPlatformQuotas(userId: string): Promise<UserPlatformQuotaItem[]> {
    this.prune();
    const nowMs = Date.now();
    return Array.from(this.records.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0))
      .map((r) => this.toItem(r, nowMs));
  }

  async upsertUserPlatformQuotas(
    userId: string,
    entries: UpsertUserPlatformQuotaEntry[],
  ): Promise<UserPlatformQuotaItem[]> {
    this.prune();
    if (!this.state.users.has(userId)) throw new StoreError("not_found", `User ${userId} not found`);
    const nowIso = new Date().toISOString();
    const byPlatform = new Map<GroupPlatform, UpsertUserPlatformQuotaEntry>();
    for (const entry of entries) byPlatform.set(entry.platform, entry);

    for (const entry of byPlatform.values()) {
      const k = keyOf(userId, entry.platform);
      if (isZeroPlatformQuota(entry)) {
        this.records.delete(k);
        continue;
      }
      const prev = this.records.get(k);
      this.records.set(k, {
        userId,
        platform: entry.platform,
        dailyLimitNanoUsd: entry.dailyLimitNanoUsd,
        weeklyLimitNanoUsd: entry.weeklyLimitNanoUsd,
        monthlyLimitNanoUsd: entry.monthlyLimitNanoUsd,
        dailyResetAtIso: prev?.dailyResetAtIso ?? null,
        weeklyResetAtIso: prev?.weeklyResetAtIso ?? null,
        monthlyResetAtIso: prev?.monthlyResetAtIso ?? null,
        updatedAtIso: nowIso,
      });
    }
    return this.listUserPlatformQuotas(userId);
  }

  async deleteUserPlatformQuota(userId: string, platform: string): Promise<boolean> {
    this.prune();
    return this.records.delete(keyOf(userId, platform));
  }

  async resetUserPlatformQuotaWindow(
    userId: string,
    platform: string,
    window: QuotaResetWindow,
  ): Promise<UserPlatformQuotaItem> {
    this.prune();
    const rec = this.records.get(keyOf(userId, platform));
    if (!rec) throw new StoreError("not_found", `Platform quota not found for ${platform}`);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    if (window === "all" || window === "daily") rec.dailyResetAtIso = nowIso;
    if (window === "all" || window === "weekly") rec.weeklyResetAtIso = nowIso;
    if (window === "all" || window === "monthly") rec.monthlyResetAtIso = nowIso;
    rec.updatedAtIso = nowIso;
    return this.toItem(rec, nowMs);
  }

  async listCappedUserIds(): Promise<string[]> {
    this.prune();
    const out = new Set<string>();
    for (const rec of this.records.values()) {
      if (!isZeroPlatformQuota(rec)) out.add(rec.userId);
    }
    return [...out];
  }

  async listBlockedUserPlatforms(): Promise<DataPlaneBlockedPlatform[]> {
    this.prune();
    const nowMs = Date.now();
    const out: DataPlaneBlockedPlatform[] = [];
    for (const rec of Array.from(this.records.values()).sort((a, b) =>
      a.userId !== b.userId ? (a.userId < b.userId ? -1 : 1) : a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0,
    )) {
      if (isZeroPlatformQuota(rec)) continue;
      const item = this.toItem(rec, nowMs);
      if (item.overLimit && item.overLimitWindow) {
        out.push({
          userId: item.userId,
          platform: item.platform,
          window: item.overLimitWindow,
        });
      }
    }
    return out;
  }

  async isUserPlatformOverLimit(userId: string, platform: string): Promise<boolean> {
    this.prune();
    const rec = this.records.get(keyOf(userId, platform));
    if (!rec || isZeroPlatformQuota(rec)) return false;
    return this.toItem(rec, Date.now()).overLimit;
  }
}
