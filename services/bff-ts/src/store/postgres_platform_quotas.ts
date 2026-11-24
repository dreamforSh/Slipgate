import type postgres from "postgres";
import type {
  DataPlaneBlockedPlatform,
  GroupPlatform,
  QuotaResetWindow,
  UpsertUserPlatformQuotaEntry,
  UserPlatformQuotaItem,
} from "@slipgate/contracts";
import {
  evaluatePlatformQuota,
  isZeroPlatformQuota,
  type PlatformQuotasStore,
} from "./platform_quotas_types.ts";
import { StoreError } from "./types.ts";

type Sql = ReturnType<typeof postgres>;

/**
 * Startup mirror of migrations/core/0013_platform_quotas.sql (idempotent, cheap).
 * Runs inside PostgresControlStore.init() after PG_OPS_SCHEMA_SQL.
 */
export const PG_PLATFORM_QUOTAS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS core.user_platform_quotas (
      user_id                 TEXT NOT NULL,
      platform                TEXT NOT NULL,
      daily_limit_nano_usd    NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (daily_limit_nano_usd >= 0),
      weekly_limit_nano_usd   NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (weekly_limit_nano_usd >= 0),
      monthly_limit_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (monthly_limit_nano_usd >= 0),
      daily_reset_at          TIMESTAMPTZ,
      weekly_reset_at         TIMESTAMPTZ,
      monthly_reset_at        TIMESTAMPTZ,
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_core_user_platform_quotas_user
      ON core.user_platform_quotas (user_id);

  ALTER TABLE commerce.subscriptions
      ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS weekly_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ;
`;

interface PlatformQuotaRow {
  user_id: string;
  platform: GroupPlatform;
  daily_limit: string;
  weekly_limit: string;
  monthly_limit: string;
  daily_reset_at: Date | null;
  weekly_reset_at: Date | null;
  monthly_reset_at: Date | null;
  updated_at: Date;
  daily_used: string;
  weekly_used: string;
  monthly_used: string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  return v ? iso(v) : null;
}

export class PostgresPlatformQuotasStore implements PlatformQuotasStore {
  constructor(private readonly sql: Sql) {}

  private toItem(r: PlatformQuotaRow): UserPlatformQuotaItem {
    const limits = {
      dailyLimitNanoUsd: r.daily_limit ?? "0",
      weeklyLimitNanoUsd: r.weekly_limit ?? "0",
      monthlyLimitNanoUsd: r.monthly_limit ?? "0",
    };
    const usage = {
      dailyNanoUsd: r.daily_used ?? "0",
      weeklyNanoUsd: r.weekly_used ?? "0",
      monthlyNanoUsd: r.monthly_used ?? "0",
    };
    const status = evaluatePlatformQuota(limits, usage);
    return {
      userId: r.user_id,
      platform: r.platform,
      ...limits,
      dailyUsedNanoUsd: usage.dailyNanoUsd,
      weeklyUsedNanoUsd: usage.weeklyNanoUsd,
      monthlyUsedNanoUsd: usage.monthlyNanoUsd,
      dailyResetAtIso: isoOrNull(r.daily_reset_at),
      weeklyResetAtIso: isoOrNull(r.weekly_reset_at),
      monthlyResetAtIso: isoOrNull(r.monthly_reset_at),
      overLimit: status.overLimit,
      overLimitWindow: status.overLimitWindow,
      updatedAtIso: iso(r.updated_at),
    };
  }

  private async queryQuotas(userId: string | null, platform?: string): Promise<PlatformQuotaRow[]> {
    return this.sql<PlatformQuotaRow[]>`
      SELECT q.user_id, q.platform,
             q.daily_limit_nano_usd::text AS daily_limit,
             q.weekly_limit_nano_usd::text AS weekly_limit,
             q.monthly_limit_nano_usd::text AS monthly_limit,
             q.daily_reset_at, q.weekly_reset_at, q.monthly_reset_at, q.updated_at,
             COALESCE(x.d, 0)::text AS daily_used,
             COALESCE(x.w, 0)::text AS weekly_used,
             COALESCE(x.m, 0)::text AS monthly_used
        FROM core.user_platform_quotas q
        LEFT JOIN LATERAL (
          SELECT SUM(l.cost_nano_usd) FILTER (
                   WHERE l.created_at >= NOW() - INTERVAL '1 day'
                     AND (q.daily_reset_at IS NULL OR l.created_at > q.daily_reset_at)
                 ) AS d,
                 SUM(l.cost_nano_usd) FILTER (
                   WHERE l.created_at >= NOW() - INTERVAL '7 days'
                     AND (q.weekly_reset_at IS NULL OR l.created_at > q.weekly_reset_at)
                 ) AS w,
                 SUM(l.cost_nano_usd) FILTER (
                   WHERE (q.monthly_reset_at IS NULL OR l.created_at > q.monthly_reset_at)
                 ) AS m
            FROM core.usage_logs l
           WHERE l.user_id = q.user_id
             AND l.platform = q.platform
             AND l.created_at >= NOW() - INTERVAL '30 days'
             AND (q.daily_limit_nano_usd > 0 OR q.weekly_limit_nano_usd > 0 OR q.monthly_limit_nano_usd > 0)
        ) x ON (q.daily_limit_nano_usd > 0 OR q.weekly_limit_nano_usd > 0 OR q.monthly_limit_nano_usd > 0)
       WHERE (${userId}::text IS NULL OR q.user_id = ${userId})
         AND (${platform ?? null}::text IS NULL OR q.platform = ${platform ?? null})
         ${userId === null ? this.sql`AND (q.daily_limit_nano_usd > 0 OR q.weekly_limit_nano_usd > 0 OR q.monthly_limit_nano_usd > 0)` : this.sql``}
       ORDER BY q.user_id ASC, q.platform ASC
    `;
  }

  async listUserPlatformQuotas(userId: string): Promise<UserPlatformQuotaItem[]> {
    const rows = await this.queryQuotas(userId);
    return rows.map((r) => this.toItem(r));
  }

  async upsertUserPlatformQuotas(
    userId: string,
    entries: UpsertUserPlatformQuotaEntry[],
  ): Promise<UserPlatformQuotaItem[]> {
    const byPlatform = new Map<GroupPlatform, UpsertUserPlatformQuotaEntry>();
    for (const entry of entries) byPlatform.set(entry.platform, entry);

    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const exists = await tx`SELECT 1 FROM commerce.users WHERE id = ${userId} FOR SHARE`;
      if (exists.length === 0) throw new StoreError("not_found", `User ${userId} not found`);

      for (const entry of byPlatform.values()) {
        if (isZeroPlatformQuota(entry)) {
          await tx`
            DELETE FROM core.user_platform_quotas
             WHERE user_id = ${userId} AND platform = ${entry.platform}
          `;
          continue;
        }
        await tx`
          INSERT INTO core.user_platform_quotas (
            user_id, platform, daily_limit_nano_usd, weekly_limit_nano_usd, monthly_limit_nano_usd, updated_at
          )
          VALUES (
            ${userId}, ${entry.platform},
            ${entry.dailyLimitNanoUsd}::numeric, ${entry.weeklyLimitNanoUsd}::numeric,
            ${entry.monthlyLimitNanoUsd}::numeric, NOW()
          )
          ON CONFLICT (user_id, platform) DO UPDATE
             SET daily_limit_nano_usd = EXCLUDED.daily_limit_nano_usd,
                 weekly_limit_nano_usd = EXCLUDED.weekly_limit_nano_usd,
                 monthly_limit_nano_usd = EXCLUDED.monthly_limit_nano_usd,
                 updated_at = NOW()
        `;
      }
    });
    return this.listUserPlatformQuotas(userId);
  }

  async deleteUserPlatformQuota(userId: string, platform: string): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM core.user_platform_quotas
       WHERE user_id = ${userId} AND platform = ${platform}
      RETURNING platform
    `;
    return rows.length > 0;
  }

  async resetUserPlatformQuotaWindow(
    userId: string,
    platform: string,
    window: QuotaResetWindow,
  ): Promise<UserPlatformQuotaItem> {
    const rows = await this.sql`
      UPDATE core.user_platform_quotas
         SET daily_reset_at = CASE WHEN ${window === "all" || window === "daily"} THEN NOW() ELSE daily_reset_at END,
             weekly_reset_at = CASE WHEN ${window === "all" || window === "weekly"} THEN NOW() ELSE weekly_reset_at END,
             monthly_reset_at = CASE WHEN ${window === "all" || window === "monthly"} THEN NOW() ELSE monthly_reset_at END,
             updated_at = NOW()
       WHERE user_id = ${userId} AND platform = ${platform}
      RETURNING platform
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Platform quota not found for ${platform}`);
    }
    const items = await this.queryQuotas(userId, platform);
    if (!items[0]) throw new StoreError("not_found", `Platform quota not found for ${platform}`);
    return this.toItem(items[0]);
  }

  async listCappedUserIds(): Promise<string[]> {
    const rows = await this.sql<{ user_id: string }[]>`
      SELECT DISTINCT user_id
        FROM core.user_platform_quotas
       WHERE daily_limit_nano_usd > 0 OR weekly_limit_nano_usd > 0 OR monthly_limit_nano_usd > 0
    `;
    return rows.map((r) => r.user_id);
  }

  async listBlockedUserPlatforms(): Promise<DataPlaneBlockedPlatform[]> {
    const rows = await this.queryQuotas(null);
    const out: DataPlaneBlockedPlatform[] = [];
    for (const r of rows) {
      const item = this.toItem(r);
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
    const rows = await this.queryQuotas(userId, platform);
    if (!rows[0]) return false;
    return this.toItem(rows[0]).overLimit;
  }
}
