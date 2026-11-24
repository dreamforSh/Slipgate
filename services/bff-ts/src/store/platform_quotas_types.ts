import type {
  DataPlaneBlockedPlatform,
  QuotaResetWindow,
  QuotaWindowKind,
  UpsertUserPlatformQuotaEntry,
  UserPlatformQuotaItem,
} from "@slipgate/contracts";

/** Rolling window durations in milliseconds (daily / weekly / monthly). */
export const PLATFORM_QUOTA_WINDOWS_MS = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
} as const;

export interface PlatformQuotaUsage {
  dailyNanoUsd: string;
  weeklyNanoUsd: string;
  monthlyNanoUsd: string;
}

export interface PlatformQuotaLimits {
  dailyLimitNanoUsd: string;
  weeklyLimitNanoUsd: string;
  monthlyLimitNanoUsd: string;
}

/** Evaluates whether any non-zero platform cap is reached and which window triggered first. */
export function evaluatePlatformQuota(
  limits: PlatformQuotaLimits,
  usage: PlatformQuotaUsage,
): { overLimit: boolean; overLimitWindow: QuotaWindowKind | null } {
  const checks: [QuotaWindowKind, string, string][] = [
    ["daily", limits.dailyLimitNanoUsd, usage.dailyNanoUsd],
    ["weekly", limits.weeklyLimitNanoUsd, usage.weeklyNanoUsd],
    ["monthly", limits.monthlyLimitNanoUsd, usage.monthlyNanoUsd],
  ];
  for (const [window, limit, used] of checks) {
    const cap = BigInt(limit);
    if (cap > 0n && BigInt(used) >= cap) {
      return { overLimit: true, overLimitWindow: window };
    }
  }
  return { overLimit: false, overLimitWindow: null };
}

/** True when all three platform spend limits are zero (row can be pruned). */
export function isZeroPlatformQuota(entry: PlatformQuotaLimits): boolean {
  return (
    BigInt(entry.dailyLimitNanoUsd) === 0n &&
    BigInt(entry.weeklyLimitNanoUsd) === 0n &&
    BigInt(entry.monthlyLimitNanoUsd) === 0n
  );
}

/** Per-user per-platform quota persistence (Lane U2). */
export interface PlatformQuotasStore {
  listUserPlatformQuotas(userId: string): Promise<UserPlatformQuotaItem[]>;
  upsertUserPlatformQuotas(userId: string, entries: UpsertUserPlatformQuotaEntry[]): Promise<UserPlatformQuotaItem[]>;
  deleteUserPlatformQuota(userId: string, platform: string): Promise<boolean>;
  resetUserPlatformQuotaWindow(userId: string, platform: string, window: QuotaResetWindow): Promise<UserPlatformQuotaItem>;
  /** User IDs that currently hold at least one non-zero platform cap (settlement cache). */
  listCappedUserIds(): Promise<string[]>;
  /** All (user, platform) pairs currently breaching any configured daily/weekly/monthly cap. */
  listBlockedUserPlatforms(): Promise<DataPlaneBlockedPlatform[]>;
  /** Fast single-pair breach check used on the settlement path. */
  isUserPlatformOverLimit(userId: string, platform: string): Promise<boolean>;
}
