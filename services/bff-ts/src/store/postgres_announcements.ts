import type postgres from "postgres";
import type {
  AnnouncementAudience,
  AnnouncementCondition,
  AnnouncementReadStatusQuery,
  AnnouncementReadStatusResponse,
  AnnouncementTargeting,
  UserRole,
} from "@slipgate/contracts";
import { likePattern, clampPage, targetingMatches, targetingRestricts } from "./ops_shared.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent startup DDL for announcement targeting, mirrored by
 * migrations/commerce/0010_announcement_targeting.sql. Runs after PG_OPS_SCHEMA_SQL (which
 * creates commerce.announcements and commerce.audit_logs).
 */
export const PG_ANNOUNCEMENT_TARGETING_SCHEMA_SQL = `
  ALTER TABLE commerce.announcements
      ADD COLUMN IF NOT EXISTS targeting JSONB NOT NULL DEFAULT '{}'::jsonb;
  CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_created ON commerce.audit_logs (created_at DESC);
`;

/** Wallet balance and active, unexpired subscription groups of one account, in one round trip. */
export async function loadTargetingContext(sql: Sql, userId: string): Promise<{ balanceNano: bigint; groups: Set<string> }> {
  const rows = await sql<{ balance: string | null; groups: string[] | null }[]>`
    SELECT (SELECT balance_nano_usd::text FROM core.quota_wallets WHERE user_id = ${userId}) AS balance,
           ARRAY(SELECT DISTINCT group_id FROM commerce.subscriptions
                  WHERE user_id = ${userId} AND status = 'active' AND expires_at > NOW()) AS groups
  `;
  const r = rows[0];
  return { balanceNano: BigInt(r?.balance ?? "0"), groups: new Set(r?.groups ?? []) };
}

/**
 * Keeps the rows whose targeting this account meets (rows without targeting cost nothing: the
 * balance / subscription lookup only runs when one of them is restricted).
 */
export async function filterTargeted<T>(sql: Sql, userId: string, rows: T[], targetingOf: (row: T) => AnnouncementTargeting): Promise<T[]> {
  if (!rows.some((r) => targetingRestricts(targetingOf(r)))) return rows;
  const ctx = await loadTargetingContext(sql, userId);
  return rows.filter((r) => targetingMatches(targetingOf(r), ctx.balanceNano, ctx.groups));
}

/**
 * The targeting rule as a boolean SQL expression over `u` (commerce.users) and `w`
 * (core.quota_wallets, LEFT JOINed): the same semantics as targetingMatches.
 */
export function targetingSql(sql: Sql, targeting: AnnouncementTargeting): Fragment {
  if (targeting.anyOf.length === 0) return sql`TRUE`;
  const groups = targeting.anyOf
    .filter((g) => g.allOf.length > 0)
    .map((g) => g.allOf.map((c) => conditionSql(sql, c)).reduce((acc, part) => sql`${acc} AND ${part}`));
  if (groups.length === 0) return sql`FALSE`;
  return sql`(${groups.map((g) => sql`(${g})`).reduce((acc, part) => sql`${acc} OR ${part}`)})`;
}

function conditionSql(sql: Sql, c: AnnouncementCondition): Fragment {
  if (c.type === "subscription") {
    if (c.operator !== "in" || c.groupIds.length === 0) return sql`FALSE`;
    return sql`EXISTS (
      SELECT 1 FROM commerce.subscriptions s
       WHERE s.user_id = u.id AND s.status = 'active' AND s.expires_at > NOW() AND s.group_id = ANY(${c.groupIds}::text[])
    )`;
  }
  if (c.type !== "balance" || !/^-?\d{1,30}$/.test(c.valueNanoUsd)) return sql`FALSE`;
  const balance = sql`COALESCE(w.balance_nano_usd, 0)`;
  const value = c.valueNanoUsd;
  switch (c.operator) {
    case "gt":
      return sql`${balance} > ${value}::numeric`;
    case "gte":
      return sql`${balance} >= ${value}::numeric`;
    case "lt":
      return sql`${balance} < ${value}::numeric`;
    case "lte":
      return sql`${balance} <= ${value}::numeric`;
    case "eq":
      return sql`${balance} = ${value}::numeric`;
    default:
      return sql`FALSE`;
  }
}

/** audienceMatches(audience, u.role) in SQL. */
function audienceSql(sql: Sql, audience: AnnouncementAudience): Fragment {
  if (audience === "all") return sql`TRUE`;
  return sql`u.role = ${audience === "admins" ? "admin" : "user"}`;
}

