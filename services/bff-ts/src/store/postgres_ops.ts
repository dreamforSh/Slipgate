import postgres from "postgres";
import {
  formatNanoUsd,
  normalizePortalSettings,
  type AdminUserItem,
  type AdminUserListQuery,
  type AdminUserListResponse,
  type AnnouncementItem,
  type AnnouncementReader,
  type AnnouncementReadStatusQuery,
  type AnnouncementReadStatusResponse,
  type AuditLogItem,
  type AuditLogQuery,
  type LinkedIdentity,
  type BalanceLedgerItem,
  type CreatePromoCodeRequest,
  type GenerateRedeemCodesRequest,
  type OAuthProviderId,
  type PortalSettings,
  type PromoCodeCheckResponse,
  type PromoCodeItem,
  type PromoCodeUsageItem,
  type RedeemCodeClaimItem,
  type RedeemCodeItem,
  type RedeemCodeListQuery,
  type RedeemCodeListResponse,
  type RedeemResult,
  type SubscriptionAction,
  type UpdatePromoCodeRequest,
  type UpdateRedeemCodesRequest,
  type UpsertAnnouncementRequest,
  type UsagePageResponse,
  type UsageQuery,
  type UsageRow,
  type UserAnnouncementItem,
  type UserProfile,
  type UserRole,
  type UserSubscriptionItem,
  type UserSubscriptionListQuery,
} from "@slipgate/contracts";
import {
  clampPage,
  effectiveRedeemStatus,
  effectiveSubscriptionStatus,
  likePattern,
  normalizeRedeemCode,
  randomCode,
  storedTargeting,
  subscriptionOverLimit,
  ANNOUNCEMENT_FEED_CANDIDATES,
} from "./ops_shared.ts";
import { filterTargeted, readStatusPage } from "./postgres_announcements.ts";
import { AUDIT_DELETE_BATCH } from "./ops_types.ts";
import { backfillWalletSpend, ensureUsageLogIndexes, ensureUsageLogPartitions } from "./postgres_settlement.ts";
import type {
  AdminUserCreateInput,
  AdminUserUpdateInput,
  AuditLogInput,
  CreatePendingOAuthSignupInput,
  OpsStore,
  PendingOAuthSignupRecord,
  RegistrationExtras,
  RegistrationOutcome,
  SessionState,
  SubscriptionEntitlement,
  UsageExportQuery,
  UserAccessRecord,
} from "./ops_types.ts";
import type { ApiKeyLabel, ApiKeyLookupRecord } from "./ops_types.ts";
import { StoreError } from "./types.ts";
import { viewerDayStartMs } from "./user_limits_types.ts";
import {
  emptyScopedUsageAggregate,
  nanoFromText,
  OPS_RECENT_ERRORS,
  SCOPED_USAGE_TIMEOUT_MS,
  scopedUsagePlan,
  UsageAggregateTimeoutError,
  type ChannelStatusAggregate,
  type ChannelStatusQuery,
  type OpsGroupSums,
  type OpsUsageAggregate,
  type OpsUsageQuery,
  type ScopedUsageAggregate,
  type ScopedUsageQuery,
  type UsageSums,
} from "./usage_aggregates.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent DDL for operations/commerce features, mirrored by migrations/commerce/0003 and
 * migrations/core/0007. Runs inside PostgresControlStore.init() before the BFF listens, so it
 * must stay cheap: no index builds on core.usage_logs here (see ensureUsageIndexesInBackground).
 */
export const PG_OPS_SCHEMA_SQL = `
  ALTER TABLE commerce.users
      ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS allowed_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS invite_code TEXT,
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_users_invite_code
      ON commerce.users (invite_code) WHERE invite_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_commerce_users_created ON commerce.users (created_at DESC);

  ALTER TABLE commerce.redeem_codes
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'balance',
      ADD COLUMN IF NOT EXISTS group_id TEXT,
      ADD COLUMN IF NOT EXISTS validity_days INTEGER,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unused',
      ADD COLUMN IF NOT EXISTS batch_id TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_by TEXT,
      ADD COLUMN IF NOT EXISTS max_uses INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS batch_per_user_limit INTEGER NOT NULL DEFAULT 0;
  UPDATE commerce.redeem_codes SET status = 'used' WHERE redeemed_by IS NOT NULL AND status = 'unused';
  UPDATE commerce.redeem_codes SET used_count = 1 WHERE status = 'used' AND used_count = 0;
  CREATE INDEX IF NOT EXISTS idx_commerce_redeem_codes_created ON commerce.redeem_codes (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_redeem_codes_redeemed_by ON commerce.redeem_codes (redeemed_by, redeemed_at DESC);

  CREATE TABLE IF NOT EXISTS commerce.redeem_code_claims (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES commerce.redeem_codes(code) ON DELETE CASCADE,
      batch_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      group_id TEXT,
      validity_days INTEGER,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_code_user
      ON commerce.redeem_code_claims (code, user_id);
  CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_batch_user
      ON commerce.redeem_code_claims (batch_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_user
      ON commerce.redeem_code_claims (user_id, redeemed_at DESC);

  CREATE TABLE IF NOT EXISTS commerce.promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      bonus_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS commerce.promo_code_usages (
      promo_code_id TEXT NOT NULL REFERENCES commerce.promo_codes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      bonus_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (promo_code_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS commerce.announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL DEFAULT 'draft',
      audience TEXT NOT NULL DEFAULT 'all',
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      popup BOOLEAN NOT NULL DEFAULT FALSE,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS commerce.announcement_reads (
      announcement_id TEXT NOT NULL REFERENCES commerce.announcements(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (announcement_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS commerce.audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_email TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      path TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      request_body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_created ON commerce.audit_logs (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_actor ON commerce.audit_logs (actor_id, created_at DESC);

  ALTER TABLE commerce.subscriptions
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin',
      ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS weekly_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  CREATE INDEX IF NOT EXISTS idx_commerce_subscriptions_user_group ON commerce.subscriptions (user_id, group_id, status);
  CREATE INDEX IF NOT EXISTS idx_commerce_subscriptions_created ON commerce.subscriptions (created_at DESC);

  ALTER TABLE core.groups
      ADD COLUMN IF NOT EXISTS daily_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS weekly_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS monthly_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS default_validity_days INTEGER NOT NULL DEFAULT 30;
  ALTER TABLE core.quota_wallets
      ADD COLUMN IF NOT EXISTS spent_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS commerce.email_codes (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (email, purpose)
  );
  CREATE TABLE IF NOT EXISTS commerce.password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_password_resets_user ON commerce.password_resets (user_id);

  ALTER TABLE core.api_keys
      ADD COLUMN IF NOT EXISTS ip_denylist JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS quota_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS spent_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS limit_5h_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS limit_1d_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS limit_7d_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

  -- migrations/commerce/0007_ops_integrity.sql: custom (bring-your-own) keys keep only their
  -- first four characters for display. Generated keys (sk-sg-<6 hex>...<4 hex>) are untouched.
  UPDATE core.api_keys
     SET key_prefix = left(key_prefix, 4) || '...'
   WHERE key_prefix !~ '^sk-sg-[0-9a-f]{6}[.][.][.][0-9a-f]{4}$'
     AND key_prefix !~ '^.{0,4}[.][.][.]$';
`;

/**
 * Revocable sessions, mirrored by migrations/core/0010_session_security.sql (runs in
 * PostgresControlStore.init() after PG_OPS_SCHEMA_SQL). Every access token carries the user's
 * token_version; bumping it ends all of the user's sessions. revoked_tokens is the per-token
 * logout denylist, kept until each token's own expiry.
 */
export const PG_SESSION_SCHEMA_SQL = `
  ALTER TABLE commerce.users
      ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS commerce.revoked_tokens (
      jti         TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_revoked_tokens_expires ON commerce.revoked_tokens (expires_at);
`;

/**
 * OAuth extras: user avatar_url/email_verified + pending invite-required continuation tokens.
 * Mirrored by migrations/commerce/0015_oauth_extras.sql.
 */
export const PG_OAUTH_EXTRAS_SCHEMA_SQL = `
  ALTER TABLE commerce.users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS commerce.oauth_pending_signups (
      token_hash         TEXT PRIMARY KEY,
      provider           TEXT NOT NULL,
      subject            TEXT NOT NULL,
      suggested_email    TEXT NOT NULL DEFAULT '',
      suggested_username TEXT NOT NULL DEFAULT '',
      avatar_url         TEXT NOT NULL DEFAULT '',
      binding_hash       TEXT NOT NULL,
      redirect_path      TEXT NOT NULL DEFAULT '/dashboard',
      expires_at         TIMESTAMPTZ NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_oauth_pending_expires
      ON commerce.oauth_pending_signups (expires_at);
`;

/**
 * Transaction-scoped advisory lock serialising every change that can remove an active
 * administrator. Without it two admins demoting (or deleting) each other concurrently each see the
 * other still active under READ COMMITTED and both commit (write skew), leaving no admin. Taken
 * before any row lock, so holders never wait on a row another holder has locked.
 */
async function lockAdminSet(tx: Sql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(727172801)`;
}

/**
 * Backfills lifetime wallet spend once (additively, see backfillWalletSpend) and converges the
 * usage_logs indexes on one attached index per partition, built CONCURRENTLY so settlements are
 * never blocked (see ensureUsageLogIndexes). Errors are logged, never thrown: the console works
 * without them, only slower.
 */
export async function ensureUsageIndexesInBackground(sql: Sql): Promise<void> {
  try {
    await backfillWalletSpend(sql);
  } catch (err) {
    console.warn(`[slipgate-bff] wallet spend backfill skipped: ${err instanceof Error ? err.message : err}`);
  }
  await ensureUsageLogPartitions(sql);
  await ensureUsageLogIndexes(sql);
}

function iso(v: Date | string | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  return v ? iso(v) : null;
}

function jsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  const decoded = jsonValue<unknown>(value);
  return Array.isArray(decoded) ? decoded.filter((v): v is string => typeof v === "string") : [];
}

function mapConflict(err: unknown, message: string): never {
  if ((err as { code?: string })?.code === "23505") throw new StoreError("conflict", message);
  throw err;
}

/** All fragments ANDed together (TRUE when empty). */
function and(sql: Sql, parts: Fragment[]): Fragment {
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

/**
 * Runs `read` in a read-only transaction whose statements Postgres cancels after `timeoutMs`
 * (set_config(..., is_local) = SET LOCAL, so the pooled connection keeps its own setting
 * afterwards). Every statement of `read` uses the transaction's single connection. A
 * cancellation (57014) surfaces as UsageAggregateTimeoutError.
 */
export async function pgReadWithTimeout<T>(sql: Sql, timeoutMs: number, read: (tx: Sql) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin("read only", async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await tx`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(timeoutMs)))}, true)`;
      return read(tx);
    })) as T;
  } catch (err) {
    if ((err as { code?: string })?.code === "57014") throw new UsageAggregateTimeoutError();
    throw err;
  }
}

/**
 * One wallet movement inside an open transaction, applied once per idempotency key.
 * Returns false when the key was already used.
 */
export async function pgApplyWalletDelta(
  tx: Sql,
  userId: string,
  deltaNano: bigint,
  idempotencyKey: string,
  kind: "credit" | "adjust",
  reason: string,
): Promise<boolean> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.ledger_entries WHERE idempotency_key = ${idempotencyKey} LIMIT 1
  `;
  if (existing.length > 0) return false;
  await tx`
    INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
    VALUES (${userId}, 0, 0)
    ON CONFLICT (user_id) DO NOTHING
  `;
  const updated = await tx<{ balance_nano_usd: string }[]>`
    UPDATE core.quota_wallets
       SET balance_nano_usd = balance_nano_usd + ${deltaNano.toString()}::numeric, updated_at = NOW()
     WHERE user_id = ${userId}
    RETURNING balance_nano_usd::text
  `;
  await tx`
    INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, metadata)
    VALUES (
      ${`ldg_${crypto.randomUUID()}`}, ${idempotencyKey}, ${userId}, ${kind},
      ${deltaNano.toString()}::numeric, ${updated[0]!.balance_nano_usd}::numeric, ${tx.json({ reason })}
    )
  `;
  return true;
}

/** First key of the two-int advisory locks taken per (user, group) subscription grant. */
const SUBSCRIPTION_GRANT_LOCK_SPACE = 74_210_036;

/**
 * Extends the newest active subscription of this (user, group) pair, or creates one, inside an
 * open transaction. Returns the subscription id. Shared by redeem codes and payments.
 */
