import type postgres from "postgres";
import {
  USER_LIMIT_MAX,
  type AdminGroupApiKeyItem,
  type DataPlaneSyncUserLimits,
  type UserGroupRateEntry,
} from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import { pgReadWithTimeout } from "./postgres_ops.ts";
import { StoreError } from "./types.ts";
import {
  normalizeRate,
  type UserCaps,
  type UserCapsPatch,
  type UserGroupRateRow,
  type UserLimitsStore,
  type UserPlatformUsageRow,
  type UserTargets,
} from "./user_limits_types.ts";

type Sql = ReturnType<typeof postgres>;

/**
 * Startup copy of migrations/core/0011_user_limits.sql (idempotent, cheap: no usage_logs index
 * builds). Applied from PostgresControlStore.init() so databases created before lane U1 get the
 * tables and columns without re-running the migration files.
 */
export const PG_USER_LIMITS_SCHEMA_SQL = `
  ALTER TABLE core.groups
      ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS concurrency_limit INTEGER NOT NULL DEFAULT 0;

  DO $$
  BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_core_groups_user_caps') THEN
          ALTER TABLE core.groups
              ADD CONSTRAINT chk_core_groups_user_caps CHECK (rpm_limit >= 0 AND concurrency_limit >= 0);
      END IF;
  END $$;

  CREATE TABLE IF NOT EXISTS core.user_limits (
      user_id             TEXT PRIMARY KEY REFERENCES commerce.users(id) ON DELETE CASCADE,
      rpm_limit           INTEGER CHECK (rpm_limit IS NULL OR rpm_limit >= 0),
      concurrency_limit   INTEGER CHECK (concurrency_limit IS NULL OR concurrency_limit >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS core.user_group_rates (
      user_id             TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
      rate_multiplier     NUMERIC(12, 6) CHECK (rate_multiplier IS NULL OR (rate_multiplier > 0 AND rate_multiplier <= 100)),
      rpm_override        INTEGER CHECK (rpm_override IS NULL OR rpm_override >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, group_id)
  );

  CREATE INDEX IF NOT EXISTS idx_core_user_group_rates_group
      ON core.user_group_rates (group_id);

  CREATE INDEX IF NOT EXISTS idx_core_api_keys_group_user
      ON core.api_keys (group_id, user_id);
`;

/** The usage figures of the admin user list give up after this long (never block the page). */
const USAGE_READ_TIMEOUT_MS = 5_000;

function iso(v: Date | string | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  return v ? iso(v) : null;
}

/** allowed_group_ids as written by every build (older ones double-encoded the JSON). */
function stringArray(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(key(it), it);
  return [...map.values()];
}

function byKey<T>(get: (t: T) => string) {
  return (a: T, b: T) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0);
}

function targetIds(targets: UserTargets): { all: boolean; ids: string[] } {
  return "all" in targets ? { all: true, ids: [] } : { all: false, ids: [...new Set(targets.userIds)] };
}

export class PostgresUserLimitsStore implements UserLimitsStore {
  constructor(private readonly sql: Sql) {}

  /* ---------------- User caps ---------------- */

  async getUserCaps(userIds: string[]): Promise<Map<string, UserCaps>> {
    const ids = [...new Set(userIds)];
    const out = new Map<string, UserCaps>();
    if (ids.length === 0) return out;
    const rows = await this.sql<{ id: string; rpm_limit: number | null; concurrency_limit: number | null }[]>`
      SELECT u.id, l.rpm_limit, l.concurrency_limit
        FROM commerce.users u
        LEFT JOIN core.user_limits l ON l.user_id = u.id
       WHERE u.id = ANY(${ids}::text[])
    `;
    for (const r of rows) out.set(r.id, { rpmLimit: r.rpm_limit, concurrencyLimit: r.concurrency_limit });
    return out;
  }