interface ReadStatusRow {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  status: "active" | "suspended";
  balance: string;
  read_at: Date | null;
  eligible: boolean;
}

/**
 * Every account LEFT JOINed with its read of announcement `id`, eligibility evaluated in SQL; one
 * page plus the filtered total and the overall stats (two statements, run concurrently).
 */
export async function readStatusPage(
  sql: Sql,
  id: string,
  audience: AnnouncementAudience,
  targeting: AnnouncementTargeting,
  query: AnnouncementReadStatusQuery,
): Promise<AnnouncementReadStatusResponse> {
  const base = sql`
    SELECT u.id, u.email, u.username, u.role, u.status,
           COALESCE(w.balance_nano_usd, 0)::text AS balance,
           r.read_at,
           (${audienceSql(sql, audience)} AND ${targetingSql(sql, targeting)}) AS eligible
      FROM commerce.users u
      LEFT JOIN core.quota_wallets w ON w.user_id = u.id
      LEFT JOIN commerce.announcement_reads r ON r.announcement_id = ${id} AND r.user_id = u.id
  `;
  const parts: Fragment[] = [];
  if (query.read === "read") parts.push(sql`b.read_at IS NOT NULL`);
  if (query.read === "unread") parts.push(sql`b.read_at IS NULL`);
  if (query.eligible === "eligible") parts.push(sql`b.eligible`);
  if (query.eligible === "ineligible") parts.push(sql`NOT b.eligible`);
  if (query.q) {
    const p = likePattern(query.q);
    parts.push(sql`(b.email ILIKE ${p} OR b.username ILIKE ${p})`);
  }
  const where = parts.length === 0 ? sql`TRUE` : parts.reduce((acc, part) => sql`${acc} AND ${part}`);
  // COLLATE "C": the same code-unit order MemoryOpsStore sorts by.
  const byEmail = sql`b.email COLLATE "C" ASC, b.id COLLATE "C" ASC`;
  const order: Record<AnnouncementReadStatusQuery["sort"], Fragment> = {
    email_asc: byEmail,
    email_desc: sql`b.email COLLATE "C" DESC, b.id COLLATE "C" DESC`,
    read_at_desc: sql`b.read_at DESC NULLS LAST, ${byEmail}`,
    read_at_asc: sql`b.read_at ASC NULLS LAST, ${byEmail}`,
    username_asc: sql`(COALESCE(b.username, '') = '') ASC, COALESCE(b.username, '') COLLATE "C" ASC, ${byEmail}`,
    username_desc: sql`(COALESCE(b.username, '') = '') ASC, COALESCE(b.username, '') COLLATE "C" DESC, ${byEmail}`,
    balance_desc: sql`b.balance::numeric DESC, ${byEmail}`,
    balance_asc: sql`b.balance::numeric ASC, ${byEmail}`,
  };
  const { offset, limit } = clampPage(query.page, query.pageSize);
  const [rows, totals] = await Promise.all([
    sql<ReadStatusRow[]>`
      SELECT b.* FROM (${base}) b WHERE ${where} ORDER BY ${order[query.sort]} LIMIT ${limit} OFFSET ${offset}
    `,
    sql<{ users: number; eligible: number; read: number; eligible_read: number; total: number }[]>`
      SELECT COUNT(*)::int AS users,
             COUNT(*) FILTER (WHERE b.eligible)::int AS eligible,
             COUNT(*) FILTER (WHERE b.read_at IS NOT NULL)::int AS read,
             COUNT(*) FILTER (WHERE b.eligible AND b.read_at IS NOT NULL)::int AS eligible_read,
             COUNT(*) FILTER (WHERE ${where})::int AS total
        FROM (${base}) b
    `,
  ]);
  const t = totals[0] ?? { users: 0, eligible: 0, read: 0, eligible_read: 0, total: 0 };
  return {
    items: rows.map((r) => ({
      userId: r.id,
      email: r.email,
      username: r.username ?? "",
      role: r.role,
      status: r.status,
      balanceNanoUsd: r.balance,
      read: r.read_at !== null,
      readAtIso: r.read_at ? new Date(r.read_at).toISOString() : null,
      eligible: Boolean(r.eligible),
    })),
    total: t.total,
    stats: { users: t.users, eligible: t.eligible, read: t.read, eligibleRead: t.eligible_read },
  };
}