export async function pgAssignSubscriptionTx(
  tx: Sql,
  userId: string,
  groupId: string,
  validityDays: number,
  notes: string,
  source: string,
): Promise<string> {
  const group = await tx<{ subscription_type: string; name: string }[]>`
    SELECT subscription_type, name FROM core.groups WHERE id = ${groupId}
  `;
  if (!group[0]) throw new StoreError("not_found", `Group ${groupId} not found`);
  if (group[0].subscription_type !== "subscription") {
    throw new StoreError("bad_request", `Group ${group[0].name} is not subscription-billed`);
  }
  const user = await tx`SELECT 1 FROM commerce.users WHERE id = ${userId}`;
  if (user.length === 0) throw new StoreError("not_found", `User ${userId} not found`);
  // Serialise grants for this (user, group) until commit. Without it two concurrent grants
  // (two paid orders, an order and a redeem code, …) both find no active row, since FOR UPDATE
  // below locks nothing then, and both insert: two parallel subscriptions instead of stacked
  // validity. Collisions of the hash only serialise unrelated pairs, never merge them.
  await tx`SELECT pg_advisory_xact_lock(${SUBSCRIPTION_GRANT_LOCK_SPACE}::int, hashtext(${userId}::text || '/' || ${groupId}::text))`;
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM commerce.subscriptions
     WHERE user_id = ${userId} AND group_id = ${groupId} AND status = 'active'
     ORDER BY expires_at DESC LIMIT 1 FOR UPDATE
  `;
  const days = `${validityDays} days`;
  if (existing[0]) {
    await tx`
      UPDATE commerce.subscriptions
         SET starts_at = CASE WHEN expires_at <= NOW() THEN NOW() ELSE starts_at END,
             expires_at = GREATEST(expires_at, NOW()) + ${days}::interval,
             notes = CASE WHEN ${notes} = '' THEN notes ELSE ${notes} END,
             updated_at = NOW()
       WHERE id = ${existing[0].id}
    `;
    return existing[0].id;
  }
  const id = `sub_${crypto.randomUUID()}`;
  await tx`
    INSERT INTO commerce.subscriptions (id, user_id, group_id, plan_code, status, source, notes, starts_at, expires_at)
    VALUES (${id}, ${userId}, ${groupId}, 'group', 'active', ${source}, ${notes}, NOW(), NOW() + ${days}::interval)
  `;
  return id;
}

interface AdminUserRow {
  id: string;
  email: string;
  username: string;
  avatar_url: string;
  email_verified: boolean;
  role: UserRole;
  managed_group_ids: string[] | null;
  status: "active" | "suspended";
  totp_enabled: boolean;
  created_at: Date;
  notes: string;
  allowed_group_ids: unknown;
  invite_code: string | null;
  referrer_id: string | null;
  referrer_email: string | null;
  last_login_at: Date | null;
  balance: string;
  spent: string;
  api_key_count: number;
  active_subs: number;
}

interface RedeemRow {
  code: string;
  kind: RedeemCodeItem["kind"];
  amount_nano_usd: string;
  group_id: string | null;
  group_name: string | null;
  validity_days: number | null;
  status: "unused" | "used" | "disabled";
  batch_id: string;
  notes: string;
  redeemed_by: string | null;
  redeemed_by_email: string | null;
  redeemed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  max_uses: number;
  used_count: number;
  per_user_limit: number;
  batch_per_user_limit: number;
}

interface PromoRow {
  id: string;
  code: string;
  bonus_nano_usd: string;
  max_uses: number;
  used_count: number;
  enabled: boolean;
  expires_at: Date | null;
  notes: string;
  created_at: Date;
}

interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  level: AnnouncementItem["level"];
  status: AnnouncementItem["status"];
  audience: AnnouncementItem["audience"];
  pinned: boolean;
  popup: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
  read_count?: number;
  is_read?: boolean;
  /** JSONB targeting rule (absent on rows read before the column existed). */
  targeting?: unknown;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  user_email: string | null;
  group_id: string;
  group_name: string | null;
  status: "active" | "revoked";
  source: string;
  notes: string;
  starts_at: Date;
  expires_at: Date;
  usage_reset_at: Date | null;
  daily_reset_at: Date | null;
  weekly_reset_at: Date | null;
  monthly_reset_at: Date | null;
  created_at: Date;
  daily_limit: string | null;
  weekly_limit: string | null;
  monthly_limit: string | null;
  daily_used: string;
  weekly_used: string;
  monthly_used: string;
}

export class PostgresOpsStore implements OpsStore {
  constructor(private readonly sql: Sql) {}

  /* ---------------- Third-party identities ---------------- */

  async findUserIdByIdentity(provider: string, subject: string): Promise<string | null> {
    const rows = await this.sql<{ user_id: string }[]>`
      SELECT user_id FROM commerce.auth_identities WHERE provider = ${provider} AND subject = ${subject}
    `;
    return rows[0]?.user_id ?? null;
  }

  async linkIdentity(userId: string, provider: string, subject: string): Promise<void> {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const owner = await tx<{ user_id: string }[]>`
        SELECT user_id FROM commerce.auth_identities WHERE provider = ${provider} AND subject = ${subject}
      `;
      if (owner[0] && owner[0].user_id !== userId) throw new StoreError("conflict", "That account is already linked to another user");
      await tx`DELETE FROM commerce.auth_identities WHERE user_id = ${userId} AND provider = ${provider}`;
      await tx`
        INSERT INTO commerce.auth_identities (id, user_id, provider, subject)
        VALUES (${`idn_${crypto.randomUUID()}`}, ${userId}, ${provider}, ${subject})
      `;
    });
  }

  async unlinkIdentity(userId: string, provider: string): Promise<void> {
    await this.sql`DELETE FROM commerce.auth_identities WHERE user_id = ${userId} AND provider = ${provider}`;
  }

  async listIdentities(userId: string): Promise<LinkedIdentity[]> {
    const rows = await this.sql<{ provider: string; subject: string; created_at: Date }[]>`
      SELECT provider, subject, created_at FROM commerce.auth_identities WHERE user_id = ${userId} ORDER BY created_at
    `;
    return rows.map((r) => ({ provider: r.provider, subject: r.subject, createdAtIso: iso(r.created_at) }));
  }

  async createPendingOAuthSignup(input: CreatePendingOAuthSignupInput): Promise<void> {
    await this.sql`DELETE FROM commerce.oauth_pending_signups WHERE expires_at <= NOW()`;
    await this.sql`
      INSERT INTO commerce.oauth_pending_signups (
        token_hash, provider, subject, suggested_email, suggested_username, avatar_url, binding_hash, redirect_path, expires_at
      )
      VALUES (
        ${input.tokenHash},
        ${input.provider},
        ${input.subject},
        ${input.suggestedEmail},
        ${input.suggestedUsername},
        ${input.avatarUrl},
        ${input.bindingHash},
        ${input.redirectPath || "/dashboard"},
        ${new Date(input.expiresAtIso)}
      )
    `;
  }

  async getPendingOAuthSignup(tokenHash: string): Promise<PendingOAuthSignupRecord | null> {
    const rows = await this.sql<{
      token_hash: string;
      provider: OAuthProviderId;
      subject: string;
      suggested_email: string;
      suggested_username: string;
      avatar_url: string;
      binding_hash: string;
      redirect_path: string;
      expires_at: Date;
    }[]>`
      SELECT token_hash, provider, subject, suggested_email, suggested_username, avatar_url, binding_hash, redirect_path, expires_at
      FROM commerce.oauth_pending_signups
      WHERE token_hash = ${tokenHash} AND expires_at > NOW()
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      tokenHash: r.token_hash,
      provider: r.provider,
      subject: r.subject,
      suggestedEmail: r.suggested_email,
      suggestedUsername: r.suggested_username,
      avatarUrl: r.avatar_url,
      bindingHash: r.binding_hash,
      redirectPath: r.redirect_path,
      expiresAtIso: iso(r.expires_at),
    };
  }

  async consumePendingOAuthSignup(tokenHash: string): Promise<PendingOAuthSignupRecord | null> {
    const rows = await this.sql<{
      token_hash: string;
      provider: OAuthProviderId;
      subject: string;
      suggested_email: string;
      suggested_username: string;
      avatar_url: string;
      binding_hash: string;
      redirect_path: string;
      expires_at: Date;
    }[]>`
      DELETE FROM commerce.oauth_pending_signups
      WHERE token_hash = ${tokenHash} AND expires_at > NOW()
      RETURNING token_hash, provider, subject, suggested_email, suggested_username, avatar_url, binding_hash, redirect_path, expires_at
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      tokenHash: r.token_hash,
      provider: r.provider,
      subject: r.subject,
      suggestedEmail: r.suggested_email,
      suggestedUsername: r.suggested_username,
      avatarUrl: r.avatar_url,
      bindingHash: r.binding_hash,
      redirectPath: r.redirect_path,
      expiresAtIso: iso(r.expires_at),
    };
  }

  /* ---------------- Blobs, email codes, password resets ---------------- */

  async getBlob(key: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ value_json: unknown }[]>`SELECT value_json FROM commerce.portal_settings WHERE key = ${key}`;
    const v = jsonValue<unknown>(rows[0]?.value_json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }

  async setBlob(key: string, value: Record<string, unknown>): Promise<void> {
    await this.sql`
      INSERT INTO commerce.portal_settings (key, value_json, updated_at)
      VALUES (${key}, ${this.sql.json(value as postgres.JSONValue)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `;
  }

  async updateBlob(
    key: string,
    mutator: (current: Record<string, unknown> | null) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(727172803, hashtext(${key}::text))`;
      const rows = await tx<{ value_json: unknown }[]>`
        SELECT value_json FROM commerce.portal_settings WHERE key = ${key} FOR UPDATE
      `;
      const v = jsonValue<unknown>(rows[0]?.value_json);
      const current = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      const next = await mutator(current);
      await tx`
        INSERT INTO commerce.portal_settings (key, value_json, updated_at)
        VALUES (${key}, ${tx.json(next as postgres.JSONValue)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
      `;
      return next;
    });
  }

  async saveEmailCode(email: string, purpose: string, codeHash: string, expiresAtIso: string): Promise<void> {
    await this.sql`
      INSERT INTO commerce.email_codes (email, purpose, code_hash, expires_at, attempts, created_at)
      VALUES (${email.toLowerCase()}, ${purpose}, ${codeHash}, ${new Date(expiresAtIso)}, 0, NOW())
      ON CONFLICT (email, purpose) DO UPDATE
        SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = NOW()
    `;
  }

  /**
   * Every guess, right or wrong, first spends one of the code's five attempts with a conditional
   * UPDATE. That statement row-locks the code until commit, so concurrent guesses queue behind it
   * and re-check `attempts < 5`: at most five guesses are ever compared against one code. The
   * code is deleted, still under the lock, once it matched or its last attempt is spent.
   */
  async consumeEmailCode(email: string, purpose: string, codeHash: string): Promise<boolean> {
    const e = email.toLowerCase();
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const tried = await tx<{ ok: boolean; attempts: number }[]>`
        UPDATE commerce.email_codes SET attempts = attempts + 1
         WHERE email = ${e} AND purpose = ${purpose} AND expires_at > NOW() AND attempts < 5
        RETURNING code_hash = ${codeHash} AS ok, attempts
      `;
      const t = tried[0];
      if (!t) return false;
      if (t.ok || t.attempts >= 5) await tx`DELETE FROM commerce.email_codes WHERE email = ${e} AND purpose = ${purpose}`;
      return t.ok;
    });
  }

  async lastEmailCodeAt(email: string, purpose: string): Promise<string | null> {
    const rows = await this.sql<{ created_at: Date }[]>`
      SELECT created_at FROM commerce.email_codes WHERE email = ${email.toLowerCase()} AND purpose = ${purpose}
    `;
    return rows[0] ? iso(rows[0].created_at) : null;
  }

  async savePasswordReset(userId: string, tokenHash: string, expiresAtIso: string): Promise<void> {
    await this.sql`
      INSERT INTO commerce.password_resets (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${userId}, ${new Date(expiresAtIso)})
    `;
  }

  async consumePasswordReset(tokenHash: string): Promise<string | null> {
    const rows = await this.sql<{ user_id: string }[]>`
      UPDATE commerce.password_resets SET used_at = NOW()
       WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id
    `;
    return rows[0]?.user_id ?? null;
  }

  /* ---------------- Settings ---------------- */

  async getSettings(): Promise<PortalSettings> {
    const rows = await this.sql<{ key: string; value_json: unknown }[]>`
      SELECT key, value_json FROM commerce.portal_settings WHERE key IN ('portal_settings', 'setup_state')
    `;
    const stored = jsonValue<Record<string, unknown>>(rows.find((r) => r.key === "portal_settings")?.value_json) ?? {};
    const setup = jsonValue<Record<string, unknown>>(rows.find((r) => r.key === "setup_state")?.value_json) ?? {};
    const merged: Record<string, unknown> = { ...stored };
    if (typeof setup.siteName === "string" && setup.siteName) merged.siteName = setup.siteName;
    if (typeof setup.allowRegistration === "boolean") merged.allowRegistration = setup.allowRegistration;
    return normalizePortalSettings(merged);
  }

  async saveSettings(settings: PortalSettings): Promise<PortalSettings> {
    const normalized = normalizePortalSettings(settings);
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(727172802)`;
      await tx`
        INSERT INTO commerce.portal_settings (key, value_json, updated_at)
        VALUES ('portal_settings', ${tx.json(normalized)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
      `;
      await tx`
        UPDATE commerce.portal_settings
           SET value_json = value_json || ${tx.json({
             siteName: normalized.siteName,
             allowRegistration: normalized.allowRegistration,
           })}::jsonb,
               updated_at = NOW()
         WHERE key = 'setup_state' AND jsonb_typeof(value_json) = 'object'
      `;
    });
    return this.getSettings();
  }

  async updateSettings(
    mutator: (current: PortalSettings) => PortalSettings | Promise<PortalSettings>,
  ): Promise<{ previous: PortalSettings; saved: PortalSettings }> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(727172802)`;
      const rows = await tx<{ key: string; value_json: unknown }[]>`
        SELECT key, value_json FROM commerce.portal_settings WHERE key IN ('portal_settings', 'setup_state') FOR UPDATE
      `;
      const stored = jsonValue<Record<string, unknown>>(rows.find((r) => r.key === "portal_settings")?.value_json) ?? {};
      const setup = jsonValue<Record<string, unknown>>(rows.find((r) => r.key === "setup_state")?.value_json) ?? {};
      const merged: Record<string, unknown> = { ...stored };
      if (typeof setup.siteName === "string" && setup.siteName) merged.siteName = setup.siteName;
      if (typeof setup.allowRegistration === "boolean") merged.allowRegistration = setup.allowRegistration;
      const previous = normalizePortalSettings(merged);
      const next = normalizePortalSettings(await mutator(previous));
      await tx`
        INSERT INTO commerce.portal_settings (key, value_json, updated_at)
        VALUES ('portal_settings', ${tx.json(next)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
      `;
      await tx`
        UPDATE commerce.portal_settings
           SET value_json = value_json || ${tx.json({
             siteName: next.siteName,
             allowRegistration: next.allowRegistration,
           })}::jsonb,
               updated_at = NOW()
         WHERE key = 'setup_state' AND jsonb_typeof(value_json) = 'object'
      `;
      return { previous, saved: next };
    });
  }

  /* ---------------- Users ---------------- */

  private adminUserSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT u.id, u.email, u.username, u.avatar_url, u.email_verified, u.role, u.managed_group_ids, u.status, u.totp_enabled, u.created_at,
             u.notes, u.allowed_group_ids, u.invite_code, u.referrer_id, r.email AS referrer_email,
             u.last_login_at,
             COALESCE(w.balance_nano_usd, 0)::text AS balance,
             COALESCE(w.spent_nano_usd, 0)::text AS spent,
             (SELECT COUNT(*) FROM core.api_keys k WHERE k.user_id = u.id)::int AS api_key_count,
             (SELECT COUNT(*) FROM commerce.subscriptions s
               WHERE s.user_id = u.id AND s.status = 'active' AND s.expires_at > NOW())::int AS active_subs
        FROM commerce.users u
        LEFT JOIN core.quota_wallets w ON w.user_id = u.id
        LEFT JOIN commerce.users r ON r.id = u.referrer_id
       WHERE ${where}
    `;
  }

  private toAdminUser(r: AdminUserRow): AdminUserItem {
    return {
      id: r.id,
      email: r.email,
      username: r.username ?? "",
      avatarUrl: r.avatar_url ?? "",
      emailVerified: Boolean(r.email_verified),
      role: r.role,
      managedGroupIds: Array.isArray(r.managed_group_ids) ? [...r.managed_group_ids] : [],
      status: r.status,
      totpEnabled: r.totp_enabled,
      createdAtIso: iso(r.created_at),
      notes: r.notes ?? "",
      allowedGroupIds: stringArray(r.allowed_group_ids),
      inviteCode: r.invite_code ?? "",
      referrerId: r.referrer_id,
      referrerEmail: r.referrer_email,
      lastLoginAtIso: isoOrNull(r.last_login_at),
      balanceNanoUsd: r.balance,
      spentNanoUsd: r.spent,
      apiKeyCount: r.api_key_count,
      activeSubscriptionCount: r.active_subs,
    };
  }

  async listAdminUsers(query: AdminUserListQuery, scope?: { managedGroupIds?: string[] }): Promise<AdminUserListResponse> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    let scopeCond: Fragment | null = null;
    if (scope?.managedGroupIds !== undefined) {
      if (scope.managedGroupIds.length === 0) {
        return {
          items: [],
          total: 0,
          stats: { total: 0, admins: 0, suspended: 0, newLast7d: 0, balanceNanoUsd: "0" },
        };
      }
      const mgIds = scope.managedGroupIds;
      scopeCond = sql`(
        u.role <> 'admin' AND (
          EXISTS (SELECT 1 FROM jsonb_array_elements_text(u.allowed_group_ids) g WHERE g = ANY(${mgIds}))
          OR EXISTS (SELECT 1 FROM core.api_keys k WHERE k.user_id = u.id AND k.group_id = ANY(${mgIds}))
          OR EXISTS (SELECT 1 FROM commerce.subscriptions s WHERE s.user_id = u.id AND s.group_id = ANY(${mgIds}))
        )
      )`;
      parts.push(scopeCond);
    }
    if (query.role) parts.push(sql`u.role = ${query.role}`);
    if (query.status) parts.push(sql`u.status = ${query.status}`);
    if (query.search) {
      const p = likePattern(query.search);
      parts.push(sql`(u.email ILIKE ${p} OR u.username ILIKE ${p} OR u.notes ILIKE ${p} OR u.id = ${query.search})`);
    }
    if (query.groupId) parts.push(sql`u.allowed_group_ids @> jsonb_build_array(${query.groupId}::text)`);
    if (query.apiKeyGroupId) {
      parts.push(sql`EXISTS (SELECT 1 FROM core.api_keys k WHERE k.group_id = ${query.apiKeyGroupId} AND k.user_id = u.id)`);
    }
    const where = and(sql, parts);
    const todayStart = new Date(viewerDayStartMs(Date.now(), query.tz));
    const lastUsed = sql`(SELECT MAX(k.last_used_at) FROM core.api_keys k WHERE k.user_id = u.id)`;
    const order: Record<AdminUserListQuery["sort"], Fragment> = {
      created_desc: sql`u.created_at DESC`,
      created_asc: sql`u.created_at ASC`,
      balance_desc: sql`COALESCE(w.balance_nano_usd, 0) DESC, u.created_at DESC`,
      balance_asc: sql`COALESCE(w.balance_nano_usd, 0) ASC, u.created_at DESC`,
      spent_desc: sql`COALESCE(w.spent_nano_usd, 0) DESC, u.created_at DESC`,
      email_asc: sql`u.email ASC`,
      login_desc: sql`u.last_login_at DESC NULLS LAST, u.created_at DESC`,
      today_cost_desc: sql`(SELECT COALESCE(SUM(l.cost_nano_usd), 0) FROM core.usage_logs l
                             WHERE l.user_id = u.id AND l.created_at >= ${todayStart}) DESC, u.created_at DESC`,
      total_cost_desc: sql`COALESCE(w.spent_nano_usd, 0) DESC, u.created_at DESC`,
      last_used_desc: sql`${lastUsed} DESC NULLS LAST, u.created_at DESC`,
      last_active_desc: sql`GREATEST(u.last_login_at, ${lastUsed}) DESC NULLS LAST, u.created_at DESC`,
    };
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const [rows, totals, stats] = await Promise.all([
      sql<AdminUserRow[]>`${this.adminUserSelect(where)} ORDER BY ${order[query.sort]} LIMIT ${limit} OFFSET ${offset}`,
      sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM commerce.users u WHERE ${where}`,
      sql<{ total: number; admins: number; suspended: number; new7d: number; balance: string }[]>`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE u.role = 'admin')::int AS admins,
               COUNT(*) FILTER (WHERE u.status = 'suspended')::int AS suspended,
               COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '7 days')::int AS new7d,
               COALESCE(SUM(w.balance_nano_usd), 0)::text AS balance
          FROM commerce.users u
          LEFT JOIN core.quota_wallets w ON w.user_id = u.id
         WHERE ${scopeCond ?? sql`TRUE`}
      `,
    ]);
    const s = stats[0]!;
    return {
      items: rows.map((r) => this.toAdminUser(r)),
      total: totals[0]?.n ?? 0,
      stats: { total: s.total, admins: s.admins, suspended: s.suspended, newLast7d: s.new7d, balanceNanoUsd: s.balance },
    };
  }

  async getAdminUser(userId: string): Promise<AdminUserItem | null> {
    const rows = await this.sql<AdminUserRow[]>`${this.adminUserSelect(this.sql`u.id = ${userId}`)}`;
    return rows[0] ? this.toAdminUser(rows[0]) : null;
  }

  async createUser(input: AdminUserCreateInput): Promise<AdminUserItem> {
    const id = `usr_${crypto.randomUUID()}`;
    try {
      await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as Sql;
        await tx`
          INSERT INTO commerce.users (id, email, username, avatar_url, email_verified, password_hash, role, managed_group_ids, status, notes, allowed_group_ids)
          VALUES (${id}, ${input.email.toLowerCase()}, ${input.username}, ${input.avatarUrl ?? ""}, ${Boolean(input.emailVerified)},
                  ${input.passwordHash}, ${input.role}, ${[...new Set(input.managedGroupIds ?? [])]}, 'active', ${input.notes}, ${tx.json([...new Set(input.allowedGroupIds)])})
        `;
        await tx`
          INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
          VALUES (${id}, 0, 0) ON CONFLICT (user_id) DO NOTHING
        `;
        if (input.initialBalanceNano > 0n) {
          await pgApplyWalletDelta(tx, id, input.initialBalanceNano, `signup:${id}`, "credit", "initial_balance");
        }
      });
    } catch (err) {
      mapConflict(err, "Email is already registered");
    }
    return (await this.getAdminUser(id))!;
  }

  private async activeAdminCount(exceptId: string | null, tx: Sql = this.sql): Promise<number> {
    const rows = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM commerce.users
       WHERE role = 'admin' AND status = 'active' AND (${exceptId}::text IS NULL OR id <> ${exceptId})
    `;
    return rows[0]?.n ?? 0;
  }

  async updateUser(userId: string, input: AdminUserUpdateInput): Promise<AdminUserItem> {
    try {
      await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as Sql;
        // A role or status change may remove an active admin: serialise it with the others first.
        if (input.role !== undefined || input.status !== undefined) await lockAdminSet(tx);
        const current = await tx<{ role: UserRole; status: string }[]>`
          SELECT role, status FROM commerce.users WHERE id = ${userId} FOR UPDATE
        `;
        const cur = current[0];
        if (!cur) throw new StoreError("not_found", `User ${userId} not found`);
        const losesAdmin =
          cur.role === "admin" &&
          cur.status === "active" &&
          ((input.role !== undefined && input.role !== "admin") || input.status === "suspended");
        // Counted after the lock: a statement snapshot under READ COMMITTED sees every change the
        // previous lock holder committed.
        if (losesAdmin && (await this.activeAdminCount(userId, tx)) === 0) {
          throw new StoreError("conflict", "The last active administrator cannot be demoted or suspended");
        }
        const endsSessions =
          (input.role !== undefined && input.role !== cur.role) ||
          (input.status !== undefined && input.status !== cur.status) ||
          input.passwordHash !== undefined;
        const allowed = input.allowedGroupIds ? tx.json([...new Set(input.allowedGroupIds)]) : null;
        const managed = input.managedGroupIds ? [...new Set(input.managedGroupIds)] : null;
        await tx`
          UPDATE commerce.users
             SET email = COALESCE(${input.email?.toLowerCase() ?? null}, email),
                 username = COALESCE(${input.username ?? null}, username),
                 role = COALESCE(${input.role ?? null}, role),
                 managed_group_ids = COALESCE(${managed}::text[], managed_group_ids),
                 status = COALESCE(${input.status ?? null}, status),
                 notes = COALESCE(${input.notes ?? null}, notes),
                 allowed_group_ids = COALESCE(${allowed}::jsonb, allowed_group_ids),
                 password_hash = COALESCE(${input.passwordHash ?? null}, password_hash),
                 token_version = token_version + ${endsSessions ? 1 : 0}::int,
                 updated_at = NOW()
           WHERE id = ${userId}
        `;
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapConflict(err, "Email is already registered");
    }
    return (await this.getAdminUser(userId))!;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await lockAdminSet(tx);
      const rows = await tx<{ role: UserRole }[]>`SELECT role FROM commerce.users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new StoreError("not_found", `User ${userId} not found`);
      if (rows[0].role === "admin" && (await this.activeAdminCount(userId, tx)) === 0) {
        throw new StoreError("conflict", "The last active administrator cannot be deleted");
      }
      const orders = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM commerce.payment_orders WHERE user_id = ${userId}`;
      if ((orders[0]?.n ?? 0) > 0) {
        throw new StoreError("conflict", "This user has payment orders; suspend the account instead");
      }
      const rebates = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM commerce.affiliate_commissions WHERE beneficiary_id = ${userId}
      `;
      if ((rebates[0]?.n ?? 0) > 0) {
        throw new StoreError("conflict", "This user has earned referral rebates; suspend the account instead");
      }
      await tx`DELETE FROM core.api_keys WHERE user_id = ${userId}`;
      await tx`DELETE FROM core.user_platform_quotas WHERE user_id = ${userId}`;
      await tx`DELETE FROM core.ledger_entries WHERE user_id = ${userId}`;
      await tx`DELETE FROM core.quota_wallets WHERE user_id = ${userId}`;
      await tx`DELETE FROM commerce.revoked_tokens WHERE user_id = ${userId}`;
      await tx`DELETE FROM commerce.users WHERE id = ${userId}`;
    });
  }

  async setUsersStatus(userIds: string[], status: "active" | "suspended"): Promise<number> {
    const ids = [...new Set(userIds)];
    const rows = await this.sql<{ id: string }[]>`
      UPDATE commerce.users SET status = ${status}, token_version = token_version + 1, updated_at = NOW()
       WHERE id = ANY(${ids}) AND status <> ${status} AND (${status} <> 'suspended' OR role <> 'admin')
      RETURNING id
    `;
    return rows.length;
  }

  async adjustWallet(userId: string, deltaNano: bigint, idempotencyKey: string, reason: string): Promise<bigint> {
    const exists = await this.sql<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ${userId}`;
    if (!exists[0]) throw new StoreError("not_found", `User ${userId} not found`);
    await this.sql.begin(async (txRaw) => {
      await pgApplyWalletDelta(txRaw as unknown as Sql, userId, deltaNano, idempotencyKey, "adjust", reason);
    });
    const rows = await this.sql<{ b: string }[]>`
      SELECT balance_nano_usd::text AS b FROM core.quota_wallets WHERE user_id = ${userId}
    `;
    return BigInt(rows[0]?.b ?? "0");
  }

  async adjustWalletAtomic(
    userId: string,
    operation: "add" | "subtract" | "set",
    amountNano: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ balanceNano: bigint; deltaNano: bigint }> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const exists = await tx<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ${userId}`;
      if (!exists[0]) throw new StoreError("not_found", `User ${userId} not found`);
      await tx`
        INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
        VALUES (${userId}, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `;
      const locked = await tx<{ b: string }[]>`
        SELECT balance_nano_usd::text AS b FROM core.quota_wallets WHERE user_id = ${userId} FOR UPDATE
      `;
      const current = BigInt(locked[0]?.b ?? "0");
      const deltaNano =
        operation === "add" ? amountNano : operation === "subtract" ? -amountNano : amountNano - current;
      if (deltaNano === 0n) return { balanceNano: current, deltaNano: 0n };
      await pgApplyWalletDelta(tx, userId, deltaNano, idempotencyKey, "adjust", reason);
      const after = await tx<{ b: string }[]>`
        SELECT balance_nano_usd::text AS b FROM core.quota_wallets WHERE user_id = ${userId}
      `;
      return { balanceNano: BigInt(after[0]?.b ?? "0"), deltaNano };
    });
  }

  async listLedger(userId: string, limit: number): Promise<BalanceLedgerItem[]> {
    const rows = await this.sql<
      { id: string; entry_kind: BalanceLedgerItem["kind"]; delta: string; after: string; reason: string | null; created_at: Date }[]
    >`
      SELECT id, entry_kind, delta_nano_usd::text AS delta, balance_after_nano::text AS after,
             COALESCE(metadata->>'reason', metadata->>'publicModel', '') AS reason, created_at
        FROM core.ledger_entries
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    return rows.map((r) => ({
      id: r.id,
      kind: r.entry_kind,
      deltaNanoUsd: r.delta,
      balanceAfterNanoUsd: r.after,
      reason: r.reason ?? "",
      createdAtIso: iso(r.created_at),
    }));
  }

  async countAdmins(): Promise<number> {
    return this.activeAdminCount(null);
  }

  async listUserAccess(): Promise<UserAccessRecord[]> {
    const rows = await this.sql<{ id: string; role: UserRole; status: "active" | "suspended"; allowed_group_ids: unknown }[]>`
      SELECT id, role, status, allowed_group_ids FROM commerce.users
    `;
    return rows.map((r) => ({ id: r.id, role: r.role, status: r.status, allowedGroupIds: stringArray(r.allowed_group_ids) }));
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.sql`UPDATE commerce.users SET last_login_at = NOW() WHERE id = ${userId}`;
  }

  async updateOwnProfile(userId: string, username: string, avatarUrl?: string): Promise<UserProfile> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        username: string;
        avatar_url: string;
        email_verified: boolean;
        role: UserRole;
        managed_group_ids: string[] | null;
        status: "active" | "suspended";
        totp_enabled: boolean;
        created_at: Date;
      }[]
    >`
      UPDATE commerce.users
         SET username = ${username},
             avatar_url = COALESCE(${avatarUrl ?? null}, avatar_url),
             updated_at = NOW()
       WHERE id = ${userId}
      RETURNING id, email, username, avatar_url, email_verified, role, managed_group_ids, status, totp_enabled, created_at
    `;
    const r = rows[0];
    if (!r) throw new StoreError("not_found", `User ${userId} not found`);
    return {
      id: r.id,
      email: r.email,
      username: r.username,
      avatarUrl: r.avatar_url ?? "",
      emailVerified: Boolean(r.email_verified),
      role: r.role,
      managedGroupIds: Array.isArray(r.managed_group_ids) ? [...r.managed_group_ids] : [],
      status: r.status,
      totpEnabled: r.totp_enabled,
      createdAtIso: iso(r.created_at),
    };
  }

  async bindPlaceholderEmail(userId: string, email: string, emailVerified: boolean): Promise<UserProfile> {
    const normalized = email.trim().toLowerCase();
    try {
      const existing = await this.sql<{ email: string }[]>`SELECT email FROM commerce.users WHERE id = ${userId} LIMIT 1`;
      if (!existing[0]) throw new StoreError("not_found", `User ${userId} not found`);
      if (!existing[0].email.toLowerCase().endsWith("@users.noreply.slipgate")) {
        throw new StoreError("conflict", "Only placeholder OAuth accounts can bind a new email address");
      }
      const rows = await this.sql<
        {
          id: string;
          email: string;
          username: string;
          avatar_url: string;
          email_verified: boolean;
          role: UserRole;
          managed_group_ids: string[] | null;
          status: "active" | "suspended";
          totp_enabled: boolean;
          created_at: Date;
        }[]
      >`
        UPDATE commerce.users
           SET email = ${normalized},
               email_verified = ${emailVerified},
               updated_at = NOW()
         WHERE id = ${userId}
        RETURNING id, email, username, avatar_url, email_verified, role, managed_group_ids, status, totp_enabled, created_at
      `;
      const r = rows[0]!;
      return {
        id: r.id,
        email: r.email,
        username: r.username,
        avatarUrl: r.avatar_url ?? "",
        emailVerified: Boolean(r.email_verified),
        role: r.role,
        managedGroupIds: Array.isArray(r.managed_group_ids) ? [...r.managed_group_ids] : [],
        status: r.status,
        totpEnabled: r.totp_enabled,
        createdAtIso: iso(r.created_at),
      };
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapConflict(err, "Email is already registered");
    }
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const rows = await this.sql<{ password_hash: string | null }[]>`SELECT password_hash FROM commerce.users WHERE id = ${userId}`;
    return rows[0]?.password_hash ?? null;
  }

  async getTotp(userId: string): Promise<{ secretEnc: Uint8Array | null; enabled: boolean } | null> {
    const rows = await this.sql<{ totp_secret_enc: Uint8Array | null; totp_enabled: boolean }[]>`
      SELECT totp_secret_enc, totp_enabled FROM commerce.users WHERE id = ${userId}
    `;
    const r = rows[0];
    if (!r) return null;
    return { secretEnc: r.totp_secret_enc ? new Uint8Array(r.totp_secret_enc) : null, enabled: r.totp_enabled };
  }

  async setTotp(userId: string, secretEnc: Uint8Array | null, enabled: boolean): Promise<void> {
    const rows = await this.sql`
      UPDATE commerce.users
         SET totp_secret_enc = ${secretEnc ? Buffer.from(secretEnc) : null},
             totp_enabled = ${enabled && secretEnc !== null}, updated_at = NOW()
       WHERE id = ${userId} RETURNING id
    `;
    if (rows.length === 0) throw new StoreError("not_found", `User ${userId} not found`);
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<number> {
    const rows = await this.sql<{ token_version: number }[]>`
      UPDATE commerce.users
         SET password_hash = ${passwordHash}, token_version = token_version + 1, updated_at = NOW()
       WHERE id = ${userId}
      RETURNING token_version
    `;
    if (rows.length === 0) throw new StoreError("not_found", `User ${userId} not found`);
    return Number(rows[0]!.token_version);
  }

  /* ---------------- Sessions ---------------- */

  async getSessionState(userId: string, jti?: string): Promise<SessionState> {
    const rows = await this.sql<
      { email: string; role: UserRole; managed_group_ids: string[] | null; status: "active" | "suspended"; token_version: number; revoked: boolean }[]
    >`
      SELECT u.email, u.role, u.managed_group_ids, u.status, u.token_version,
             (${jti ?? null}::text IS NOT NULL
               AND EXISTS (SELECT 1 FROM commerce.revoked_tokens r WHERE r.jti = ${jti ?? null}::text)) AS revoked
        FROM commerce.users u
       WHERE u.id = ${userId}
    `;
    const r = rows[0];
    if (!r) return { user: null, revoked: false };
    return {
      user: {
        email: r.email,
        role: r.role,
        managedGroupIds: Array.isArray(r.managed_group_ids) ? [...r.managed_group_ids] : [],
        status: r.status,
        tokenVersion: Number(r.token_version),
      },
      revoked: r.revoked === true,
    };
  }

  async bumpTokenVersion(userId: string): Promise<number | null> {
    const rows = await this.sql<{ token_version: number }[]>`
      UPDATE commerce.users SET token_version = token_version + 1, updated_at = NOW()
       WHERE id = ${userId}
      RETURNING token_version
    `;
    return rows[0] ? Number(rows[0].token_version) : null;
  }

  async revokeToken(jti: string, userId: string, expiresAtIso: string): Promise<void> {
    await this.sql`
      INSERT INTO commerce.revoked_tokens (jti, user_id, expires_at)
      VALUES (${jti}, ${userId}, ${new Date(expiresAtIso)})
      ON CONFLICT (jti) DO NOTHING
    `;
    // Expired tokens are refused on their own; their denylist rows are dead weight.
    await this.sql`DELETE FROM commerce.revoked_tokens WHERE expires_at < NOW()`;
  }

  async applyRegistrationExtras(userId: string, extras: RegistrationExtras): Promise<RegistrationOutcome> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      if (extras.username) {
        await tx`UPDATE commerce.users SET username = ${extras.username} WHERE id = ${userId}`;
      }
      let referrerId: string | null = null;
      if (extras.affCode) {
        const ref = await tx<{ id: string }[]>`
          SELECT id FROM commerce.users WHERE invite_code = ${extras.affCode.trim().toUpperCase()} AND id <> ${userId} LIMIT 1
        `;
        if (ref[0]) {
          referrerId = ref[0].id;
          await tx`UPDATE commerce.users SET referrer_id = ${referrerId} WHERE id = ${userId}`;
        }
      }
      let promoBonusNano = 0n;
      if (extras.promoCode) {
        const promo = await tx<{ id: string; code: string; bonus: string }[]>`
          UPDATE commerce.promo_codes
             SET used_count = used_count + 1, updated_at = NOW()
           WHERE code = ${extras.promoCode.trim().toUpperCase()} AND enabled
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (max_uses = 0 OR used_count < max_uses)
          RETURNING id, code, bonus_nano_usd::text AS bonus
        `;
        const p = promo[0];
        if (p) {
          promoBonusNano = BigInt(p.bonus);
          await tx`
            INSERT INTO commerce.promo_code_usages (promo_code_id, user_id, bonus_nano_usd)
            VALUES (${p.id}, ${userId}, ${p.bonus}::numeric) ON CONFLICT DO NOTHING
          `;
          if (promoBonusNano > 0n) {
            await pgApplyWalletDelta(tx, userId, promoBonusNano, `promo:${p.id}:${userId}`, "credit", `promo:${p.code}`);
          }
        }
      }
      return { promoBonusNano, referrerId };
    });
  }

  async isInvitationCodeUsable(code: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM commerce.redeem_codes
       WHERE code = ${normalizeRedeemCode(code)} AND kind = 'invitation' AND status = 'unused'
         AND used_count < max_uses
         AND (expires_at IS NULL OR expires_at > NOW())
    `;
    return rows.length > 0;
  }

  async registerWithInvitation<T extends { id: string }>(code: string, register: () => Promise<T>): Promise<T | null> {
    const normalized = normalizeRedeemCode(code);
    // Atomic UPDATE claims one invitation slot under row lock; rolls back if `register()` fails.
    const claimed = await this.sql<{ claimed_at: Date; max_uses: number }[]>`
      UPDATE commerce.redeem_codes
         SET used_count = used_count + 1,
             status = CASE WHEN used_count + 1 >= max_uses THEN 'used' ELSE status END,
             redeemed_by = CASE WHEN max_uses = 1 THEN NULL ELSE redeemed_by END,
             redeemed_at = date_trunc('milliseconds', clock_timestamp())
       WHERE code = ${normalized} AND kind = 'invitation' AND status = 'unused' AND used_count < max_uses
         AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING redeemed_at AS claimed_at, max_uses
    `;
    const claim = claimed[0];
    if (!claim) return null;
    let created: T;
    try {
      created = await register();
    } catch (err) {
      await this.sql`
        UPDATE commerce.redeem_codes
           SET used_count = GREATEST(0, used_count - 1),
               status = 'unused',
               redeemed_at = CASE WHEN max_uses = 1 THEN NULL ELSE redeemed_at END
         WHERE code = ${normalized} AND used_count > 0
      `.catch(() => {});
      throw err;
    }
    if (claim.max_uses === 1) {
      await this.sql`
        UPDATE commerce.redeem_codes SET redeemed_by = ${created.id}
         WHERE code = ${normalized} AND redeemed_by IS NULL AND redeemed_at = ${claim.claimed_at}
      `;
    } else {
      await this.sql`
        UPDATE commerce.redeem_codes SET redeemed_by = ${created.id}
         WHERE code = ${normalized}
      `;
    }
    await this.sql`
      INSERT INTO commerce.redeem_code_claims (id, code, batch_id, user_id, kind, amount_nano_usd, redeemed_at)
      SELECT ${`rdc_${crypto.randomUUID()}`}, code, batch_id, ${created.id}, 'invitation', 0, NOW()
        FROM commerce.redeem_codes
       WHERE code = ${normalized}
    `.catch(() => {});
    return created;
  }

  async findUserIdByInviteCode(inviteCode: string): Promise<string | null> {
    const wanted = inviteCode.trim().toUpperCase();
    if (!wanted) return null;
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM commerce.users WHERE invite_code = ${wanted} LIMIT 1`;
    return rows[0]?.id ?? null;
  }

  async ensureInviteCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const rows = await this.sql<{ invite_code: string | null }[]>`
        SELECT invite_code FROM commerce.users WHERE id = ${userId}
      `;
      if (!rows[0]) throw new StoreError("not_found", `User ${userId} not found`);
      if (rows[0].invite_code) return rows[0].invite_code;
      try {
        await this.sql`UPDATE commerce.users SET invite_code = ${randomCode(8)} WHERE id = ${userId} AND invite_code IS NULL`;
      } catch (err) {
        if ((err as { code?: string })?.code !== "23505") throw err;
      }
    }
    throw new StoreError("conflict", "Could not allocate an invite code, retry");
  }

  async listInvitees(referrerId: string): Promise<{ email: string; username: string; joinedAtIso: string }[]> {
    const rows = await this.sql<{ email: string; username: string; created_at: Date }[]>`
      SELECT email, username, created_at FROM commerce.users WHERE referrer_id = ${referrerId}
       ORDER BY created_at DESC LIMIT 500
    `;
    return rows.map((r) => ({ email: r.email, username: r.username ?? "", joinedAtIso: iso(r.created_at) }));
  }

  /* ---------------- Redeem codes ---------------- */

  private redeemSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT c.code, c.kind, c.amount_nano_usd::text, c.group_id, g.name AS group_name, c.validity_days,
             c.status, c.batch_id, c.notes, c.redeemed_by, u.email AS redeemed_by_email, c.redeemed_at,
             c.expires_at, c.created_at, c.max_uses, c.used_count, c.per_user_limit, c.batch_per_user_limit
        FROM commerce.redeem_codes c
        LEFT JOIN core.groups g ON g.id = c.group_id
        LEFT JOIN commerce.users u ON u.id = c.redeemed_by
       WHERE ${where}
    `;
  }

  private toRedeemItem(r: RedeemRow, nowMs = Date.now()): RedeemCodeItem {
    const expiresAtIso = isoOrNull(r.expires_at);
    return {
      code: r.code,
      kind: r.kind,
      amountNanoUsd: r.amount_nano_usd,
      groupId: r.group_id,
      groupName: r.group_name,
      validityDays: r.validity_days,
      status: effectiveRedeemStatus(r.status, expiresAtIso, nowMs),
      batchId: r.batch_id ?? "",
      notes: r.notes ?? "",
      redeemedBy: r.redeemed_by,
      redeemedByEmail: r.redeemed_by_email,
      redeemedAtIso: isoOrNull(r.redeemed_at),
      expiresAtIso,
      createdAtIso: iso(r.created_at),
      maxUses: r.max_uses ?? 1,
      usedCount: r.used_count ?? 0,
      perUserLimit: r.per_user_limit ?? 1,
      batchPerUserLimit: r.batch_per_user_limit ?? 0,
    };
  }

  async generateRedeemCodes(
    req: GenerateRedeemCodesRequest,
    codes: string[],
    amountNano: bigint,
    createdBy: string,
  ): Promise<RedeemCodeItem[]> {
    if (req.kind === "subscription") {
      const g = await this.sql<{ subscription_type: string }[]>`
        SELECT subscription_type FROM core.groups WHERE id = ${req.groupId ?? ""}
      `;
      if (!g[0]) throw new StoreError("not_found", `Group ${req.groupId} not found`);
      if (g[0].subscription_type !== "subscription") throw new StoreError("bad_request", "That group is not subscription-billed");
    }
    const batchId = `b_${randomCode(10).toLowerCase()}`;
    const maxUses = req.maxUses ?? 1;
    const perUserLimit = Math.min(req.perUserLimit ?? 1, maxUses);
    const batchPerUserLimit = req.batchPerUserLimit ?? 0;
    const rows = codes.map((code) => ({
      code,
      kind: req.kind,
      amount_nano_usd: req.kind === "balance" ? amountNano.toString() : "0",
      group_id: req.kind === "subscription" ? (req.groupId ?? null) : null,
      validity_days: req.kind === "subscription" ? (req.validityDays ?? null) : null,
      status: "unused",
      batch_id: batchId,
      notes: req.notes,
      created_by: createdBy,
      expires_at: req.expiresAtIso ? new Date(req.expiresAtIso) : null,
      max_uses: maxUses,
      used_count: 0,
      per_user_limit: perUserLimit,
      batch_per_user_limit: batchPerUserLimit,
    }));
    try {
      await this.sql`
        INSERT INTO commerce.redeem_codes ${this.sql(
          rows,
          "code",
          "kind",
          "amount_nano_usd",
          "group_id",
          "validity_days",
          "status",
          "batch_id",
          "notes",
          "created_by",
          "expires_at",
          "max_uses",
          "used_count",
          "per_user_limit",
          "batch_per_user_limit",
        )}
      `;
    } catch (err) {
      mapConflict(err, "Generated a duplicate code, retry");
    }
    const created = await this.sql<RedeemRow[]>`${this.redeemSelect(this.sql`c.batch_id = ${batchId}`)} ORDER BY c.code`;
    return created.map((r) => this.toRedeemItem(r));
  }

  async listRedeemCodes(query: RedeemCodeListQuery): Promise<RedeemCodeListResponse> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    switch (query.status) {
      case "expired":
        parts.push(sql`c.status = 'unused' AND c.expires_at IS NOT NULL AND c.expires_at <= NOW()`);
        break;
      case "unused":
        parts.push(sql`c.status = 'unused' AND (c.expires_at IS NULL OR c.expires_at > NOW())`);
        break;
      case "used":
      case "disabled":
        parts.push(sql`c.status = ${query.status}`);
        break;
    }
    if (query.kind) parts.push(sql`c.kind = ${query.kind}`);
    if (query.batchId) parts.push(sql`c.batch_id = ${query.batchId}`);
    if (query.search) {
      const p = likePattern(query.search);
      parts.push(sql`(c.code ILIKE ${p} OR c.notes ILIKE ${p} OR u.email ILIKE ${p})`);
    }
    const where = and(sql, parts);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const [rows, totals, stats] = await Promise.all([
      sql<RedeemRow[]>`${this.redeemSelect(where)} ORDER BY c.created_at DESC, c.code LIMIT ${limit} OFFSET ${offset}`,
      sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM commerce.redeem_codes c LEFT JOIN commerce.users u ON u.id = c.redeemed_by WHERE ${where}
      `,
      sql<{ total: number; unused: number; used: number; disabled: number; expired: number; redeemed: string }[]>`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'unused' AND (expires_at IS NULL OR expires_at > NOW()))::int AS unused,
               COUNT(*) FILTER (WHERE status = 'used')::int AS used,
               COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
               COUNT(*) FILTER (WHERE status = 'unused' AND expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
               COALESCE(SUM(amount_nano_usd * GREATEST(used_count, CASE WHEN status = 'used' THEN 1 ELSE 0 END)) FILTER (WHERE kind = 'balance'), 0)::text AS redeemed
          FROM commerce.redeem_codes
      `,
    ]);
    const s = stats[0]!;
    const now = Date.now();
    return {
      items: rows.map((r) => this.toRedeemItem(r, now)),
      total: totals[0]?.n ?? 0,
      stats: { total: s.total, unused: s.unused, used: s.used, disabled: s.disabled, expired: s.expired, redeemedNanoUsd: s.redeemed },
    };
  }

  async updateRedeemCodes(req: UpdateRedeemCodesRequest): Promise<number> {
    const codes = [...new Set(req.codes.map(normalizeRedeemCode))];
    const sql = this.sql;
    let rows: postgres.RowList<postgres.Row[]>;
    switch (req.action) {
      case "disable":
        rows = await sql`UPDATE commerce.redeem_codes SET status = 'disabled' WHERE code = ANY(${codes}) AND status = 'unused' RETURNING code`;
        break;
      case "enable":
        rows = await sql`UPDATE commerce.redeem_codes SET status = 'unused' WHERE code = ANY(${codes}) AND status = 'disabled' RETURNING code`;
        break;
      case "delete":
        rows = await sql`DELETE FROM commerce.redeem_codes WHERE code = ANY(${codes}) AND status <> 'used' RETURNING code`;
        break;
      case "set_expiry": {
        const at = req.expiresAtIso ? new Date(req.expiresAtIso) : null;
        rows = await sql`UPDATE commerce.redeem_codes SET expires_at = ${at} WHERE code = ANY(${codes}) AND status <> 'used' RETURNING code`;
        break;
      }
      case "set_notes":
        rows = await sql`UPDATE commerce.redeem_codes SET notes = ${req.notes ?? ""} WHERE code = ANY(${codes}) RETURNING code`;
        break;
    }
    return rows.length;
  }

  async redeemCode(userId: string, rawCode: string): Promise<RedeemResult> {
    const code = normalizeRedeemCode(rawCode);
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<{
        kind: RedeemCodeItem["kind"];
        amount: string;
        group_id: string | null;
        validity_days: number | null;
        status: "unused" | "used" | "disabled";
        batch_id: string;
        expires_at: Date | null;
        max_uses: number;
        used_count: number;
        per_user_limit: number;
        batch_per_user_limit: number;
        group_name: string | null;
      }[]>`
        SELECT c.kind, c.amount_nano_usd::text AS amount, c.group_id, c.validity_days, c.status, c.batch_id,
               c.expires_at, c.max_uses, c.used_count, c.per_user_limit, c.batch_per_user_limit, g.name AS group_name
          FROM commerce.redeem_codes c LEFT JOIN core.groups g ON g.id = c.group_id
         WHERE c.code = ${code}
         FOR UPDATE OF c
      `;
      const r = rows[0];
      if (!r || r.status === "disabled" || r.kind === "invitation") throw new StoreError("not_found", "Invalid redeem code");
      if (r.status === "used" || r.used_count >= r.max_uses) throw new StoreError("conflict", "This code has already been used");
      if (r.expires_at && r.expires_at.getTime() <= Date.now()) throw new StoreError("bad_request", "This code has expired");

      const codeClaims = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM commerce.redeem_code_claims WHERE code = ${code} AND user_id = ${userId}
      `;
      if ((codeClaims[0]?.n ?? 0) >= r.per_user_limit) {
        throw new StoreError("conflict", "You have already reached the redemption limit for this code");
      }
      if (r.batch_per_user_limit > 0 && r.batch_id) {
        await tx`SELECT pg_advisory_xact_lock(74210061, hashtext(${`${r.batch_id}:${userId}`}))`;
        const batchClaims = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM commerce.redeem_code_claims WHERE batch_id = ${r.batch_id} AND user_id = ${userId}
        `;
        if ((batchClaims[0]?.n ?? 0) >= r.batch_per_user_limit) {
          throw new StoreError("conflict", "You have already reached the redemption limit for this batch");
        }
      }

      const claimId = `rdc_${crypto.randomUUID()}`;
      const idempotencyKey = r.max_uses === 1 ? `redeem:${code}` : `redeem:${code}:${claimId}`;
      let subscriptionExpiresAtIso: string | null = null;
      if (r.kind === "subscription") {
        const subId = await pgAssignSubscriptionTx(tx, userId, r.group_id ?? "", r.validity_days ?? 30, "", idempotencyKey);
        const exp = await tx<{ expires_at: Date }[]>`SELECT expires_at FROM commerce.subscriptions WHERE id = ${subId}`;
        subscriptionExpiresAtIso = isoOrNull(exp[0]?.expires_at);
      } else {
        const amount = BigInt(r.amount);
        if (amount > 0n) await pgApplyWalletDelta(tx, userId, amount, idempotencyKey, "credit", idempotencyKey);
      }
      await tx`
        INSERT INTO commerce.redeem_code_claims (id, code, batch_id, user_id, kind, amount_nano_usd, group_id, validity_days)
        VALUES (${claimId}, ${code}, ${r.batch_id}, ${userId}, ${r.kind}, ${r.amount}::numeric, ${r.group_id}, ${r.validity_days})
      `;
      const nextUsed = r.used_count + 1;
      const nextStatus = nextUsed >= r.max_uses ? "used" : "unused";
      await tx`
        UPDATE commerce.redeem_codes
           SET used_count = ${nextUsed}, status = ${nextStatus}, redeemed_by = ${userId}, redeemed_at = NOW()
         WHERE code = ${code}
      `;
      return {
        code,
        kind: r.kind,
        amountNanoUsd: r.amount,
        groupName: r.group_name,
        validityDays: r.validity_days,
        subscriptionExpiresAtIso,
      };
    });
  }

  async listUserRedeemHistory(userId: string, limit: number): Promise<RedeemCodeItem[]> {
    const capped = Math.max(1, Math.min(200, limit));
    const claimRows = await this.sql<RedeemRow[]>`
      SELECT c.code, c.kind, cl.amount_nano_usd::text, cl.group_id, g.name AS group_name, cl.validity_days,
             c.status, c.batch_id, c.notes, cl.user_id AS redeemed_by, u.email AS redeemed_by_email,
             cl.redeemed_at, c.expires_at, c.created_at, c.max_uses, c.used_count,
             c.per_user_limit, c.batch_per_user_limit
        FROM commerce.redeem_code_claims cl
        JOIN commerce.redeem_codes c ON c.code = cl.code
        LEFT JOIN core.groups g ON g.id = cl.group_id
        LEFT JOIN commerce.users u ON u.id = cl.user_id
       WHERE cl.user_id = ${userId}
      UNION ALL
      SELECT c.code, c.kind, c.amount_nano_usd::text, c.group_id, g.name AS group_name, c.validity_days,
             c.status, c.batch_id, c.notes, c.redeemed_by, u.email AS redeemed_by_email,
             c.redeemed_at, c.expires_at, c.created_at, c.max_uses, c.used_count,
             c.per_user_limit, c.batch_per_user_limit
        FROM commerce.redeem_codes c
        LEFT JOIN core.groups g ON g.id = c.group_id
        LEFT JOIN commerce.users u ON u.id = c.redeemed_by
       WHERE c.redeemed_by = ${userId}
         AND NOT EXISTS (SELECT 1 FROM commerce.redeem_code_claims cl2 WHERE cl2.code = c.code AND cl2.user_id = ${userId})
       ORDER BY redeemed_at DESC NULLS LAST
       LIMIT ${capped}
    `;
    return claimRows.map((r) => this.toRedeemItem(r));
  }

  async listRedeemCodeClaims(rawCode: string): Promise<RedeemCodeClaimItem[]> {
    const code = normalizeRedeemCode(rawCode);
    const parent = await this.sql<{
      code: string;
      kind: RedeemCodeItem["kind"];
      amount_nano_usd: string;
      group_id: string | null;
      validity_days: number | null;
      batch_id: string;
      redeemed_by: string | null;
      redeemed_by_email: string | null;
      redeemed_at: Date | null;
    }[]>`
      SELECT c.code, c.kind, c.amount_nano_usd::text, c.group_id, c.validity_days, c.batch_id,
             c.redeemed_by, u.email AS redeemed_by_email, c.redeemed_at
        FROM commerce.redeem_codes c
        LEFT JOIN commerce.users u ON u.id = c.redeemed_by
       WHERE c.code = ${code}
    `;
    const p = parent[0];
    if (!p) throw new StoreError("not_found", "Redeem code not found");
    const rows = await this.sql<{
      id: string;
      code: string;
      batch_id: string;
      user_id: string;
      user_email: string | null;
      kind: RedeemCodeItem["kind"];
      amount_nano_usd: string;
      group_id: string | null;
      validity_days: number | null;
      redeemed_at: Date;
    }[]>`
      SELECT cl.id, cl.code, cl.batch_id, cl.user_id, u.email AS user_email, cl.kind,
             cl.amount_nano_usd::text, cl.group_id, cl.validity_days, cl.redeemed_at
        FROM commerce.redeem_code_claims cl
        LEFT JOIN commerce.users u ON u.id = cl.user_id
       WHERE cl.code = ${code}
       ORDER BY cl.redeemed_at DESC
       LIMIT 500
    `;
    if (rows.length === 0 && p.redeemed_by) {
      return [
        {
          id: `legacy_${p.code}`,
          code: p.code,
          batchId: p.batch_id,
          userId: p.redeemed_by,
          userEmail: p.redeemed_by_email ?? "",
          kind: p.kind,
          amountNanoUsd: p.amount_nano_usd,
          groupId: p.group_id,
          validityDays: p.validity_days,
          redeemedAtIso: isoOrNull(p.redeemed_at) ?? new Date(0).toISOString(),
        },
      ];
    }
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      batchId: r.batch_id,
      userId: r.user_id,
      userEmail: r.user_email ?? "",
      kind: r.kind,
      amountNanoUsd: r.amount_nano_usd,
      groupId: r.group_id,
      validityDays: r.validity_days,
      redeemedAtIso: iso(r.redeemed_at),
    }));
  }

  /* ---------------- Promo codes ---------------- */

  private toPromo(r: PromoRow): PromoCodeItem {
    return {
      id: r.id,
      code: r.code,
      bonusNanoUsd: r.bonus_nano_usd,
      maxUses: r.max_uses,
      usedCount: r.used_count,
      enabled: r.enabled,
      expiresAtIso: isoOrNull(r.expires_at),
      notes: r.notes ?? "",
      createdAtIso: iso(r.created_at),
    };
  }

  async listPromoCodes(): Promise<PromoCodeItem[]> {
    const rows = await this.sql<PromoRow[]>`
      SELECT id, code, bonus_nano_usd::text, max_uses, used_count, enabled, expires_at, notes, created_at
        FROM commerce.promo_codes ORDER BY created_at DESC
    `;
    return rows.map((r) => this.toPromo(r));
  }

  async createPromoCode(code: string, req: CreatePromoCodeRequest, bonusNano: bigint): Promise<PromoCodeItem> {
    const id = `promo_${crypto.randomUUID()}`;
    try {
      const rows = await this.sql<PromoRow[]>`
        INSERT INTO commerce.promo_codes (id, code, bonus_nano_usd, max_uses, enabled, expires_at, notes)
        VALUES (${id}, ${code}, ${bonusNano.toString()}::numeric, ${req.maxUses}, ${req.enabled},
                ${req.expiresAtIso ? new Date(req.expiresAtIso) : null}, ${req.notes})
        RETURNING id, code, bonus_nano_usd::text, max_uses, used_count, enabled, expires_at, notes, created_at
      `;
      return this.toPromo(rows[0]!);
    } catch (err) {
      mapConflict(err, `Promo code ${code} already exists`);
    }
  }

  async updatePromoCode(id: string, req: UpdatePromoCodeRequest, bonusNano: bigint | null): Promise<PromoCodeItem> {
    const expiresSent = req.expiresAtIso !== undefined;
    const rows = await this.sql<PromoRow[]>`
      UPDATE commerce.promo_codes
         SET bonus_nano_usd = COALESCE(${bonusNano?.toString() ?? null}::numeric, bonus_nano_usd),
             max_uses = COALESCE(${req.maxUses ?? null}, max_uses),
             enabled = COALESCE(${req.enabled ?? null}, enabled),
             expires_at = CASE WHEN ${expiresSent} THEN ${req.expiresAtIso ? new Date(req.expiresAtIso) : null}::timestamptz ELSE expires_at END,
             notes = COALESCE(${req.notes ?? null}, notes),
             updated_at = NOW()
       WHERE id = ${id}
      RETURNING id, code, bonus_nano_usd::text, max_uses, used_count, enabled, expires_at, notes, created_at
    `;
    if (!rows[0]) throw new StoreError("not_found", "Promo code not found");
    return this.toPromo(rows[0]);
  }

  async deletePromoCode(id: string): Promise<void> {
    const rows = await this.sql`DELETE FROM commerce.promo_codes WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw new StoreError("not_found", "Promo code not found");
  }

  async listPromoCodeUsages(id: string): Promise<PromoCodeUsageItem[]> {
    const rows = await this.sql<{ user_id: string; email: string | null; bonus: string; used_at: Date }[]>`
      SELECT p.user_id, u.email, p.bonus_nano_usd::text AS bonus, p.used_at
        FROM commerce.promo_code_usages p LEFT JOIN commerce.users u ON u.id = p.user_id
       WHERE p.promo_code_id = ${id}
       ORDER BY p.used_at DESC
       LIMIT 500
    `;
    return rows.map((r) => ({ userId: r.user_id, userEmail: r.email ?? "", bonusNanoUsd: r.bonus, usedAtIso: iso(r.used_at) }));
  }

  async checkPromoCode(code: string): Promise<PromoCodeCheckResponse> {
    const rows = await this.sql<PromoRow[]>`
      SELECT id, code, bonus_nano_usd::text, max_uses, used_count, enabled, expires_at, notes, created_at
        FROM commerce.promo_codes WHERE code = ${code.trim().toUpperCase()}
    `;
    const p = rows[0];
    if (!p) return { valid: false, bonusNanoUsd: "0", reason: "not_found" };
    let reason: PromoCodeCheckResponse["reason"] = "ok";
    if (!p.enabled) reason = "disabled";
    else if (p.expires_at && p.expires_at.getTime() <= Date.now()) reason = "expired";
    else if (p.max_uses > 0 && p.used_count >= p.max_uses) reason = "exhausted";
    return { valid: reason === "ok", bonusNanoUsd: p.bonus_nano_usd, reason };
  }

  /* ---------------- Announcements ---------------- */

  private toAnnouncement(r: AnnouncementRow): AnnouncementItem {
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      level: r.level,
      status: r.status,
      audience: r.audience,
      pinned: r.pinned,
      popup: r.popup,
      startsAtIso: isoOrNull(r.starts_at),
      endsAtIso: isoOrNull(r.ends_at),
      createdAtIso: iso(r.created_at),
      updatedAtIso: iso(r.updated_at),
      readCount: r.read_count ?? 0,
      targeting: storedTargeting(r.targeting),
    };
  }

  private announcementSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT a.*, (SELECT COUNT(*) FROM commerce.announcement_reads r WHERE r.announcement_id = a.id)::int AS read_count
        FROM commerce.announcements a WHERE ${where}
    `;
  }

  async listAnnouncements(): Promise<AnnouncementItem[]> {
    const rows = await this.sql<AnnouncementRow[]>`
      ${this.announcementSelect(this.sql`TRUE`)} ORDER BY a.pinned DESC, a.created_at DESC
    `;
    return rows.map((r) => this.toAnnouncement(r));
  }

  async createAnnouncement(req: UpsertAnnouncementRequest, createdBy: string): Promise<AnnouncementItem> {
    const id = `ann_${crypto.randomUUID()}`;
    const targeting = this.sql.json((req.targeting ?? { anyOf: [] }) as unknown as postgres.JSONValue);
    await this.sql`
      INSERT INTO commerce.announcements (id, title, content, level, status, audience, pinned, popup, starts_at, ends_at, created_by, targeting)
      VALUES (${id}, ${req.title}, ${req.content}, ${req.level}, ${req.status}, ${req.audience}, ${req.pinned}, ${req.popup},
              ${req.startsAtIso ? new Date(req.startsAtIso) : null}, ${req.endsAtIso ? new Date(req.endsAtIso) : null}, ${createdBy},
              ${targeting})
    `;
    const rows = await this.sql<AnnouncementRow[]>`${this.announcementSelect(this.sql`a.id = ${id}`)}`;
    return this.toAnnouncement(rows[0]!);
  }

  async updateAnnouncement(id: string, req: UpsertAnnouncementRequest): Promise<AnnouncementItem> {
    // Omitted targeting keeps the stored rule.
    const targeting = req.targeting ? this.sql.json(req.targeting as unknown as postgres.JSONValue) : null;
    const updated = await this.sql`
      UPDATE commerce.announcements
         SET title = ${req.title}, content = ${req.content}, level = ${req.level}, status = ${req.status},
             audience = ${req.audience}, pinned = ${req.pinned}, popup = ${req.popup},
             starts_at = ${req.startsAtIso ? new Date(req.startsAtIso) : null},
             ends_at = ${req.endsAtIso ? new Date(req.endsAtIso) : null},
             targeting = COALESCE(${targeting}::jsonb, targeting), updated_at = NOW()
       WHERE id = ${id} RETURNING id
    `;
    if (updated.length === 0) throw new StoreError("not_found", "Announcement not found");
    const rows = await this.sql<AnnouncementRow[]>`${this.announcementSelect(this.sql`a.id = ${id}`)}`;
    return this.toAnnouncement(rows[0]!);
  }

  async deleteAnnouncement(id: string): Promise<void> {
    const rows = await this.sql`DELETE FROM commerce.announcements WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw new StoreError("not_found", "Announcement not found");
  }

  async listAnnouncementReaders(id: string): Promise<AnnouncementReader[]> {
    const exists = await this.sql`SELECT 1 FROM commerce.announcements WHERE id = ${id}`;
    if (exists.length === 0) throw new StoreError("not_found", "Announcement not found");
    const rows = await this.sql<{ user_id: string; email: string | null; read_at: Date }[]>`
      SELECT r.user_id, u.email, r.read_at
        FROM commerce.announcement_reads r LEFT JOIN commerce.users u ON u.id = r.user_id
       WHERE r.announcement_id = ${id}
       ORDER BY r.read_at DESC
       LIMIT 1000
    `;
    return rows.map((r) => ({ userId: r.user_id, email: r.email ?? "", readAtIso: iso(r.read_at) }));
  }

  private visibleTo(role: UserRole): Fragment {
    const audience = role === "admin" ? "admins" : "users";
    return this.sql`
      a.status = 'published' AND a.audience IN ('all', ${audience})
      AND (a.starts_at IS NULL OR a.starts_at <= NOW()) AND (a.ends_at IS NULL OR a.ends_at > NOW())
    `;
  }

  async listAnnouncementReadStatus(id: string, query: AnnouncementReadStatusQuery): Promise<AnnouncementReadStatusResponse> {
    const rows = await this.sql<{ audience: AnnouncementItem["audience"]; targeting: unknown }[]>`
      SELECT audience, targeting FROM commerce.announcements WHERE id = ${id}
    `;
    if (rows.length === 0) throw new StoreError("not_found", "Announcement not found");
    return readStatusPage(this.sql, id, rows[0]!.audience, storedTargeting(rows[0]!.targeting), query);
  }

  /**
   * Live, audience-matching announcements this user's targeting admits. Targeting is evaluated in
   * TypeScript (targetingMatches, shared with MemoryOpsStore) over a bounded candidate set.
   */
  private async visibleRows(userId: string, role: UserRole, only: Fragment): Promise<AnnouncementRow[]> {
    const rows = await this.sql<AnnouncementRow[]>`
      SELECT a.*, EXISTS (
               SELECT 1 FROM commerce.announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ${userId}
             ) AS is_read
        FROM commerce.announcements a
       WHERE ${this.visibleTo(role)} AND ${only}
       ORDER BY a.pinned DESC, COALESCE(a.starts_at, a.created_at) DESC
       LIMIT ${ANNOUNCEMENT_FEED_CANDIDATES}
    `;
    return filterTargeted(this.sql, userId, rows, (r) => storedTargeting(r.targeting));
  }

  async listUserAnnouncements(userId: string, role: UserRole): Promise<UserAnnouncementItem[]> {
    const rows = await this.visibleRows(userId, role, this.sql`TRUE`);
    return rows.slice(0, 50).map((r) => {
      const { status: _s, audience: _a, readCount: _c, targeting: _t, ...rest } = this.toAnnouncement(r);
      return { ...rest, read: Boolean(r.is_read) };
    });
  }

  async markAnnouncementsRead(userId: string, ids: string[] | "all", role: UserRole): Promise<void> {
    if (ids !== "all" && ids.length === 0) return;
    // Only what this user may see right now: no read marks on drafts, other audiences or
    // announcements whose targeting they do not meet.
    const only = ids === "all" ? this.sql`TRUE` : this.sql`a.id = ANY(${ids})`;
    const allowed = (await this.visibleRows(userId, role, only)).filter((r) => !r.is_read).map((r) => r.id);
    if (allowed.length === 0) return;
    await this.sql`
      INSERT INTO commerce.announcement_reads (announcement_id, user_id)
      SELECT a.id, ${userId} FROM commerce.announcements a WHERE a.id = ANY(${allowed})
      ON CONFLICT DO NOTHING
    `;
  }

  /* ---------------- Audit ---------------- */

  async recordAudit(e: AuditLogInput): Promise<void> {
    await this.sql`
      INSERT INTO commerce.audit_logs (id, actor_id, actor_email, actor_role, method, route, path, target_id,
                                       status_code, ip, user_agent, duration_ms, request_body)
      VALUES (${`aud_${crypto.randomUUID()}`}, ${e.actorId}, ${e.actorEmail}, ${e.actorRole}, ${e.method}, ${e.route},
              ${e.path}, ${e.targetId}, ${e.statusCode}, ${e.ip}, ${e.userAgent}, ${e.durationMs}, ${e.requestBody})
    `;
  }

  async listAudit(query: AuditLogQuery): Promise<{ items: AuditLogItem[]; total: number }> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (query.method) parts.push(sql`method = ${query.method}`);
    if (query.actorId) parts.push(sql`actor_id = ${query.actorId}`);
    if (query.outcome === "success") parts.push(sql`status_code < 400`);
    if (query.outcome === "failure") parts.push(sql`status_code >= 400`);
    if (query.sinceIso) parts.push(sql`created_at >= ${new Date(query.sinceIso)}`);
    if (query.untilIso) parts.push(sql`created_at < ${new Date(query.untilIso)}`);
    if (query.search) {
      const p = likePattern(query.search);
      parts.push(sql`(actor_email ILIKE ${p} OR path ILIKE ${p} OR route ILIKE ${p} OR ip ILIKE ${p} OR target_id ILIKE ${p})`);
    }
    const where = and(sql, parts);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const [rows, totals] = await Promise.all([
      sql<
        {
          id: string; actor_id: string; actor_email: string; actor_role: string; method: string; route: string; path: string;
          target_id: string; status_code: number; ip: string; user_agent: string; duration_ms: number; request_body: string; created_at: Date;
        }[]
      >`SELECT * FROM commerce.audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM commerce.audit_logs WHERE ${where}`,
    ]);
    return {
      total: totals[0]?.n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        actorRole: r.actor_role,
        method: r.method,
        route: r.route,
        path: r.path,
        targetId: r.target_id,
        statusCode: r.status_code,
        ip: r.ip,
        userAgent: r.user_agent,
        durationMs: r.duration_ms,
        requestBody: r.request_body,
        createdAtIso: iso(r.created_at),
      })),
    };
  }

  async clearAudit(): Promise<number> {
    const result = await this.sql`DELETE FROM commerce.audit_logs`;
    return result.count;
  }

  async deleteAuditBefore(cutoff: Date, limit = AUDIT_DELETE_BATCH): Promise<number> {
    const max = Math.max(1, Math.floor(limit));
    // Oldest first on idx_commerce_audit_logs_created; SKIP LOCKED lets concurrent sweepers on
    // other instances take disjoint batches instead of queueing on the same rows.
    const result = await this.sql`
      DELETE FROM commerce.audit_logs
       WHERE id IN (
         SELECT id FROM commerce.audit_logs
          WHERE created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${max}
          FOR UPDATE SKIP LOCKED
       )
    `;
    return result.count;
  }

  /* ---------------- Subscriptions ---------------- */

  /**
   * Subscriptions with group caps and spend over their rolling windows (honouring resets). The
   * spend is the (user, group) pair's whatever the row's status, as MemoryOpsStore reports it:
   * an expired or revoked row shows what would count against it the moment it is extended or
   * reactivated (each sum is index-only on idx_core_usage_logs_user_group_time_cost).
   */
  private subscriptionSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT s.id, s.user_id, u.email AS user_email, s.group_id, g.name AS group_name, s.status, s.source, s.notes,
             s.starts_at, s.expires_at, s.usage_reset_at, s.daily_reset_at, s.weekly_reset_at, s.monthly_reset_at,
             s.created_at,
             g.daily_limit_nano_usd::text AS daily_limit, g.weekly_limit_nano_usd::text AS weekly_limit,
             g.monthly_limit_nano_usd::text AS monthly_limit,
             COALESCE(x.d, 0)::text AS daily_used, COALESCE(x.w, 0)::text AS weekly_used, COALESCE(x.m, 0)::text AS monthly_used
        FROM commerce.subscriptions s
        LEFT JOIN commerce.users u ON u.id = s.user_id
        LEFT JOIN core.groups g ON g.id = s.group_id
        LEFT JOIN LATERAL (
          SELECT SUM(l.cost_nano_usd) FILTER (
                   WHERE l.created_at >= NOW() - INTERVAL '1 day'
                     AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                     AND (s.daily_reset_at IS NULL OR l.created_at > s.daily_reset_at)
                 ) AS d,
                 SUM(l.cost_nano_usd) FILTER (
                   WHERE l.created_at >= NOW() - INTERVAL '7 days'
                     AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                     AND (s.weekly_reset_at IS NULL OR l.created_at > s.weekly_reset_at)
                 ) AS w,
                 SUM(l.cost_nano_usd) FILTER (
                   WHERE (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                     AND (s.monthly_reset_at IS NULL OR l.created_at > s.monthly_reset_at)
                 ) AS m
            FROM core.usage_logs l
           WHERE l.user_id = s.user_id AND l.group_id = s.group_id
             AND l.created_at >= GREATEST(NOW() - INTERVAL '30 days', COALESCE(s.usage_reset_at, '-infinity'::timestamptz))
             AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
        ) x ON TRUE
       WHERE ${where}
    `;
  }

  private toSub(r: SubscriptionRow, nowMs = Date.now()): UserSubscriptionItem {
    const limits = {
      dailyLimitNanoUsd: r.daily_limit ?? "0",
      weeklyLimitNanoUsd: r.weekly_limit ?? "0",
      monthlyLimitNanoUsd: r.monthly_limit ?? "0",
    };
    const usage = { dailyNanoUsd: r.daily_used, weeklyNanoUsd: r.weekly_used, monthlyNanoUsd: r.monthly_used };
    const expiresAtIso = iso(r.expires_at);
    return {
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email ?? "",
      groupId: r.group_id,
      groupName: r.group_name ?? r.group_id,
      status: effectiveSubscriptionStatus(r.status, expiresAtIso, nowMs),
      source: r.source ?? "admin",
      notes: r.notes ?? "",
      startsAtIso: iso(r.starts_at),
      expiresAtIso,
      usageResetAtIso: isoOrNull(r.usage_reset_at),
      dailyResetAtIso: isoOrNull(r.daily_reset_at),
      weeklyResetAtIso: isoOrNull(r.weekly_reset_at),
      monthlyResetAtIso: isoOrNull(r.monthly_reset_at),
      createdAtIso: iso(r.created_at),
      limits,
      usage,
      overLimit: subscriptionOverLimit(limits, usage),
    };
  }

  async listSubscriptions(query: UserSubscriptionListQuery): Promise<{ items: UserSubscriptionItem[]; total: number }> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (query.status === "active") parts.push(sql`s.status = 'active' AND s.expires_at > NOW()`);
    if (query.status === "expired") parts.push(sql`s.status = 'active' AND s.expires_at <= NOW()`);
    if (query.status === "revoked") parts.push(sql`s.status = 'revoked'`);
    if (query.groupId) parts.push(sql`s.group_id = ${query.groupId}`);
    if (query.userId) parts.push(sql`s.user_id = ${query.userId}`);
    if (query.search) {
      const p = likePattern(query.search);
      parts.push(sql`(u.email ILIKE ${p} OR g.name ILIKE ${p})`);
    }
    const where = and(sql, parts);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const [rows, totals] = await Promise.all([
      sql<SubscriptionRow[]>`${this.subscriptionSelect(where)} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM commerce.subscriptions s
          LEFT JOIN commerce.users u ON u.id = s.user_id LEFT JOIN core.groups g ON g.id = s.group_id
         WHERE ${where}
      `,
    ]);
    const now = Date.now();
    return { items: rows.map((r) => this.toSub(r, now)), total: totals[0]?.n ?? 0 };
  }

  async listUserSubscriptions(userId: string): Promise<UserSubscriptionItem[]> {
    const rows = await this.sql<SubscriptionRow[]>`
      ${this.subscriptionSelect(this.sql`s.user_id = ${userId}`)} ORDER BY s.expires_at DESC LIMIT 100
    `;
    const now = Date.now();
    return rows.map((r) => this.toSub(r, now));
  }

  private async loadSub(id: string): Promise<UserSubscriptionItem> {
    const rows = await this.sql<SubscriptionRow[]>`${this.subscriptionSelect(this.sql`s.id = ${id}`)}`;
    if (!rows[0]) throw new StoreError("not_found", "Subscription not found");
    return this.toSub(rows[0]);
  }

  async assignSubscription(userId: string, groupId: string, validityDays: number, notes: string, source: string): Promise<UserSubscriptionItem> {
    const id = await this.sql.begin((txRaw) => pgAssignSubscriptionTx(txRaw as unknown as Sql, userId, groupId, validityDays, notes, source));
    return this.loadSub(id);
  }

  async updateSubscription(
    id: string,
    action: SubscriptionAction,
    days: number,
    notes?: string,
    resetWindow: "all" | "daily" | "weekly" | "monthly" = "all",
  ): Promise<UserSubscriptionItem> {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<{ starts_at: Date; expires_at: Date }[]>`
        SELECT starts_at, expires_at FROM commerce.subscriptions WHERE id = ${id} FOR UPDATE
      `;
      const cur = rows[0];
      if (!cur) throw new StoreError("not_found", "Subscription not found");
      switch (action) {
        case "extend": {
          if (days === 0) break;
          const now = Date.now();
          const expired = cur.expires_at.getTime() <= now;
          if (expired && days < 0) throw new StoreError("bad_request", "An expired subscription cannot be shortened");
          const start = expired ? now : cur.starts_at.getTime();
          const next = (expired ? now : cur.expires_at.getTime()) + days * 86_400_000;
          if (next <= start) throw new StoreError("bad_request", "That would end the subscription before it starts");
          await tx`
            UPDATE commerce.subscriptions SET starts_at = ${new Date(start)}, expires_at = ${new Date(next)}, updated_at = NOW()
             WHERE id = ${id}
          `;
          break;
        }
        case "revoke":
          await tx`UPDATE commerce.subscriptions SET status = 'revoked', updated_at = NOW() WHERE id = ${id}`;
          break;
        case "reactivate":
          await tx`UPDATE commerce.subscriptions SET status = 'active', updated_at = NOW() WHERE id = ${id}`;
          break;
        case "reset_usage":
          if (resetWindow === "all") {
            await tx`
              UPDATE commerce.subscriptions
                 SET usage_reset_at = NOW(), daily_reset_at = NOW(), weekly_reset_at = NOW(),
                     monthly_reset_at = NOW(), updated_at = NOW()
               WHERE id = ${id}
            `;
          } else if (resetWindow === "daily") {
            await tx`UPDATE commerce.subscriptions SET daily_reset_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
          } else if (resetWindow === "weekly") {
            await tx`UPDATE commerce.subscriptions SET weekly_reset_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
          } else if (resetWindow === "monthly") {
            await tx`UPDATE commerce.subscriptions SET monthly_reset_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
          }
          break;
      }
      if (notes !== undefined) await tx`UPDATE commerce.subscriptions SET notes = ${notes} WHERE id = ${id}`;
    });
    return this.loadSub(id);
  }

  async deleteSubscription(id: string): Promise<void> {
    const rows = await this.sql`DELETE FROM commerce.subscriptions WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw new StoreError("not_found", "Subscription not found");
  }

  private async entitlementRows(filter: Fragment): Promise<{ user_id: string; group_id: string; usable: boolean }[]> {
    return this.sql<{ user_id: string; group_id: string; usable: boolean }[]>`
      SELECT x.user_id, x.group_id, bool_or(x.usable) AS usable FROM (
        SELECT s.user_id, s.group_id,
               (g.daily_limit_nano_usd = 0 OR COALESCE(t.d, 0) < g.daily_limit_nano_usd)
           AND (g.weekly_limit_nano_usd = 0 OR COALESCE(t.w, 0) < g.weekly_limit_nano_usd)
           AND (g.monthly_limit_nano_usd = 0 OR COALESCE(t.m, 0) < g.monthly_limit_nano_usd) AS usable
          FROM commerce.subscriptions s
          JOIN core.groups g ON g.id = s.group_id
          LEFT JOIN LATERAL (
            SELECT SUM(l.cost_nano_usd) FILTER (
                     WHERE l.created_at >= NOW() - INTERVAL '1 day'
                       AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                       AND (s.daily_reset_at IS NULL OR l.created_at > s.daily_reset_at)
                   ) AS d,
                   SUM(l.cost_nano_usd) FILTER (
                     WHERE l.created_at >= NOW() - INTERVAL '7 days'
                       AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                       AND (s.weekly_reset_at IS NULL OR l.created_at > s.weekly_reset_at)
                   ) AS w,
                   SUM(l.cost_nano_usd) FILTER (
                     WHERE (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
                       AND (s.monthly_reset_at IS NULL OR l.created_at > s.monthly_reset_at)
                   ) AS m
              FROM core.usage_logs l
             WHERE l.user_id = s.user_id AND l.group_id = s.group_id
               AND l.created_at >= GREATEST(NOW() - INTERVAL '30 days', COALESCE(s.usage_reset_at, '-infinity'::timestamptz))
               AND (s.usage_reset_at IS NULL OR l.created_at > s.usage_reset_at)
               -- Inside the lateral this is a one-time filter: an uncapped group never scans usage
               -- (as an ON condition alone it would be checked only after the scan).
               AND (g.daily_limit_nano_usd > 0 OR g.weekly_limit_nano_usd > 0 OR g.monthly_limit_nano_usd > 0)
          ) t ON (g.daily_limit_nano_usd > 0 OR g.weekly_limit_nano_usd > 0 OR g.monthly_limit_nano_usd > 0)
         WHERE s.status = 'active' AND s.expires_at > NOW() AND s.starts_at <= NOW() AND ${filter}
      ) x
      GROUP BY x.user_id, x.group_id
    `;
  }

  async subscriptionEntitlements(): Promise<SubscriptionEntitlement[]> {
    const rows = await this.entitlementRows(this.sql`TRUE`);
    return rows.map((r) => ({ userId: r.user_id, groupId: r.group_id, usable: r.usable }));
  }

  async isSubscriptionOverLimit(userId: string, groupId: string): Promise<boolean> {
    const rows = await this.entitlementRows(this.sql`s.user_id = ${userId} AND s.group_id = ${groupId}`);
    return !rows[0]?.usable;
  }

  /* ---------------- Usage ---------------- */

  private usageWhere(q: Omit<UsageQuery, "page" | "pageSize">, scope?: { managedGroupIds?: string[] }): Fragment {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (scope?.managedGroupIds !== undefined) {
      if (scope.managedGroupIds.length === 0) parts.push(sql`FALSE`);
      else parts.push(sql`l.group_id = ANY(${scope.managedGroupIds})`);
    }
    if (q.userId) parts.push(sql`l.user_id = ${q.userId}`);
    if (q.apiKeyId) parts.push(sql`l.api_key_id = ${q.apiKeyId}`);
    if (q.groupId) parts.push(sql`l.group_id = ${q.groupId}`);
    if (q.accountId) parts.push(sql`l.account_id = ${q.accountId}`);
    if (q.model) parts.push(sql`l.public_model ILIKE ${likePattern(q.model)}`);
    if (q.outcome === "success") parts.push(sql`l.status_code < 400`);
    if (q.outcome === "error") parts.push(sql`l.status_code >= 400`);
    if (q.sinceIso) parts.push(sql`l.created_at >= ${new Date(q.sinceIso)}`);
    if (q.untilIso) parts.push(sql`l.created_at < ${new Date(q.untilIso)}`);
    return and(sql, parts);
  }

  private usageRows(where: Fragment, limit: number, offset: number): Fragment {
    return this.sql`
      SELECT l.id, l.request_id, l.user_id, l.api_key_id, l.account_id, l.group_id, l.platform, l.public_model,
             l.upstream_model, l.ingress_codec, l.egress_codec, l.input_tokens::int, l.output_tokens::int,
             l.cache_read_tokens::int, l.cache_write_tokens::int, l.cost_nano_usd::text, COALESCE(l.ttft_ms, 0) AS ttft_ms,
             COALESCE(l.duration_ms, 0) AS duration_ms, l.status_code, l.created_at,
             COALESCE(u.email, '') AS user_email, COALESCE(k.name, '') AS api_key_name,
             COALESCE(g.name, '') AS group_name, COALESCE(a.name, '') AS account_name
        FROM (SELECT * FROM core.usage_logs l WHERE ${where} ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}) l
        LEFT JOIN commerce.users u ON u.id = l.user_id
        LEFT JOIN core.api_keys k ON k.id = l.api_key_id
        LEFT JOIN core.groups g ON g.id = l.group_id
        LEFT JOIN core.accounts a ON a.id = l.account_id
       ORDER BY l.created_at DESC
    `;
  }

  private toRow(r: Record<string, unknown>): UsageRow {
    const cost = String(r.cost_nano_usd ?? "0");
    return {
      id: String(r.id),
      requestId: String(r.request_id),
      userId: String(r.user_id),
      apiKeyId: String(r.api_key_id),
      accountId: String(r.account_id),
      groupId: String(r.group_id),
      platform: r.platform as UsageRow["platform"],
      publicModel: String(r.public_model),
      upstreamModel: String(r.upstream_model),
      ingressCodec: String(r.ingress_codec),
      egressCodec: String(r.egress_codec),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      cacheReadTokens: Number(r.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
      costNanoUsd: cost,
      ttftMs: Number(r.ttft_ms ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: Number(r.status_code),
      formattedCostUsd: formatNanoUsd(BigInt(cost)),
      createdAtIso: iso(r.created_at as Date),
      userEmail: String(r.user_email ?? ""),
      apiKeyName: String(r.api_key_name ?? ""),
      groupName: String(r.group_name ?? ""),
      accountName: String(r.account_name ?? ""),
    };
  }

  async queryUsage(query: UsageQuery, scope?: { managedGroupIds?: string[] }): Promise<UsagePageResponse> {
    const where = this.usageWhere(query, scope);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    if (query.summary === false) {
      // Rows only: no COUNT/SUM over every matching row (the summary is unbounded in time).
      const rows = await this.sql<Record<string, unknown>[]>`${this.usageRows(where, limit, offset)}`;
      return { items: rows.map((r) => this.toRow(r)), total: offset + rows.length, summary: null };
    }
    const [rows, summary] = await Promise.all([
      this.sql<Record<string, unknown>[]>`${this.usageRows(where, limit, offset)}`,
      this.sql<
        { requests: number; errors: number; input: string; output: string; cache_read: string; cache_write: string; cost: string; avg_duration: number | null; avg_ttft: number | null }[]
      >`
        SELECT COUNT(*)::int AS requests,
               COUNT(*) FILTER (WHERE l.status_code >= 400)::int AS errors,
               COALESCE(SUM(l.input_tokens), 0)::text AS input,
               COALESCE(SUM(l.output_tokens), 0)::text AS output,
               COALESCE(SUM(l.cache_read_tokens), 0)::text AS cache_read,
               COALESCE(SUM(l.cache_write_tokens), 0)::text AS cache_write,
               COALESCE(SUM(l.cost_nano_usd), 0)::text AS cost,
               AVG(l.duration_ms) FILTER (WHERE l.duration_ms > 0)::float8 AS avg_duration,
               AVG(l.ttft_ms) FILTER (WHERE l.ttft_ms > 0)::float8 AS avg_ttft
          FROM core.usage_logs l WHERE ${where}
      `,
    ]);
    const s = summary[0]!;
    return {
      items: rows.map((r) => this.toRow(r)),
      total: s.requests,
      summary: {
        requests: s.requests,
        errors: s.errors,
        inputTokens: Number(s.input),
        outputTokens: Number(s.output),
        cacheReadTokens: Number(s.cache_read),
        cacheWriteTokens: Number(s.cache_write),
        costNanoUsd: s.cost,
        avgDurationMs: Math.round(s.avg_duration ?? 0),
        avgTtftMs: Math.round(s.avg_ttft ?? 0),
      },
    };
  }

  async exportUsage(query: UsageExportQuery): Promise<UsageRow[]> {
    const rows = await this.sql<Record<string, unknown>[]>`${this.usageRows(this.usageWhere(query), query.limit, 0)}`;
    return rows.map((r) => this.toRow(r));
  }

  /* ---------------- Usage aggregates ---------------- */

  /** Bucket index of `l.created_at` (epoch-ms arithmetic, as the JS reducers do). */
  private bucketOf(startMs: number, bucketMs: number): Fragment {
    return this.sql`FLOOR((EXTRACT(EPOCH FROM l.created_at) * 1000 - ${String(startMs)}::numeric) / ${String(bucketMs)}::numeric)::int`;
  }

  /** UsageSums columns over the rows of subquery `x`. */
  private sumsColumns(): Fragment {
    return this.sql`
      COUNT(*)::int AS requests,
      COUNT(*) FILTER (WHERE x.status_code >= 400)::int AS errors,
      COALESCE(SUM(x.input_tokens), 0)::text AS input_tokens,
      COALESCE(SUM(x.output_tokens), 0)::text AS output_tokens,
      COALESCE(SUM(x.cache_read_tokens), 0)::text AS cache_read_tokens,
      COALESCE(SUM(x.cost_nano_usd), 0)::text AS cost,
      COALESCE(SUM(x.duration_ms) FILTER (WHERE x.duration_ms > 0), 0)::text AS duration_sum,
      COUNT(*) FILTER (WHERE x.duration_ms > 0)::int AS duration_count,
      COALESCE(SUM(x.ttft_ms) FILTER (WHERE x.ttft_ms > 0), 0)::text AS ttft_sum,
      COUNT(*) FILTER (WHERE x.ttft_ms > 0)::int AS ttft_count
    `;
  }

  async scopedUsage(q: ScopedUsageQuery): Promise<ScopedUsageAggregate> {
    const sql = this.sql;
    const scope: Fragment[] = [];
    if (q.userId !== undefined) scope.push(sql`l.user_id = ${q.userId}`);
    if (q.apiKeyId !== undefined) scope.push(sql`l.api_key_id = ${q.apiKeyId}`);
    if (scope.length === 0) throw new StoreError("bad_request", "A user or key scope is required");
    const where = and(sql, scope);
    const plan = scopedUsagePlan(q);
    const now = new Date(plan.nowMs);
    // Local midnight never precedes the period start (dashboardWindow), so today's rows are a
    // subset of the period: one index range scan (user_time or key_time_cost) yields every
    // grouping, today included. Exact, so its cost follows the scope's traffic: it runs on one
    // pooled connection under SCOPED_USAGE_TIMEOUT_MS, and the routes cache and budget it.
    const groups = await pgReadWithTimeout(
      sql,
      SCOPED_USAGE_TIMEOUT_MS,
      (tx) => tx<(SumsRow & { g: number; b: number | null; public_model: string | null; api_key_id: string | null; today: boolean | null })[]>`
        SELECT GROUPING(x.b, x.public_model, x.api_key_id, x.today)::int AS g, x.b, x.public_model, x.api_key_id, x.today,
               ${this.sumsColumns()}
          FROM (
            SELECT ${this.bucketOf(plan.periodStartMs, plan.bucketMs)} AS b, l.public_model, l.api_key_id,
                   l.created_at >= ${new Date(plan.todayStartMs)} AS today, l.status_code,
                   l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cost_nano_usd, l.duration_ms, l.ttft_ms
              FROM core.usage_logs l
             WHERE ${where} AND l.created_at >= ${new Date(plan.periodStartMs)} AND l.created_at <= ${now}
          ) x
         GROUP BY GROUPING SETS ((), (x.b), (x.public_model), (x.api_key_id), (x.today))
      `,
    );
    const agg = emptyScopedUsageAggregate();
    for (const r of groups) {
      // GROUPING bits (b, model, key, today), 1 = rolled up: 15 = grand total, 7 = per bucket,
      // 11 = per model, 13 = per key, 14 = today vs earlier.
      if (r.g === 15) agg.period = sumsOf(r);
      else if (r.g === 7 && r.b !== null) agg.buckets.set(r.b, sumsOf(r));
      else if (r.g === 11 && r.public_model !== null) agg.models.set(r.public_model, sumsOf(r));
      else if (r.g === 13 && r.api_key_id !== null) agg.keys.set(r.api_key_id, sumsOf(r));
      else if (r.g === 14 && r.today === true) agg.today = sumsOf(r);
    }
    return agg;
  }

  async channelStatusUsage(q: ChannelStatusQuery): Promise<ChannelStatusAggregate> {
    const out: ChannelStatusAggregate = new Map();
    if (q.groupIds.length === 0) return out;
    // Per-group index range scans (idx_core_usage_logs_group_time) over exactly the 24h window.
    const rows = await this.sql<
      { group_id: string; b: number; requests: number; errors: number; ttft_sum: string; ttft_count: number; duration_sum: string; duration_count: number; last_at: Date }[]
    >`
      SELECT x.group_id, x.b, COUNT(*)::int AS requests,
             COUNT(*) FILTER (WHERE x.status_code >= 400)::int AS errors,
             COALESCE(SUM(x.ttft_ms) FILTER (WHERE x.ttft_ms > 0), 0)::text AS ttft_sum,
             COUNT(*) FILTER (WHERE x.ttft_ms > 0)::int AS ttft_count,
             COALESCE(SUM(x.duration_ms) FILTER (WHERE x.duration_ms > 0), 0)::text AS duration_sum,
             COUNT(*) FILTER (WHERE x.duration_ms > 0)::int AS duration_count,
             MAX(x.created_at) AS last_at
        FROM (
          SELECT l.group_id, ${this.bucketOf(q.startMs, q.bucketMs)} AS b, l.status_code, l.ttft_ms, l.duration_ms, l.created_at
            FROM core.usage_logs l
           WHERE l.group_id = ANY(${q.groupIds}) AND l.created_at >= ${new Date(q.startMs)} AND l.created_at < ${new Date(q.endMs)}
        ) x
       GROUP BY x.group_id, x.b
    `;
    for (const r of rows) {
      let group = out.get(r.group_id);
      if (!group) {
        group = new Map();
        out.set(r.group_id, group);
      }
      group.set(r.b, {
        requests: r.requests,
        errors: r.errors,
        ttftSum: Number(r.ttft_sum),
        ttftCount: r.ttft_count,
        durationSum: Number(r.duration_sum),
        durationCount: r.duration_count,
        lastMs: r.last_at ? new Date(r.last_at).getTime() : 0,
      });
    }
    return out;
  }

  async opsUsage(q: OpsUsageQuery): Promise<OpsUsageAggregate> {
    const sql = this.sql;
    const since = new Date(q.sinceMs);
    const now = new Date(q.nowMs);
    const lastMinute = new Date(q.nowMs - 60_000);
    type OpsRow = {
      g: number;
      b: number | null;
      account_id: string | null;
      public_model: string | null;
      status_code: number | null;
      requests: number;
      errors: number;
      input_tokens: string;
      output_tokens: string;
      cost: string;
      recent_requests: number;
      recent_tokens: string;
      ttft_p: number[] | null;
      duration_p: number[] | null;
    };
    // One scan of the window (idx_core_usage_logs_time), five groupings; nearest-rank
    // percentiles via percentile_disc over every row, so they are exact, not sampled.
    const [groups, errors] = await Promise.all([
      sql<OpsRow[]>`
        SELECT GROUPING(x.b, x.account_id, x.public_model, x.status_code)::int AS g,
               x.b, x.account_id, x.public_model, x.status_code,
               COUNT(*)::int AS requests,
               COUNT(*) FILTER (WHERE x.status_code >= 400)::int AS errors,
               COALESCE(SUM(x.input_tokens), 0)::text AS input_tokens,
               COALESCE(SUM(x.output_tokens), 0)::text AS output_tokens,
               COALESCE(SUM(x.cost_nano_usd), 0)::text AS cost,
               COUNT(*) FILTER (WHERE x.recent)::int AS recent_requests,
               COALESCE(SUM(x.input_tokens + x.output_tokens) FILTER (WHERE x.recent), 0)::text AS recent_tokens,
               percentile_disc(ARRAY[0.5, 0.95]::float8[]) WITHIN GROUP (ORDER BY x.ttft_ms) FILTER (WHERE x.ttft_ms > 0) AS ttft_p,
               percentile_disc(ARRAY[0.5, 0.95, 0.99]::float8[]) WITHIN GROUP (ORDER BY x.duration_ms)
                 FILTER (WHERE x.duration_ms > 0) AS duration_p
          FROM (
            SELECT ${this.bucketOf(q.bucketStartMs, q.bucketMs)} AS b, l.account_id, l.public_model, l.status_code,
                   l.input_tokens, l.output_tokens, l.cost_nano_usd, l.ttft_ms, l.duration_ms,
                   l.created_at > ${lastMinute} AS recent
              FROM core.usage_logs l
             WHERE l.created_at >= ${since} AND l.created_at <= ${now}
          ) x
         GROUP BY GROUPING SETS ((), (x.b), (x.account_id), (x.public_model), (x.status_code))
      `,
      sql<
        { id: string; created_at: Date; request_id: string; user_id: string; user_email: string; public_model: string; account_id: string; group_id: string; group_name: string; status_code: number; duration_ms: number }[]
      >`
        SELECT l.id, l.created_at, l.request_id, l.user_id, COALESCE(u.email, '') AS user_email, l.public_model,
               l.account_id, l.group_id, COALESCE(g.name, '') AS group_name, l.status_code,
               COALESCE(l.duration_ms, 0) AS duration_ms
          FROM (
            SELECT * FROM core.usage_logs
             WHERE created_at >= ${since} AND created_at <= ${now} AND status_code >= 400
             ORDER BY created_at DESC, id DESC
             LIMIT ${OPS_RECENT_ERRORS}
          ) l
          LEFT JOIN commerce.users u ON u.id = l.user_id
          LEFT JOIN core.groups g ON g.id = l.group_id
         ORDER BY l.created_at DESC, l.id DESC
      `,
    ]);
    const sums = (r: OpsRow): OpsGroupSums => {
      const ttft = intArray(r.ttft_p);
      const duration = intArray(r.duration_p);
      return {
        requests: r.requests,
        errors: r.errors,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        costNano: nanoFromText(r.cost),
        ttftP50: ttft[0] ?? 0,
        ttftP95: ttft[1] ?? 0,
        durationP50: duration[0] ?? 0,
        durationP95: duration[1] ?? 0,
        durationP99: duration[2] ?? 0,
      };
    };
    const zero: OpsGroupSums = {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      costNano: 0n,
      ttftP50: 0,
      ttftP95: 0,
      durationP50: 0,
      durationP95: 0,
      durationP99: 0,
    };
    const out: OpsUsageAggregate = {
      totals: { ...zero, lastMinuteRequests: 0, lastMinuteTokens: 0 },
      buckets: new Map(),
      accounts: new Map(),
      models: new Map(),
      statusCodes: new Map(),
      recentErrors: errors.map((e) => ({
        id: e.id,
        createdAtIso: iso(e.created_at),
        requestId: e.request_id,
        userId: e.user_id,
        userEmail: e.user_email,
        model: e.public_model,
        accountId: e.account_id,
        groupId: e.group_id,
        groupName: e.group_name,
        statusCode: e.status_code,
        durationMs: Number(e.duration_ms),
      })),
    };
    for (const r of groups) {
      // GROUPING bits (b, account, model, status): 15 = total, 7 = bucket, 11 = account, 13 = model, 14 = status.
      if (r.g === 15) out.totals = { ...sums(r), lastMinuteRequests: r.recent_requests, lastMinuteTokens: Number(r.recent_tokens) };
      else if (r.g === 7 && r.b !== null && r.b >= 0 && r.b < q.bucketCount) out.buckets.set(r.b, sums(r));
      else if (r.g === 11 && r.account_id !== null) out.accounts.set(r.account_id, sums(r));
      else if (r.g === 13 && r.public_model !== null) out.models.set(r.public_model, sums(r));
      else if (r.g === 14 && r.status_code !== null && r.status_code >= 400) out.statusCodes.set(r.status_code, r.requests);
    }
    return out;
  }

  /* ---------------- API key lookups ---------------- */

  async findApiKeyByHash(keyHash: Uint8Array): Promise<ApiKeyLookupRecord | null> {
    const rows = await this.sql<
      { id: string; user_id: string; name: string; key_prefix: string; enabled: boolean; expires_at: Date | null; group_id: string; group_name: string; billing: string }[]
    >`
      SELECT k.id, k.user_id, k.name, k.key_prefix, k.enabled, k.expires_at, k.group_id,
             COALESCE(g.name, '') AS group_name, COALESCE(g.subscription_type, 'balance') AS billing
        FROM core.api_keys k
        LEFT JOIN core.groups g ON g.id = k.group_id
       WHERE k.key_hash_blake3 = ${Buffer.from(keyHash)}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      keyPrefix: r.key_prefix,
      enabled: r.enabled,
      expiresAtIso: isoOrNull(r.expires_at),
      groupId: r.group_id,
      groupName: r.group_name,
      billing: r.billing === "subscription" ? "subscription" : "balance",
    };
  }

  async listApiKeyLabels(userId: string): Promise<ApiKeyLabel[]> {
    return this.sql<ApiKeyLabel[]>`
      SELECT id, name, enabled FROM core.api_keys WHERE user_id = ${userId} ORDER BY created_at DESC
    `.then((rows) => rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })));
  }
}

interface SumsRow {
  requests: number;
  errors: number;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cost: string;
  duration_sum: string;
  duration_count: number;
  ttft_sum: string;
  ttft_count: number;
}

/** An int[] column (NULL when its aggregate saw no rows), parsed or as `{1,2}` text. */
function intArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x) => Number(x ?? 0));
  if (typeof v === "string" && v.startsWith("{")) {
    return v.slice(1, -1).split(",").filter((x) => x !== "").map((x) => (x === "NULL" ? 0 : Number(x)));
  }
  return [];
}

function sumsOf(r: SumsRow): UsageSums {
  return {
    requests: r.requests,
    errors: r.errors,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    costNano: nanoFromText(r.cost),
    durationSum: Number(r.duration_sum),
    durationCount: r.duration_count,
    ttftSum: Number(r.ttft_sum),
    ttftCount: r.ttft_count,
  };
}