  async setUserCaps(targets: UserTargets, patch: UserCapsPatch): Promise<number> {
    const { all, ids } = targetIds(targets);
    if (!all && ids.length === 0) return 0;
    const rpmSent = patch.rpmLimit !== undefined;
    const concSent = patch.concurrencyLimit !== undefined;
    if (!rpmSent && !concSent) return 0;
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<{ user_id: string }[]>`
        INSERT INTO core.user_limits (user_id, rpm_limit, concurrency_limit, updated_at)
        SELECT u.id, ${patch.rpmLimit ?? null}::int, ${patch.concurrencyLimit ?? null}::int, NOW()
          FROM commerce.users u
         WHERE (${all} OR u.id = ANY(${ids}::text[]))
        ON CONFLICT (user_id) DO UPDATE
           SET rpm_limit = CASE WHEN ${rpmSent} THEN EXCLUDED.rpm_limit ELSE core.user_limits.rpm_limit END,
               concurrency_limit = CASE WHEN ${concSent} THEN EXCLUDED.concurrency_limit ELSE core.user_limits.concurrency_limit END,
               updated_at = NOW()
        RETURNING user_id
      `;
      await tx`DELETE FROM core.user_limits WHERE rpm_limit IS NULL AND concurrency_limit IS NULL`;
      return rows.length;
    });
  }

  async addUserConcurrency(targets: UserTargets, delta: number, fallback: number): Promise<number> {
    const { all, ids } = targetIds(targets);
    if (!all && ids.length === 0) return 0;
    const rows = await this.sql<{ user_id: string }[]>`
      INSERT INTO core.user_limits (user_id, rpm_limit, concurrency_limit, updated_at)
      SELECT u.id, l.rpm_limit,
             LEAST(${USER_LIMIT_MAX}::int, GREATEST(0, COALESCE(l.concurrency_limit, ${Math.max(0, fallback)}::int) + ${delta}::int)),
             NOW()
        FROM commerce.users u
        LEFT JOIN core.user_limits l ON l.user_id = u.id
       WHERE (${all} OR u.id = ANY(${ids}::text[]))
      ON CONFLICT (user_id) DO UPDATE
         SET concurrency_limit = EXCLUDED.concurrency_limit, updated_at = NOW()
      RETURNING user_id
    `;
    return rows.length;
  }

  async lastApiUse(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.sql<{ user_id: string; last: Date }[]>`
      SELECT user_id, MAX(last_used_at) AS last
        FROM core.api_keys
       WHERE user_id = ANY(${ids}::text[]) AND last_used_at IS NOT NULL
       GROUP BY user_id
    `;
    for (const r of rows) out.set(r.user_id, iso(r.last));
    return out;
  }

  /* ---------------- Per-user group rates ---------------- */

  private async requireGroup(tx: Sql, groupId: string, lock = false): Promise<void> {
    const rows = lock
      ? await tx`SELECT 1 FROM core.groups WHERE id = ${groupId} FOR SHARE`
      : await tx`SELECT 1 FROM core.groups WHERE id = ${groupId}`;
    if (rows.length === 0) throw new StoreError("not_found", `Group ${groupId} not found`);
  }

  private async requireUsers(tx: Sql, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await tx<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ANY(${userIds}::text[]) FOR SHARE`;
    const known = new Set(rows.map((r) => r.id));
    const missing = userIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new StoreError("bad_request", `Unknown user id(s): ${missing.slice(0, 5).join(", ")}`);
    }
  }

  async listGroupRates(groupId: string): Promise<UserGroupRateEntry[]> {
    await this.requireGroup(this.sql, groupId);
    const rows = await this.sql<
      {
        user_id: string;
        email: string;
        username: string | null;
        notes: string | null;
        status: "active" | "suspended";
        rate: number | null;
        rpm_override: number | null;
        updated_at: Date;
      }[]
    >`
      SELECT r.user_id, u.email, u.username, u.notes, u.status,
             r.rate_multiplier::float8 AS rate, r.rpm_override, r.updated_at
        FROM core.user_group_rates r
        JOIN commerce.users u ON u.id = r.user_id
       WHERE r.group_id = ${groupId}
    `;
    return rows.sort(byKey((r) => r.email)).map((r) => ({
      userId: r.user_id,
      email: r.email,
      username: r.username ?? "",
      notes: r.notes ?? "",
      status: r.status === "suspended" ? "suspended" : "active",
      rateMultiplier: r.rate === null ? null : normalizeRate(Number(r.rate)),
      rpmOverride: r.rpm_override,
      updatedAtIso: iso(r.updated_at),
    }));
  }

  async syncGroupRateMultipliers(groupId: string, entries: { userId: string; rateMultiplier: number }[]): Promise<number> {
    const list = dedupeBy(entries, (e) => e.userId).map((e) => ({ userId: e.userId, rate: normalizeRate(e.rateMultiplier) }));
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await this.requireGroup(tx, groupId, true);
      const ids = list.map((e) => e.userId);
      await this.requireUsers(tx, ids);
      await tx`
        UPDATE core.user_group_rates SET rate_multiplier = NULL, updated_at = NOW()
         WHERE group_id = ${groupId} AND rate_multiplier IS NOT NULL AND NOT (user_id = ANY(${ids}::text[]))
      `;
      if (list.length > 0) {
        const rows = list.map((e) => ({ user_id: e.userId, group_id: groupId, rate_multiplier: e.rate }));
        await tx`
          INSERT INTO core.user_group_rates ${tx(rows, "user_id", "group_id", "rate_multiplier")}
          ON CONFLICT (user_id, group_id) DO UPDATE
             SET rate_multiplier = EXCLUDED.rate_multiplier, updated_at = NOW()
        `;
      }
      await tx`DELETE FROM core.user_group_rates WHERE group_id = ${groupId} AND rate_multiplier IS NULL AND rpm_override IS NULL`;
      return list.length;
    });
  }

  async syncGroupRpmOverrides(groupId: string, entries: { userId: string; rpmOverride: number | null }[]): Promise<number> {
    const list = dedupeBy(entries, (e) => e.userId).filter(
      (e): e is { userId: string; rpmOverride: number } => e.rpmOverride !== null,
    );
    const allIds = [...new Set(entries.map((e) => e.userId))];
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await this.requireGroup(tx, groupId, true);
      await this.requireUsers(tx, allIds);
      const kept = list.map((e) => e.userId);
      await tx`
        UPDATE core.user_group_rates SET rpm_override = NULL, updated_at = NOW()
         WHERE group_id = ${groupId} AND rpm_override IS NOT NULL AND NOT (user_id = ANY(${kept}::text[]))
      `;
      if (list.length > 0) {
        const rows = list.map((e) => ({ user_id: e.userId, group_id: groupId, rpm_override: e.rpmOverride }));
        await tx`
          INSERT INTO core.user_group_rates ${tx(rows, "user_id", "group_id", "rpm_override")}
          ON CONFLICT (user_id, group_id) DO UPDATE
             SET rpm_override = EXCLUDED.rpm_override, updated_at = NOW()
        `;
      }
      await tx`DELETE FROM core.user_group_rates WHERE group_id = ${groupId} AND rate_multiplier IS NULL AND rpm_override IS NULL`;
      return list.length;
    });
  }

  async clearGroupRates(groupId: string, kind: "rate" | "rpm"): Promise<number> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await this.requireGroup(tx, groupId, true);
      const rows =
        kind === "rate"
          ? await tx`
              UPDATE core.user_group_rates SET rate_multiplier = NULL, updated_at = NOW()
               WHERE group_id = ${groupId} AND rate_multiplier IS NOT NULL RETURNING user_id`
          : await tx`
              UPDATE core.user_group_rates SET rpm_override = NULL, updated_at = NOW()
               WHERE group_id = ${groupId} AND rpm_override IS NOT NULL RETURNING user_id`;
      await tx`DELETE FROM core.user_group_rates WHERE group_id = ${groupId} AND rate_multiplier IS NULL AND rpm_override IS NULL`;
      return rows.length;
    });
  }

  async listUserGroupRates(userId: string): Promise<UserGroupRateRow[]> {
    const rows = await this.sql<{ group_id: string; rate: number | null; rpm_override: number | null }[]>`
      SELECT group_id, rate_multiplier::float8 AS rate, rpm_override
        FROM core.user_group_rates WHERE user_id = ${userId}
    `;
    return rows.sort(byKey((r) => r.group_id)).map((r) => ({
      userId,
      groupId: r.group_id,
      rateMultiplier: r.rate === null ? null : normalizeRate(Number(r.rate)),
      rpmOverride: r.rpm_override,
    }));
  }

  async setUserGroupRates(
    userId: string,
    patch: { rates?: Record<string, number | null>; rpmOverrides?: Record<string, number | null> },
  ): Promise<void> {
    const rates = patch.rates ?? {};
    const rpms = patch.rpmOverrides ?? {};
    const groupIds = [...new Set([...Object.keys(rates), ...Object.keys(rpms)])];
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const user = await tx`SELECT 1 FROM commerce.users WHERE id = ${userId} FOR SHARE`;
      if (user.length === 0) throw new StoreError("not_found", `User ${userId} not found`);
      if (groupIds.length === 0) return;
      const known = new Set(
        (await tx<{ id: string }[]>`SELECT id FROM core.groups WHERE id = ANY(${groupIds}::text[]) FOR SHARE`).map((r) => r.id),
      );
      const missing = groupIds.filter((g) => !known.has(g));
      if (missing.length > 0) throw new StoreError("bad_request", `Unknown group id(s): ${missing.slice(0, 5).join(", ")}`);
      for (const groupId of groupIds) {
        const rateSent = Object.prototype.hasOwnProperty.call(rates, groupId);
        const rpmSent = Object.prototype.hasOwnProperty.call(rpms, groupId);
        const rate = rateSent && rates[groupId] !== null ? normalizeRate(rates[groupId]!) : null;
        const rpm = rpmSent ? rpms[groupId]! : null;
        await tx`
          INSERT INTO core.user_group_rates (user_id, group_id, rate_multiplier, rpm_override, updated_at)
          VALUES (${userId}, ${groupId}, ${rate}::numeric, ${rpm}::int, NOW())
          ON CONFLICT (user_id, group_id) DO UPDATE
             SET rate_multiplier = CASE WHEN ${rateSent} THEN EXCLUDED.rate_multiplier ELSE core.user_group_rates.rate_multiplier END,
                 rpm_override = CASE WHEN ${rpmSent} THEN EXCLUDED.rpm_override ELSE core.user_group_rates.rpm_override END,
                 updated_at = NOW()
        `;
      }
      await tx`DELETE FROM core.user_group_rates WHERE user_id = ${userId} AND rate_multiplier IS NULL AND rpm_override IS NULL`;
    });
  }

  async listRateOverrides(): Promise<UserGroupRateRow[]> {
    const rows = await this.sql<{ user_id: string; group_id: string; rate: number; rpm_override: number | null }[]>`
      SELECT user_id, group_id, rate_multiplier::float8 AS rate, rpm_override
        FROM core.user_group_rates WHERE rate_multiplier IS NOT NULL
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      groupId: r.group_id,
      rateMultiplier: normalizeRate(Number(r.rate)),
      rpmOverride: r.rpm_override,
    }));
  }

  /* ---------------- Data plane ---------------- */

  async exportUserLimits(defaults: { rpm: number; concurrency: number }): Promise<DataPlaneSyncUserLimits> {
    const [users, groups, overrides] = await Promise.all([
      this.sql<{ user_id: string; rpm_limit: number | null; concurrency_limit: number | null }[]>`
        SELECT l.user_id, l.rpm_limit, l.concurrency_limit
          FROM core.user_limits l
         WHERE l.rpm_limit IS NOT NULL OR l.concurrency_limit IS NOT NULL
      `,
      this.sql<{ id: string; rpm_limit: number; concurrency_limit: number }[]>`
        SELECT id, rpm_limit, concurrency_limit FROM core.groups
         WHERE rpm_limit > 0 OR concurrency_limit > 0
      `,
      this.sql<{ user_id: string; group_id: string; rpm_override: number | null; rate: number | null }[]>`
        SELECT user_id, group_id, rpm_override, rate_multiplier::float8 AS rate
          FROM core.user_group_rates
      `,
    ]);
    // Ordered in JS (code-unit order) so both stores export byte-identical snapshots.
    return {
      defaultRpmLimit: Math.max(0, defaults.rpm),
      defaultConcurrencyLimit: Math.max(0, defaults.concurrency),
      users: users
        .map((u) => ({ userId: u.user_id, rpmLimit: u.rpm_limit, concurrencyLimit: u.concurrency_limit }))
        .sort(byKey((u) => u.userId)),
      groups: groups
        .map((g) => ({ groupId: g.id, rpmLimit: g.rpm_limit, concurrencyLimit: g.concurrency_limit }))
        .sort(byKey((g) => g.groupId)),
      overrides: overrides
        .map((o) => ({
          userId: o.user_id,
          groupId: o.group_id,
          rpmOverride: o.rpm_override,
          rateMultiplier: o.rate === null ? null : normalizeRate(Number(o.rate)),
        }))
        .sort(byKey((o) => `${o.userId} ${o.groupId}`)),
    };
  }

  /* ---------------- Usage figures ---------------- */

  async userPlatformUsage(userIds: string[], sinceIso: string, todayStartIso: string): Promise<UserPlatformUsageRow[]> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    const rows = await pgReadWithTimeout(this.sql, USAGE_READ_TIMEOUT_MS, (tx) =>
      tx<{ user_id: string; platform: string; today: string; total: string }[]>`
        SELECT user_id, platform,
               COALESCE(SUM(cost_nano_usd) FILTER (WHERE created_at >= ${new Date(todayStartIso)}), 0)::text AS today,
               COALESCE(SUM(cost_nano_usd), 0)::text AS total
          FROM core.usage_logs
         WHERE user_id = ANY(${ids}::text[]) AND created_at >= ${new Date(sinceIso)}
         GROUP BY user_id, platform
      `,
    );
    return rows.map((r) => ({ userId: r.user_id, platform: r.platform, todayNano: BigInt(r.today), totalNano: BigInt(r.total) }));
  }

  async requestsSince(userId: string, sinceIso: string): Promise<Map<string, number>> {
    const rows = await this.sql<{ group_id: string; n: number }[]>`
      SELECT group_id, COUNT(*)::int AS n FROM core.usage_logs
       WHERE user_id = ${userId} AND created_at >= ${new Date(sinceIso)}
       GROUP BY group_id
    `;
    return new Map(rows.map((r) => [r.group_id, r.n]));
  }

  /* ---------------- Keys across owners ---------------- */

  async getApiKeyOwner(keyId: string): Promise<{ userId: string; groupId: string } | null> {
    const rows = await this.sql<{ user_id: string; group_id: string }[]>`
      SELECT user_id, group_id FROM core.api_keys WHERE id = ${keyId}
    `;
    return rows[0] ? { userId: rows[0].user_id, groupId: rows[0].group_id } : null;
  }

  async listGroupApiKeys(groupId: string, page: number, pageSize: number): Promise<{ items: AdminGroupApiKeyItem[]; total: number }> {
    await this.requireGroup(this.sql, groupId);
    const { offset, limit } = clampPage(page, pageSize);
    const [rows, total] = await Promise.all([
      this.sql<
        {
          id: string;
          name: string;
          user_id: string;
          email: string | null;
          key_prefix: string;
          enabled: boolean;
          rpm_limit: number;
          concurrency_limit: number;
          quota: string;
          spent: string;
          expires_at: Date | null;
          last_used_at: Date | null;
          created_at: Date;
        }[]
      >`
        SELECT k.id, k.name, k.user_id, u.email, k.key_prefix, k.enabled, k.rpm_limit, k.concurrency_limit,
               k.quota_nano_usd::text AS quota, k.spent_nano_usd::text AS spent,
               k.expires_at, k.last_used_at, k.created_at
          FROM core.api_keys k
          LEFT JOIN commerce.users u ON u.id = k.user_id
         WHERE k.group_id = ${groupId}
         ORDER BY k.created_at DESC, k.id ASC
         LIMIT ${limit} OFFSET ${offset}
      `,
      this.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM core.api_keys WHERE group_id = ${groupId}`,
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        userId: r.user_id,
        userEmail: r.email ?? "",
        keyPrefix: r.key_prefix,
        enabled: r.enabled,
        rpmLimit: r.rpm_limit,
        concurrencyLimit: r.concurrency_limit,
        quotaNanoUsd: r.quota,
        spentNanoUsd: r.spent,
        expiresAtIso: isoOrNull(r.expires_at),
        lastUsedAtIso: isoOrNull(r.last_used_at),
        createdAtIso: iso(r.created_at),
      })),
      total: total[0]?.n ?? 0,
    };
  }

  async grantGroup(userId: string, groupId: string): Promise<boolean> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<{ allowed_group_ids: unknown }[]>`
        SELECT allowed_group_ids FROM commerce.users WHERE id = ${userId} FOR UPDATE
      `;
      if (!rows[0]) throw new StoreError("not_found", `User ${userId} not found`);
      const allowed = stringArray(rows[0].allowed_group_ids);
      if (allowed.includes(groupId)) return false;
      await tx`
        UPDATE commerce.users SET allowed_group_ids = ${tx.json([...allowed, groupId])}, updated_at = NOW()
         WHERE id = ${userId}
      `;
      return true;
    });
  }

  async replaceUserGroup(userId: string, fromGroupId: string, toGroupId: string): Promise<{ migratedKeys: number; allowedGroupIds: string[] }> {
    if (fromGroupId === toGroupId) throw new StoreError("bad_request", "The groups must differ");
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const users = await tx<{ allowed_group_ids: unknown }[]>`
        SELECT allowed_group_ids FROM commerce.users WHERE id = ${userId} FOR UPDATE
      `;
      if (!users[0]) throw new StoreError("not_found", `User ${userId} not found`);
      const groups = await tx<{ enabled: boolean; is_exclusive: boolean; subscription_type: string }[]>`
        SELECT enabled, is_exclusive, subscription_type FROM core.groups WHERE id = ${toGroupId} FOR SHARE
      `;
      const target = groups[0];
      if (!target) throw new StoreError("not_found", `Group ${toGroupId} not found`);
      if (!target.enabled) throw new StoreError("bad_request", "The target group is disabled");
      if (!target.is_exclusive) throw new StoreError("bad_request", "The target group is not exclusive");
      if (target.subscription_type === "subscription") {
        throw new StoreError("bad_request", "Subscription groups cannot be the target of a group replacement");
      }
      const moved = await tx<{ id: string }[]>`
        UPDATE core.api_keys SET group_id = ${toGroupId}
         WHERE user_id = ${userId} AND group_id = ${fromGroupId}
        RETURNING id
      `;
      const allowed = stringArray(users[0].allowed_group_ids).filter((g) => g !== fromGroupId && g !== toGroupId);
      allowed.push(toGroupId);
      await tx`
        UPDATE commerce.users SET allowed_group_ids = ${tx.json(allowed)}, updated_at = NOW() WHERE id = ${userId}
      `;
      return { migratedKeys: moved.length, allowedGroupIds: allowed };
    });
  }
}
