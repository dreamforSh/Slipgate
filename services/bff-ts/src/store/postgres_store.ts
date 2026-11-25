import postgres from "postgres";
import {
  AccountAuthKindSchema,
  AccountPrivacyModeSchema,
  effectiveAccountStatus,
  formatNanoUsd,
  parseUsdToNano,
  isSubscriptionTierAllowedForProvider,
  SubscriptionTierSchema,
  TempUnschedRulesSchema,
  effectiveSubscriptionTier,
  subscriptionTierMultiplier,
  type AccountPrivacyMode,
  type AccountTestResult,
  type AccountUsageSummaryItem,
  type ApiKeyItem,
  type CreateAccountRequest,
  type CreateApiKeyRequest,
  type CreateCompositeRouteRequest,
  type CreateGroupRequest,
  type DataPlaneSyncSnapshot,
  type GroupItem,
  ModelPricingRuleSchema,
  type ModelPricingRule,
  type RecordRiskBanInput,
  type RiskBanEvent,
  type SetupInitializeRequest,
  type SetupStatus,
  type StoredCompositeRoute,
  type TurnSettlementEvent,
  type UpdateAccountRequest,
  type UpdateApiKeyRequest,
  type UpdateGroupRequest,
  type TempUnschedRule,
  type UpstreamAccount,
  type UsageLogItem,
  type UserProfile,
  type WalletSummary,
} from "@slipgate/contracts";
import { normalizeIso, resolveCooldownChange } from "./account_patch.ts";
import {
  PG_AUTH_GUARDS_SCHEMA_SQL,
  pgRegistrationConflict,
  RegistrationGuardError,
  type RegistrationConflict,
  type RegistrationGuard,
} from "./auth_guards_store.ts";
import type { OpsStore } from "./ops_types.ts";
import {
  ensureUsageIndexesInBackground,
  PG_OAUTH_EXTRAS_SCHEMA_SQL,
  PG_OPS_SCHEMA_SQL,
  PG_SESSION_SCHEMA_SQL,
  PostgresOpsStore,
} from "./postgres_ops.ts";
import { PG_ANNOUNCEMENT_TARGETING_SCHEMA_SQL } from "./postgres_announcements.ts";
import { PG_PAYMENTS_SCHEMA_SQL, pendingAuditSecretScrub, PostgresPaymentsStore } from "./postgres_payments.ts";
import { PG_PAYMENT_PROVIDERS_SCHEMA_SQL } from "./postgres_payment_providers.ts";
import { PG_SYSTEM_LOGS_SCHEMA_SQL, PostgresSystemLogStore } from "./postgres_system_logs.ts";
import { PG_DB_BACKUPS_SCHEMA_SQL, PostgresDbBackupStore } from "./db_backups_postgres.ts";
import { PG_USER_LIMITS_SCHEMA_SQL, PostgresUserLimitsStore } from "./postgres_user_limits.ts";
import { PG_REQUEST_ERRORS_SCHEMA_SQL, PostgresRequestErrorStore } from "./postgres_request_errors.ts";
import { PG_ALERTS_SCHEMA_SQL, PostgresAlertStore } from "./postgres_alerts.ts";
import { PG_CHANNEL_MONITORS_SCHEMA_SQL, PostgresChannelMonitorStore } from "./postgres_channel_monitors.ts";
import { PG_PLATFORM_QUOTAS_SCHEMA_SQL, PostgresPlatformQuotasStore } from "./postgres_platform_quotas.ts";
import { PG_USAGE_ROLLUPS_SCHEMA_SQL, PostgresUsageRollupsStore } from "./postgres_usage_rollups.ts";
import { PG_MODERATION_SCHEMA_SQL, PostgresModerationStore } from "./postgres_moderation.ts";
import { PG_PASSKEYS_SCHEMA_SQL, PostgresPasskeyStore } from "./postgres_passkeys.ts";
import { PG_SITE_PAGES_SCHEMA_SQL, PostgresSitePagesStore } from "./postgres_site_pages.ts";
import { PG_USER_ATTRIBUTES_SCHEMA_SQL, PostgresUserAttributesStore } from "./postgres_user_attributes.ts";
import {
  PG_SETTLEMENT_SCHEMA_SQL,
  pruneSettlementIds,
  SETTLEMENT_PRUNE_BACKLOG_RETRY_MS,
  SETTLEMENT_PRUNE_INTERVAL_MS,
} from "./postgres_settlement.ts";
import type { PaymentsStore } from "./payments_types.ts";
import {
  settlementIdOf,
  StoreError,
  type AccountSecretRecord,
  type ApiKeyBulkResult,
  type ControlStore,
  type PersistedMediaTaskRecord,
  type StoredCredential,
  type TurnSettlementResult,
  type UserCredentialRecord,
  type UsageLogFilter,
} from "./types.ts";

type SqlExecutor = ReturnType<typeof postgres>;

function toDateOrNull(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null;
}

type SetupSettingsValue = {
  initialized: boolean;
  siteName: string;
  allowRegistration: boolean;
};

/**
 * Older builds bound `JSON.stringify(x)` to jsonb parameters, which postgres.js encoded a second
 * time, storing a JSON *string*. Decode such values so existing rows keep working.
 */
function jsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Stored rules are re-validated on read; a malformed column reads as "no rules". */
function parseTempUnschedRules(value: unknown): TempUnschedRule[] {
  const parsed = TempUnschedRulesSchema.safeParse(jsonColumn<unknown>(value) ?? []);
  return parsed.success ? parsed.data : [];
}

function jsonArray(value: unknown): string[] {
  const decoded = jsonColumn<unknown>(value);
  return Array.isArray(decoded) ? (decoded as string[]) : [];
}

function mapPgError(err: unknown): never {
  const pgCode = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : "Database error";
  if (pgCode === "23505" || pgCode === "23503") {
    throw new StoreError("conflict", message);
  }
  throw err;
}

/** USD cap typed by an admin ("0" = unlimited) → nano-USD digits. */
function limitNano(usd: string): string {
  const nano = parseUsdToNano(usd);
  return (nano > 0n ? nano : 0n).toString();
}

function optionalLimitNano(usd: string | undefined): string | null {
  return usd === undefined ? null : limitNano(usd);
}

function toIso(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

export class PostgresControlStore implements ControlStore {
  private readonly sql: SqlExecutor;
  readonly ops: OpsStore;
  readonly payments: PaymentsStore;
  readonly systemLogs: PostgresSystemLogStore;
  readonly dbBackups: PostgresDbBackupStore;
  readonly userLimits: PostgresUserLimitsStore;
  readonly requestErrors: PostgresRequestErrorStore;
  readonly alerts: PostgresAlertStore;
  readonly channelMonitors: PostgresChannelMonitorStore;
  readonly platformQuotas: PostgresPlatformQuotasStore;
  readonly usageRollups: PostgresUsageRollupsStore;
  readonly moderation: PostgresModerationStore;
  readonly passkeys: PostgresPasskeyStore;
  readonly userAttributes: PostgresUserAttributesStore;
  readonly sitePages: PostgresSitePagesStore;
  private backgroundMaintenance: Promise<void> = Promise.resolve();
  /** Earliest time of the next opportunistic core.settlement_ids prune (off the settlement tx). */
  private settlementPruneAt = 0;
  private settlementPruneRunning = false;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
    });
    this.ops = new PostgresOpsStore(this.sql);
    this.payments = new PostgresPaymentsStore(this.sql);
    this.systemLogs = new PostgresSystemLogStore(this.sql);
    this.dbBackups = new PostgresDbBackupStore(this.sql, databaseUrl);
    this.userLimits = new PostgresUserLimitsStore(this.sql);
    this.requestErrors = new PostgresRequestErrorStore(this.sql);
    this.alerts = new PostgresAlertStore(this.sql);
    this.channelMonitors = new PostgresChannelMonitorStore(this.sql);
    this.platformQuotas = new PostgresPlatformQuotasStore(this.sql);
    this.usageRollups = new PostgresUsageRollupsStore(this.sql);
    this.moderation = new PostgresModerationStore(this.sql);
    this.passkeys = new PostgresPasskeyStore(this.sql);
    this.userAttributes = new PostgresUserAttributesStore(this.sql);
    this.sitePages = new PostgresSitePagesStore(this.sql);
  }

  async init(): Promise<void> {
    // Self-heal all base core.* and commerce.* tables first so standalone deployments, external RDS
    // instances, and fresh databases without /docker-entrypoint-initdb.d mounts boot cleanly.
    await this.sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS commerce;
      CREATE SCHEMA IF NOT EXISTS core;

      CREATE TABLE IF NOT EXISTS core.groups (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL UNIQUE,
          platform          TEXT NOT NULL,
          subscription_type TEXT NOT NULL DEFAULT 'balance',
          rate_multiplier   NUMERIC(12, 6) NOT NULL DEFAULT 1.000000,
          model_allowlist   JSONB NOT NULL DEFAULT '[]'::jsonb,
          enabled           BOOLEAN NOT NULL DEFAULT TRUE,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS core.accounts (
          id                  TEXT PRIMARY KEY,
          group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
          platform            TEXT NOT NULL,
          auth_kind           TEXT NOT NULL,
          credentials_enc     BYTEA NOT NULL,
          max_concurrency     INTEGER NOT NULL DEFAULT 5,
          priority            INTEGER NOT NULL DEFAULT 100,
          is_shadow_follower  BOOLEAN NOT NULL DEFAULT FALSE,
          parent_account_id   TEXT REFERENCES core.accounts(id) ON DELETE SET NULL,
          status              TEXT NOT NULL DEFAULT 'active',
          temp_unsched_until  TIMESTAMPTZ,
          temp_unsched_reason TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_accounts_group_status
          ON core.accounts (group_id, status, priority);

      CREATE TABLE IF NOT EXISTS core.composite_routes (
          id              TEXT PRIMARY KEY,
          group_id        TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
          public_model    TEXT NOT NULL,
          match_type      TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix')),
          target_platform TEXT NOT NULL,
          upstream_model  TEXT NOT NULL,
          endpoint        TEXT NOT NULL DEFAULT 'any',
          priority        INTEGER NOT NULL DEFAULT 100,
          enabled         BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_composite_routes_lookup
          ON core.composite_routes (group_id, enabled, priority, id);

      CREATE TABLE IF NOT EXISTS core.api_keys (
          id                  TEXT PRIMARY KEY,
          user_id             TEXT NOT NULL,
          group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE RESTRICT,
          key_prefix          TEXT NOT NULL,
          key_hash_blake3     BYTEA NOT NULL UNIQUE,
          rpm_limit           INTEGER NOT NULL DEFAULT 60,
          concurrency_limit   INTEGER NOT NULL DEFAULT 5,
          ip_allowlist        JSONB NOT NULL DEFAULT '[]'::jsonb,
          enabled             BOOLEAN NOT NULL DEFAULT TRUE,
          expires_at          TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_api_keys_user
          ON core.api_keys (user_id, enabled);

      CREATE TABLE IF NOT EXISTS core.quota_wallets (
          user_id             TEXT PRIMARY KEY,
          balance_nano_usd    NUMERIC(39, 0) NOT NULL DEFAULT 0,
          held_nano_usd       NUMERIC(39, 0) NOT NULL DEFAULT 0,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_core_wallet_non_negative_held CHECK (held_nano_usd >= 0)
      );

      CREATE TABLE IF NOT EXISTS core.ledger_entries (
          id                  TEXT PRIMARY KEY,
          idempotency_key     TEXT NOT NULL UNIQUE,
          user_id             TEXT NOT NULL REFERENCES core.quota_wallets(user_id) ON DELETE RESTRICT,
          entry_kind          TEXT NOT NULL CHECK (entry_kind IN ('credit', 'hold', 'settle', 'release', 'adjust')),
          delta_nano_usd      NUMERIC(39, 0) NOT NULL,
          balance_after_nano  NUMERIC(39, 0) NOT NULL,
          reference_id        TEXT,
          metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_ledger_user_created
          ON core.ledger_entries (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS core.usage_logs (
          id                  TEXT NOT NULL,
          request_id          TEXT NOT NULL,
          user_id             TEXT NOT NULL,
          api_key_id          TEXT NOT NULL,
          account_id          TEXT NOT NULL,
          group_id            TEXT NOT NULL,
          platform            TEXT NOT NULL,
          public_model        TEXT NOT NULL,
          upstream_model      TEXT NOT NULL,
          ingress_codec       TEXT NOT NULL,
          egress_codec        TEXT NOT NULL,
          input_tokens        BIGINT NOT NULL DEFAULT 0,
          output_tokens       BIGINT NOT NULL DEFAULT 0,
          cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
          cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
          cost_nano_usd       NUMERIC(39, 0) NOT NULL DEFAULT 0,
          ttft_ms             INTEGER,
          duration_ms         INTEGER,
          status_code         INTEGER NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at);

      CREATE TABLE IF NOT EXISTS core.usage_logs_default
          PARTITION OF core.usage_logs DEFAULT;

      CREATE TABLE IF NOT EXISTS core.account_window_quotas (
          account_id              TEXT PRIMARY KEY REFERENCES core.accounts(id) ON DELETE CASCADE,
          window_5h_used_bps      INTEGER NOT NULL DEFAULT 0 CHECK (window_5h_used_bps >= 0 AND window_5h_used_bps <= 10000),
          window_5h_reset_at      TIMESTAMPTZ,
          window_7d_used_bps      INTEGER NOT NULL DEFAULT 0 CHECK (window_7d_used_bps >= 0 AND window_7d_used_bps <= 10000),
          window_7d_reset_at      TIMESTAMPTZ,
          lifetime_tokens         BIGINT NOT NULL DEFAULT 0,
          lifetime_cost_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0,
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS core.risk_ban_records (
          id                  TEXT PRIMARY KEY,
          subject_kind        TEXT NOT NULL CHECK (subject_kind IN ('device', 'session', 'api_key', 'ip')),
          subject_hash        TEXT NOT NULL,
          strike_level        SMALLINT NOT NULL CHECK (strike_level BETWEEN 1 AND 3),
          ban_reason          TEXT NOT NULL,
          source_request_id   TEXT,
          expires_at          TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_risk_ban_lookup
          ON core.risk_ban_records (subject_kind, subject_hash, expires_at DESC);

      CREATE TABLE IF NOT EXISTS core.refusal_cache (
          request_fingerprint TEXT PRIMARY KEY,
          reason              TEXT NOT NULL,
          http_status         INTEGER NOT NULL DEFAULT 400,
          response_payload    JSONB NOT NULL,
          expires_at          TIMESTAMPTZ NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_core_refusal_cache_expiry
          ON core.refusal_cache (expires_at);

      CREATE TABLE IF NOT EXISTS commerce.users (
          id              TEXT PRIMARY KEY,
          email           TEXT NOT NULL UNIQUE,
          password_hash   TEXT,
          role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
          status          TEXT NOT NULL DEFAULT 'active',
          totp_secret_enc BYTEA,
          totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
          referrer_id     TEXT REFERENCES commerce.users(id) ON DELETE SET NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.auth_identities (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
          provider        TEXT NOT NULL,
          subject         TEXT NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (provider, subject)
      );

      CREATE TABLE IF NOT EXISTS commerce.passkeys (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
          credential_id   BYTEA NOT NULL UNIQUE,
          public_key      BYTEA NOT NULL,
          sign_count      BIGINT NOT NULL DEFAULT 0,
          transports      JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.payment_orders (
          id                  TEXT PRIMARY KEY,
          user_id             TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE RESTRICT,
          provider            TEXT NOT NULL,
          provider_trade_no   TEXT,
          amount_nano_usd     NUMERIC(39, 0) NOT NULL,
          currency            TEXT NOT NULL DEFAULT 'USD',
          status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
          idempotency_key     TEXT NOT NULL UNIQUE,
          paid_at             TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.outbox_events (
          id              TEXT PRIMARY KEY,
          event_type      TEXT NOT NULL,
          aggregate_id    TEXT NOT NULL,
          payload         JSONB NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'dead_letter')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          dispatched_at   TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_commerce_outbox_pending
          ON commerce.outbox_events (status, next_retry_at);

      CREATE TABLE IF NOT EXISTS commerce.subscriptions (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
          group_id        TEXT NOT NULL,
          plan_code       TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'active',
          starts_at       TIMESTAMPTZ NOT NULL,
          expires_at      TIMESTAMPTZ NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.redeem_codes (
          code            TEXT PRIMARY KEY,
          amount_nano_usd NUMERIC(39, 0) NOT NULL,
          redeemed_by     TEXT REFERENCES commerce.users(id) ON DELETE SET NULL,
          redeemed_at     TIMESTAMPTZ,
          expires_at      TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.affiliate_commissions (
          id              TEXT PRIMARY KEY,
          beneficiary_id  TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE RESTRICT,
          source_order_id TEXT NOT NULL REFERENCES commerce.payment_orders(id) ON DELETE RESTRICT,
          amount_nano_usd NUMERIC(39, 0) NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commerce.portal_settings (
          key         TEXT PRIMARY KEY,
          value_json  JSONB NOT NULL,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE core.accounts
          ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'stealth_http',
          ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'standard',
          ADD COLUMN IF NOT EXISTS credential_preview TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN,
          ADD COLUMN IF NOT EXISTS last_test_model TEXT,
          ADD COLUMN IF NOT EXISTS last_test_duration_ms INTEGER,
          ADD COLUMN IF NOT EXISTS last_test_message TEXT,
          ADD COLUMN IF NOT EXISTS temp_unsched_until TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS temp_unsched_reason TEXT,
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS auto_pause_on_expired BOOLEAN NOT NULL DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT,
          ADD COLUMN IF NOT EXISTS temp_unsched_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS privacy_mode TEXT,
          ADD COLUMN IF NOT EXISTS privacy_checked_at TIMESTAMPTZ;

      -- The group is optional: NULL = ungrouped (the FK still guards non-null ids).
      ALTER TABLE core.accounts ALTER COLUMN group_id DROP NOT NULL;

      -- Deleting a group ungroups its accounts instead of cascading (older schemas: ON DELETE CASCADE).
      DO $$
      DECLARE
          fk record;
      BEGIN
          FOR fk IN
              SELECT c.conname
              FROM pg_constraint c
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              WHERE c.conrelid = 'core.accounts'::regclass
                AND c.contype = 'f'
                AND c.confrelid = 'core.groups'::regclass
                AND a.attname = 'group_id'
                AND c.confdeltype <> 'n'
          LOOP
              EXECUTE format('ALTER TABLE core.accounts DROP CONSTRAINT %I', fk.conname);
              EXECUTE format(
                  'ALTER TABLE core.accounts ADD CONSTRAINT %I FOREIGN KEY (group_id) REFERENCES core.groups(id) ON DELETE SET NULL',
                  fk.conname
              );
          END LOOP;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_core_accounts_credential_fingerprint
          ON core.accounts (credential_fingerprint);

      -- API keys carry no plan. Rows written before that rule (or switched to api_key without
      -- a tier change) drop back to standard so the scheduler weighs them 1x.
      UPDATE core.accounts
          SET subscription_tier = 'standard', updated_at = NOW()
          WHERE auth_kind = 'api_key' AND subscription_tier <> 'standard';

      ALTER TABLE IF EXISTS core.account_window_quotas
          ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

      -- No index builds on core.usage_logs here: this batch runs in one implicit transaction
      -- before the BFF listens, so scanning a large partition would block settlements.
      -- Fresh databases get idx_core_usage_logs_account_time from migration 0006.

      -- Self-heal jsonb values that older builds double-encoded as JSON strings.
      UPDATE commerce.portal_settings SET value_json = (value_json #>> '{}')::jsonb
       WHERE jsonb_typeof(value_json) = 'string' AND left(btrim(value_json #>> '{}'), 1) IN ('{', '[');
      UPDATE core.groups SET model_allowlist = (model_allowlist #>> '{}')::jsonb
       WHERE jsonb_typeof(model_allowlist) = 'string' AND left(btrim(model_allowlist #>> '{}'), 1) = '[';
      UPDATE core.api_keys SET ip_allowlist = (ip_allowlist #>> '{}')::jsonb
       WHERE jsonb_typeof(ip_allowlist) = 'string' AND left(btrim(ip_allowlist #>> '{}'), 1) = '[';

      ALTER TABLE core.groups
          ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS is_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE core.api_keys
          ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'default';

      ALTER TABLE core.usage_logs
          ADD COLUMN IF NOT EXISTS service_tier TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS video_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS core.model_pricing_rules (
          id                                  TEXT PRIMARY KEY,
          pattern                             TEXT NOT NULL UNIQUE,
          input_nano_per_mtok                 NUMERIC(39, 0) NOT NULL DEFAULT 0,
          output_nano_per_mtok                NUMERIC(39, 0) NOT NULL DEFAULT 0,
          cache_read_nano_per_mtok            NUMERIC(39, 0) NOT NULL DEFAULT 0,
          cache_write_nano_per_mtok           NUMERIC(39, 0) NOT NULL DEFAULT 0,
          per_request_nano_usd                NUMERIC(39, 0) NOT NULL DEFAULT 0,
          per_image_nano_usd                  NUMERIC(39, 0) NOT NULL DEFAULT 0,
          per_video_second_nano_usd           NUMERIC(39, 0) NOT NULL DEFAULT 0,
          long_context_threshold_tokens       INTEGER NOT NULL DEFAULT 0,
          long_context_input_multiplier       NUMERIC(12, 6),
          long_context_output_multiplier      NUMERIC(12, 6),
          service_tier_fast_multiplier        NUMERIC(12, 6),
          service_tier_flex_multiplier        NUMERIC(12, 6),
          reasoning_effort_multipliers        JSONB NOT NULL DEFAULT '{}'::jsonb,
          enabled                             BOOLEAN NOT NULL DEFAULT TRUE,
          notes                               TEXT NOT NULL DEFAULT '',
          updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE core.model_pricing_rules
          ALTER COLUMN long_context_input_multiplier DROP NOT NULL,
          ALTER COLUMN long_context_output_multiplier DROP NOT NULL,
          ALTER COLUMN service_tier_fast_multiplier DROP NOT NULL,
          ALTER COLUMN service_tier_flex_multiplier DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS core.media_tasks (
          id                  TEXT PRIMARY KEY,
          upstream_task_id    TEXT NOT NULL DEFAULT '',
          user_id             TEXT NOT NULL DEFAULT '',
          api_key_id          TEXT NOT NULL,
          account_id          TEXT NOT NULL DEFAULT '',
          group_id            TEXT NOT NULL DEFAULT '',
          platform            TEXT NOT NULL DEFAULT '',
          kind                TEXT NOT NULL DEFAULT 'video',
          public_model        TEXT NOT NULL DEFAULT '',
          upstream_model      TEXT NOT NULL DEFAULT '',
          status              TEXT NOT NULL DEFAULT 'pending',
          video_seconds       NUMERIC(12, 3) NOT NULL DEFAULT 0,
          image_count         INTEGER NOT NULL DEFAULT 0,
          cost_nano_usd       NUMERIC(39, 0) NOT NULL DEFAULT 0,
          result_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
      );
      ALTER TABLE core.media_tasks
          ADD COLUMN IF NOT EXISTS group_id TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS video_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cost_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');
      ALTER TABLE core.media_tasks DROP CONSTRAINT IF EXISTS media_tasks_kind_check;
      CREATE INDEX IF NOT EXISTS idx_core_media_tasks_key_created
          ON core.media_tasks (api_key_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_media_tasks_key_expires
          ON core.media_tasks (api_key_id, kind, expires_at DESC);
    `);
    // Before PG_OPS_SCHEMA_SQL: its spent_nano_usd guard must see whether this start adds the column.
    await this.sql.unsafe(PG_SETTLEMENT_SCHEMA_SQL);
    await this.sql.unsafe(PG_OPS_SCHEMA_SQL);
    await this.sql.unsafe(PG_ANNOUNCEMENT_TARGETING_SCHEMA_SQL);
    await this.sql.unsafe(PG_SESSION_SCHEMA_SQL);
    await this.sql.unsafe(PG_PAYMENTS_SCHEMA_SQL);
    await this.sql.unsafe(PG_PAYMENT_PROVIDERS_SCHEMA_SQL);
    await this.sql.unsafe(PG_SYSTEM_LOGS_SCHEMA_SQL);
    await this.sql.unsafe(PG_AUTH_GUARDS_SCHEMA_SQL);
    await this.sql.unsafe(PG_DB_BACKUPS_SCHEMA_SQL);
    await this.sql.unsafe(PG_USER_LIMITS_SCHEMA_SQL);
    await this.sql.unsafe(PG_REQUEST_ERRORS_SCHEMA_SQL);
    await this.sql.unsafe(PG_ALERTS_SCHEMA_SQL);
    await this.sql.unsafe(PG_CHANNEL_MONITORS_SCHEMA_SQL);
    await this.sql.unsafe(PG_PLATFORM_QUOTAS_SCHEMA_SQL);
    await this.sql.unsafe(PG_USAGE_ROLLUPS_SCHEMA_SQL);
    await this.sql.unsafe(PG_MODERATION_SCHEMA_SQL);
    await this.sql.unsafe(PG_PASSKEYS_SCHEMA_SQL);
    await this.sql.unsafe(PG_OAUTH_EXTRAS_SCHEMA_SQL);
    await this.sql.unsafe(PG_USER_ATTRIBUTES_SCHEMA_SQL);
    await this.sql.unsafe(PG_SITE_PAGES_SCHEMA_SQL);
    // Index builds and the one-time spend backfill must not delay startup or block settlements.
    // So is the one-off pass of the current audit-log redaction over rows older builds stored.
    const auditScrub = await pendingAuditSecretScrub(this.sql);
    this.backgroundMaintenance = ensureUsageIndexesInBackground(this.sql).finally(() => auditScrub?.());
  }

  /** Resolves once the startup index maintenance and spend backfill have finished (tests, tooling). */
  whenMaintenanceIdle(): Promise<void> {
    return this.backgroundMaintenance;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async getSetupStatus(): Promise<SetupStatus> {
    const rows = await this.sql<{ value_json: unknown }[]>`
      SELECT value_json FROM commerce.portal_settings WHERE key = 'setup_state'
    `;
    const state = jsonColumn<SetupSettingsValue>(rows[0]?.value_json);
    if (state && typeof state === "object") {
      return {
        initialized: Boolean(state.initialized),
        siteName: state.siteName || "Slipgate Gateway",
        allowRegistration: Boolean(state.allowRegistration),
      };
    }

    const adminRows = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM commerce.users WHERE role = 'admin'
    `;
    const hasAdmin = Number.parseInt(adminRows[0]?.count ?? "0", 10) > 0;
    return {
      initialized: hasAdmin,
      siteName: "Slipgate Gateway",
      allowRegistration: true,
    };
  }

  async initializeSetup(
    req: SetupInitializeRequest,
    adminPasswordHash: string,
  ): Promise<UserProfile> {
    try {
      return await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        const existingAdmins = await tx<{ id: string }[]>`
          SELECT id FROM commerce.users WHERE role = 'admin' LIMIT 1
        `;
        if (existingAdmins.length > 0) {
          throw new StoreError("conflict", "Slipgate is already initialized");
        }

        const adminId = `usr_${crypto.randomUUID()}`;
        const email = req.adminEmail.toLowerCase();
        const userRows = await tx<
          {
            id: string;
            email: string;
            username: string;
            role: "admin" | "user";
            status: "active" | "suspended";
            totp_enabled: boolean;
            avatar_url: string;
            email_verified: boolean;
            created_at: Date;
          }[]
        >`
          INSERT INTO commerce.users (id, email, password_hash, role, status)
          VALUES (${adminId}, ${email}, ${adminPasswordHash}, 'admin', 'active')
          RETURNING id, email, username, role, status, totp_enabled, avatar_url, email_verified, created_at
        `;

        await tx`
          INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
          VALUES (${adminId}, 0, 0)
          ON CONFLICT (user_id) DO NOTHING
        `;

        await tx`
          INSERT INTO core.groups (id, name, platform, subscription_type, rate_multiplier, model_allowlist, enabled)
          VALUES ('grp_default', 'default-composite', 'composite', 'balance', 1.0, '[]'::jsonb, TRUE)
          ON CONFLICT (name) DO NOTHING
        `;

        const setupState: SetupSettingsValue = {
          initialized: true,
          siteName: req.siteName,
          allowRegistration: req.allowRegistration,
        };
        await tx`
          INSERT INTO commerce.portal_settings (key, value_json, updated_at)
          VALUES ('setup_state', ${this.sql.json(setupState)}, NOW())
          ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
        `;

        const row = userRows[0]!;
        return {
          id: row.id,
          email: row.email,
          username: row.username ?? "",
          avatarUrl: row.avatar_url ?? "",
          emailVerified: Boolean(row.email_verified),
          role: row.role,
          status: row.status,
          totpEnabled: row.totp_enabled,
          createdAtIso: toIso(row.created_at),
        };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async registerUser(email: string, passwordHash: string, guard?: RegistrationGuard): Promise<UserProfile> {
    const status = await this.getSetupStatus();
    if (!status.initialized) {
      throw new StoreError("conflict", "System setup has not completed yet");
    }
    if (!status.allowRegistration) {
      throw new StoreError("forbidden", "Public user registration is disabled");
    }

    try {
      return await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        if (guard) {
          // Under the inbox (and domain) advisory locks until commit: see auth_guards_store.ts.
          const conflict = await pgRegistrationConflict(tx, email, guard, true);
          if (conflict) throw new RegistrationGuardError(conflict);
        }
        const userId = `usr_${crypto.randomUUID()}`;
        const rows = await tx<
          {
            id: string;
            email: string;
            username: string;
            role: "admin" | "user";
            status: "active" | "suspended";
            totp_enabled: boolean;
            avatar_url: string;
            email_verified: boolean;
            created_at: Date;
          }[]
        >`
          INSERT INTO commerce.users (id, email, password_hash, role, status)
          VALUES (${userId}, ${email.toLowerCase()}, ${passwordHash}, 'user', 'active')
          RETURNING id, email, username, role, status, totp_enabled, avatar_url, email_verified, created_at
        `;
        await tx`
          INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
          VALUES (${userId}, 0, 0)
          ON CONFLICT (user_id) DO NOTHING
        `;
        const row = rows[0]!;
        return {
          id: row.id,
          email: row.email,
          username: row.username ?? "",
          avatarUrl: row.avatar_url ?? "",
          emailVerified: Boolean(row.email_verified),
          role: row.role,
          status: row.status,
          totpEnabled: row.totp_enabled,
          createdAtIso: toIso(row.created_at),
        };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async registrationEmailConflict(email: string, guard: RegistrationGuard): Promise<RegistrationConflict | null> {
    return pgRegistrationConflict(this.sql, email, guard, false);
  }

  async findUserByEmail(email: string): Promise<UserCredentialRecord | null> {
    // password_hash and token_version come from one row read (one snapshot): see UserCredentialRecord.
    const rows = await this.sql<
      {
        id: string;
        email: string;
        username: string;
        password_hash: string | null;
        role: UserProfile["role"];
        managed_group_ids: string[] | null;
        status: "active" | "suspended";
        totp_enabled: boolean;
        avatar_url: string;
        email_verified: boolean;
        created_at: Date;
        token_version: number;
      }[]
    >`
      SELECT id, email, username, password_hash, role, managed_group_ids, status, totp_enabled, avatar_url, email_verified, created_at, token_version
      FROM commerce.users
      WHERE LOWER(email) = LOWER(${email})
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      username: row.username ?? "",
      avatarUrl: row.avatar_url ?? "",
      emailVerified: Boolean(row.email_verified),
      passwordHash: row.password_hash,
      role: row.role,
      managedGroupIds: Array.isArray(row.managed_group_ids) ? row.managed_group_ids : [],
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
      tokenVersion: Number(row.token_version),
    };
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        username: string;
        role: UserProfile["role"];
        managed_group_ids: string[] | null;
        status: "active" | "suspended";
        totp_enabled: boolean;
        avatar_url: string;
        email_verified: boolean;
        created_at: Date;
      }[]
    >`
      SELECT id, email, username, role, managed_group_ids, status, totp_enabled, avatar_url, email_verified, created_at
      FROM commerce.users
      WHERE id = ${userId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      username: row.username ?? "",
      avatarUrl: row.avatar_url ?? "",
      emailVerified: Boolean(row.email_verified),
      role: row.role,
      managedGroupIds: Array.isArray(row.managed_group_ids) ? row.managed_group_ids : [],
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
    };
  }

  async listUsers(): Promise<UserProfile[]> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        username: string;
        role: UserProfile["role"];
        managed_group_ids: string[] | null;
        status: "active" | "suspended";
        totp_enabled: boolean;
        avatar_url: string;
        email_verified: boolean;
        created_at: Date;
      }[]
    >`
      SELECT id, email, username, role, managed_group_ids, status, totp_enabled, avatar_url, email_verified, created_at
      FROM commerce.users
      ORDER BY created_at DESC
    `;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username ?? "",
      avatarUrl: row.avatar_url ?? "",
      emailVerified: Boolean(row.email_verified),
      role: row.role,
      managedGroupIds: Array.isArray(row.managed_group_ids) ? row.managed_group_ids : [],
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
    }));
  }

  async getWallet(userId: string): Promise<WalletSummary> {
    const rows = await this.sql<{ balance_nano_usd: string; held_nano_usd: string }[]>`
      SELECT balance_nano_usd::text, held_nano_usd::text
      FROM core.quota_wallets
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      const user = await this.getUserById(userId);
      if (!user) {
        throw new StoreError("not_found", `User ${userId} not found`);
      }
      return {
        userId,
        balanceNanoUsd: "0",
        heldNanoUsd: "0",
        availableNanoUsd: "0",
        formattedAvailableUsd: "$0.00",
      };
    }
    const balance = BigInt(rows[0]!.balance_nano_usd);
    const held = BigInt(rows[0]!.held_nano_usd);
    const available = balance - held;
    return {
      userId,
      balanceNanoUsd: balance.toString(),
      heldNanoUsd: held.toString(),
      availableNanoUsd: available.toString(),
      formattedAvailableUsd: formatNanoUsd(available),
    };
  }

  async creditWallet(
    userId: string,
    amountNanoUsd: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<WalletSummary> {
    if (amountNanoUsd <= 0n) {
      throw new StoreError("bad_request", "Credit amount must be positive");
    }
    const user = await this.getUserById(userId);
    if (!user) {
      throw new StoreError("not_found", `User ${userId} not found`);
    }

    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlExecutor;
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM core.ledger_entries WHERE idempotency_key = ${idempotencyKey} LIMIT 1
      `;
      if (existing.length > 0) return;

      await tx`
        INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
        VALUES (${userId}, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `;

      const updated = await tx<{ balance_nano_usd: string }[]>`
        UPDATE core.quota_wallets
        SET balance_nano_usd = balance_nano_usd + ${amountNanoUsd.toString()}::numeric,
            updated_at = NOW()
        WHERE user_id = ${userId}
        RETURNING balance_nano_usd::text
      `;

      const entryId = `ldg_${crypto.randomUUID()}`;
      await tx`
        INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, metadata)
        VALUES (
          ${entryId},
          ${idempotencyKey},
          ${userId},
          'credit',
          ${amountNanoUsd.toString()}::numeric,
          ${updated[0]!.balance_nano_usd}::numeric,
          ${this.sql.json({ reason })}
        )
      `;

      await tx`
        INSERT INTO commerce.outbox_events (id, event_type, aggregate_id, payload, status, dispatched_at)
        VALUES (
          ${`obx_${crypto.randomUUID()}`},
          'core.v1.CreditWallet',
          ${userId},
          ${this.sql.json({ idempotencyKey, amountNanoUsd: amountNanoUsd.toString(), reason })},
          'dispatched',
          NOW()
        )
      `;
    });

    return this.getWallet(userId);
  }

  async listGroups(enabledOnly = false): Promise<GroupItem[]> {
    return this.queryGroups({ enabledOnly });
  }

  private async queryGroups(filter: { enabledOnly?: boolean; groupId?: string }): Promise<GroupItem[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        description: string;
        platform: GroupItem["platform"];
        subscription_type: GroupItem["subscriptionType"];
        rate_multiplier: string;
        model_allowlist: string[];
        is_exclusive: boolean;
        sort_order: number;
        enabled: boolean;
        account_count: string;
        active_account_count: string;
        api_key_count: string;
        daily_limit_nano_usd: string;
        weekly_limit_nano_usd: string;
        monthly_limit_nano_usd: string;
        default_validity_days: number;
        rpm_limit: number | null;
        concurrency_limit: number | null;
        created_at: Date;
      }[]
    >`
      SELECT
        g.id,
        g.name,
        g.description,
        g.platform,
        g.subscription_type,
        g.rate_multiplier::text,
        g.model_allowlist,
        g.is_exclusive,
        g.sort_order,
        g.enabled,
        COUNT(a.id)::text AS account_count,
        COUNT(a.id) FILTER (
          WHERE a.status NOT IN ('paused', 'expired')
            AND NOT (COALESCE(a.auto_pause_on_expired, TRUE) AND a.expires_at IS NOT NULL AND a.expires_at <= NOW())
            AND CASE WHEN a.temp_unsched_until IS NOT NULL THEN a.temp_unsched_until <= NOW() ELSE a.status = 'active' END
        )::text AS active_account_count,
        (SELECT COUNT(*) FROM core.api_keys k WHERE k.group_id = g.id)::text AS api_key_count,
        g.daily_limit_nano_usd::text,
        g.weekly_limit_nano_usd::text,
        g.monthly_limit_nano_usd::text,
        g.default_validity_days,
        g.rpm_limit,
        g.concurrency_limit,
        g.created_at
      FROM core.groups g
      LEFT JOIN core.accounts a ON a.group_id = g.id
      WHERE (${!filter.enabledOnly} OR g.enabled = TRUE)
        AND (${filter.groupId ?? null}::text IS NULL OR g.id = ${filter.groupId ?? null})
      GROUP BY g.id
      ORDER BY g.sort_order ASC, g.created_at ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      platform: r.platform,
      subscriptionType: r.subscription_type,
      rateMultiplier: Number.parseFloat(r.rate_multiplier),
      modelAllowlist: jsonArray(r.model_allowlist),
      isExclusive: Boolean(r.is_exclusive),
      sortOrder: r.sort_order ?? 0,
      enabled: r.enabled,
      accountCount: Number.parseInt(r.account_count, 10),
      activeAccountCount: Number.parseInt(r.active_account_count, 10),
      apiKeyCount: Number.parseInt(r.api_key_count, 10),
      dailyLimitNanoUsd: r.daily_limit_nano_usd ?? "0",
      weeklyLimitNanoUsd: r.weekly_limit_nano_usd ?? "0",
      monthlyLimitNanoUsd: r.monthly_limit_nano_usd ?? "0",
      defaultValidityDays: r.default_validity_days ?? 30,
      rpmLimit: r.rpm_limit ?? 0,
      concurrencyLimit: r.concurrency_limit ?? 0,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createGroup(req: CreateGroupRequest): Promise<GroupItem> {
    try {
      const id = `grp_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.groups (
          id, name, description, platform, subscription_type, rate_multiplier,
          model_allowlist, is_exclusive, sort_order, enabled,
          daily_limit_nano_usd, weekly_limit_nano_usd, monthly_limit_nano_usd, default_validity_days,
          rpm_limit, concurrency_limit
        )
        VALUES (
          ${id},
          ${req.name},
          ${req.description},
          ${req.platform},
          ${req.subscriptionType},
          ${req.rateMultiplier},
          ${this.sql.json(req.modelAllowlist)},
          ${req.isExclusive},
          ${req.sortOrder},
          ${req.enabled},
          ${limitNano(req.dailyLimitUsd)}::numeric,
          ${limitNano(req.weeklyLimitUsd)}::numeric,
          ${limitNano(req.monthlyLimitUsd)}::numeric,
          ${req.defaultValidityDays},
          ${req.rpmLimit},
          ${req.concurrencyLimit}
        )
      `;
      const [created] = await this.queryGroups({ groupId: id });
      if (!created) {
        throw new StoreError("not_found", `Group ${id} missing after insert`);
      }
      return created;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem> {
    try {
      const allowlistJson = req.modelAllowlist ? this.sql.json(req.modelAllowlist) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.groups
        SET name = COALESCE(${req.name ?? null}, name),
            description = COALESCE(${req.description ?? null}, description),
            subscription_type = COALESCE(${req.subscriptionType ?? null}, subscription_type),
            rate_multiplier = COALESCE(${req.rateMultiplier ?? null}, rate_multiplier),
            model_allowlist = COALESCE(${allowlistJson}::jsonb, model_allowlist),
            is_exclusive = COALESCE(${req.isExclusive ?? null}, is_exclusive),
            sort_order = COALESCE(${req.sortOrder ?? null}, sort_order),
            enabled = COALESCE(${req.enabled ?? null}, enabled),
            daily_limit_nano_usd = COALESCE(${optionalLimitNano(req.dailyLimitUsd)}::numeric, daily_limit_nano_usd),
            weekly_limit_nano_usd = COALESCE(${optionalLimitNano(req.weeklyLimitUsd)}::numeric, weekly_limit_nano_usd),
            monthly_limit_nano_usd = COALESCE(${optionalLimitNano(req.monthlyLimitUsd)}::numeric, monthly_limit_nano_usd),
            default_validity_days = COALESCE(${req.defaultValidityDays ?? null}, default_validity_days),
            rpm_limit = COALESCE(${req.rpmLimit ?? null}::int, rpm_limit),
            concurrency_limit = COALESCE(${req.concurrencyLimit ?? null}::int, concurrency_limit),
            updated_at = NOW()
        WHERE id = ${groupId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Group ${groupId} not found`);
      }
      const [updated] = await this.queryGroups({ groupId });
      return updated!;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async deleteGroup(groupId: string): Promise<{ ungroupedAccounts: number }> {
    try {
      return await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        // Lock the group so no key is minted on it (createApiKey takes FOR SHARE) mid-delete.
        const group = await tx<{ id: string }[]>`SELECT id FROM core.groups WHERE id = ${groupId} FOR UPDATE`;
        if (group.length === 0) {
          throw new StoreError("not_found", `Group ${groupId} not found`);
        }
        const keys = await tx<{ id: string }[]>`SELECT id FROM core.api_keys WHERE group_id = ${groupId} LIMIT 1`;
        if (keys.length > 0) {
          throw new StoreError("conflict", "Cannot delete group referenced by active API keys");
        }
        // Accounts outlive their group: ungroup them explicitly (the FK is ON DELETE SET NULL too).
        const ungrouped = await tx<{ id: string }[]>`
          UPDATE core.accounts SET group_id = NULL, updated_at = NOW() WHERE group_id = ${groupId} RETURNING id
        `;
        await tx`DELETE FROM core.groups WHERE id = ${groupId}`;
        return { ungroupedAccounts: ungrouped.length };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async duplicateGroup(groupId: string): Promise<GroupItem> {
    const [source] = await this.queryGroups({ groupId });
    if (!source) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    const taken = new Set((await this.queryGroups({})).map((g) => g.name.toLowerCase()));
    let name = `${source.name}-copy`.slice(0, 64);
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `${source.name.slice(0, 56)}-copy-${n}`;
    }
    return this.createGroup({
      name,
      description: source.description,
      platform: source.platform,
      subscriptionType: source.subscriptionType,
      rateMultiplier: source.rateMultiplier,
      modelAllowlist: [...source.modelAllowlist],
      isExclusive: source.isExclusive,
      sortOrder: source.sortOrder,
      enabled: false,
      dailyLimitUsd: formatNanoUsd(BigInt(source.dailyLimitNanoUsd)),
      weeklyLimitUsd: formatNanoUsd(BigInt(source.weeklyLimitNanoUsd)),
      monthlyLimitUsd: formatNanoUsd(BigInt(source.monthlyLimitNanoUsd)),
      defaultValidityDays: source.defaultValidityDays,
      rpmLimit: source.rpmLimit,
      concurrencyLimit: source.concurrencyLimit,
    });
  }

  async listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]> {
    return this.queryAccounts(filter ?? {});
  }

  async getAccount(accountId: string): Promise<UpstreamAccount | null> {
    const [item] = await this.queryAccounts({ accountId });
    return item ?? null;
  }

  private async queryAccounts(filter: {
    groupId?: string;
    executionMode?: string;
    accountId?: string;
  }): Promise<UpstreamAccount[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        notes: string | null;
        group_id: string;
        group_name: string;
        platform: UpstreamAccount["platform"];
        execution_mode: UpstreamAccount["executionMode"];
        auth_kind: UpstreamAccount["authKind"];
        subscription_tier: string | null;
        credential_preview: string;
        max_concurrency: number;
        priority: number;
        status: UpstreamAccount["status"];
        expires_at: Date | null;
        auto_pause_on_expired: boolean | null;
        temp_unsched_until: Date | null;
        temp_unsched_reason: string | null;
        window_5h_used_bps: number | null;
        window_5h_reset_at: Date | null;
        window_7d_used_bps: number | null;
        window_7d_reset_at: Date | null;
        last_used_at: Date | null;
        temp_unsched_rules: unknown;
        last_test_at: Date | null;
        last_test_ok: boolean | null;
        last_test_model: string | null;
        last_test_duration_ms: number | null;
        last_test_message: string | null;
        privacy_mode: string | null;
        privacy_checked_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT
        a.id,
        COALESCE(NULLIF(a.name, ''), a.id) AS name,
        a.notes,
        COALESCE(a.group_id, '') AS group_id,
        COALESCE(g.name, '') AS group_name,
        a.platform,
        a.execution_mode,
        a.auth_kind,
        a.subscription_tier,
        a.credential_preview,
        a.max_concurrency,
        a.priority,
        a.status,
        a.expires_at,
        a.auto_pause_on_expired,
        a.temp_unsched_until,
        a.temp_unsched_reason,
        q.window_5h_used_bps,
        q.window_5h_reset_at,
        q.window_7d_used_bps,
        q.window_7d_reset_at,
        q.last_used_at,
        a.temp_unsched_rules,
        a.last_test_at,
        a.last_test_ok,
        a.last_test_model,
        a.last_test_duration_ms,
        a.last_test_message,
        a.privacy_mode,
        a.privacy_checked_at,
        a.created_at
      FROM core.accounts a
      LEFT JOIN core.groups g ON g.id = a.group_id
      LEFT JOIN core.account_window_quotas q ON q.account_id = a.id
      WHERE (${filter.groupId ?? null}::text IS NULL OR a.group_id = ${filter.groupId ?? null})
        AND (${filter.executionMode ?? null}::text IS NULL OR a.execution_mode = ${filter.executionMode ?? null})
        AND (${filter.accountId ?? null}::text IS NULL OR a.id = ${filter.accountId ?? null})
      ORDER BY a.priority ASC, a.created_at DESC
    `;
    const nowMs = Date.now();
    return rows.map((r) => {
      const subscriptionTier = effectiveSubscriptionTier(
        r.auth_kind,
        SubscriptionTierSchema.catch("standard").parse(r.subscription_tier),
      );
      const lifecycle = {
        status: r.status,
        expiresAtIso: r.expires_at ? toIso(r.expires_at) : null,
        autoPauseOnExpired: r.auto_pause_on_expired ?? true,
        cooldownUntilIso: r.temp_unsched_until ? toIso(r.temp_unsched_until) : null,
      };
      return {
        id: r.id,
        name: r.name,
        notes: r.notes ?? "",
        groupId: r.group_id,
        groupName: r.group_name,
        platform: r.platform,
        executionMode: r.execution_mode,
        authKind: r.auth_kind,
        subscriptionTier,
        tierMultiplier: subscriptionTierMultiplier(r.platform, subscriptionTier),
        credentialPreview: r.credential_preview || "****",
        maxConcurrency: r.max_concurrency,
        priority: r.priority,
        ...lifecycle,
        effectiveStatus: effectiveAccountStatus(lifecycle, nowMs),
        cooldownReason: r.temp_unsched_reason ?? "",
        window5hUsedBps: r.window_5h_reset_at && r.window_5h_reset_at.getTime() <= nowMs ? 0 : (r.window_5h_used_bps ?? 0),
        window7dUsedBps: r.window_7d_reset_at && r.window_7d_reset_at.getTime() <= nowMs ? 0 : (r.window_7d_used_bps ?? 0),
        lastTest:
          r.last_test_at && r.last_test_ok !== null
            ? {
                ok: r.last_test_ok,
                atIso: toIso(r.last_test_at),
                model: r.last_test_model ?? "",
                durationMs: r.last_test_duration_ms ?? 0,
                message: r.last_test_message ?? "",
              }
            : null,
        lastUsedAtIso: r.last_used_at ? toIso(r.last_used_at) : null,
        tempUnschedRules: parseTempUnschedRules(r.temp_unsched_rules),
        privacyMode: AccountPrivacyModeSchema.nullable().catch(null).parse(r.privacy_mode),
        privacyCheckedAtIso: r.privacy_checked_at ? toIso(r.privacy_checked_at) : null,
        createdAtIso: toIso(r.created_at),
      };
    });
  }

  async createAccount(req: CreateAccountRequest, credential: StoredCredential): Promise<UpstreamAccount> {
    if (!isSubscriptionTierAllowedForProvider(req.platform, req.subscriptionTier)) {
      throw new StoreError(
        "bad_request",
        `Subscription tier ${req.subscriptionTier} is not valid for provider ${req.platform}`,
      );
    }
    try {
      const id = `acc_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.accounts (
          id, name, notes, group_id, platform, execution_mode, auth_kind, subscription_tier,
          credentials_enc, credential_preview, credential_fingerprint, max_concurrency, priority, status,
          expires_at, auto_pause_on_expired, temp_unsched_rules
        )
        VALUES (
          ${id},
          ${req.name},
          ${req.notes},
          ${req.groupId || null},
          ${req.platform},
          ${req.executionMode},
          ${req.authKind},
          ${effectiveSubscriptionTier(req.authKind, req.subscriptionTier)},
          ${Buffer.from(credential.encrypted)},
          ${credential.preview},
          ${credential.fingerprint},
          ${req.maxConcurrency},
          ${req.priority},
          ${req.status},
          ${toDateOrNull(req.expiresAtIso)},
          ${req.autoPauseOnExpired},
          ${this.sql.json(req.tempUnschedRules as unknown as postgres.JSONValue)}
        )
      `;
      const created = await this.getAccount(id);
      if (!created) {
        throw new StoreError("not_found", `Account ${id} missing after insert`);
      }
      return created;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async updateAccount(
    accountId: string,
    req: UpdateAccountRequest,
    credential?: StoredCredential,
  ): Promise<UpstreamAccount> {
    try {
      if (req.subscriptionTier !== undefined) {
        const current = await this.sql<{ platform: UpstreamAccount["platform"] }[]>`
          SELECT platform FROM core.accounts WHERE id = ${accountId} LIMIT 1
        `;
        if (current.length === 0) {
          throw new StoreError("not_found", `Account ${accountId} not found`);
        }
        if (!isSubscriptionTierAllowedForProvider(current[0]!.platform, req.subscriptionTier)) {
          throw new StoreError(
            "bad_request",
            `Subscription tier ${req.subscriptionTier} is not valid for provider ${current[0]!.platform}`,
          );
        }
      }
      const secretBuf = credential ? Buffer.from(credential.encrypted) : null;
      // Nullable columns need an explicit "was it sent" flag: COALESCE cannot write NULL.
      const expiresAt = normalizeIso(req.expiresAtIso);
      const cooldown = resolveCooldownChange(req);
      const rulesJson = req.tempUnschedRules ? this.sql.json(req.tempUnschedRules as unknown as postgres.JSONValue) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.accounts
        SET name = COALESCE(${req.name ?? null}, name),
            notes = COALESCE(${req.notes ?? null}, notes),
            -- "" ungroups the account, so the "was it sent" flag decides like the nullable columns below.
            group_id = CASE
              WHEN ${req.groupId !== undefined}::boolean THEN NULLIF(${req.groupId ?? ""}, '')
              ELSE group_id
            END,
            execution_mode = COALESCE(${req.executionMode ?? null}, execution_mode),
            auth_kind = COALESCE(${req.authKind ?? null}, auth_kind),
            -- The right-hand auth_kind is the old value, so COALESCE yields the resulting kind.
            subscription_tier = CASE
              WHEN COALESCE(${req.authKind ?? null}, auth_kind) = 'api_key' THEN 'standard'
              ELSE COALESCE(${req.subscriptionTier ?? null}, subscription_tier)
            END,
            max_concurrency = COALESCE(${req.maxConcurrency ?? null}, max_concurrency),
            priority = COALESCE(${req.priority ?? null}, priority),
            status = COALESCE(${req.status ?? null}, status),
            expires_at = CASE
              WHEN ${expiresAt !== undefined}::boolean THEN ${toDateOrNull(expiresAt)}::timestamptz
              ELSE expires_at
            END,
            auto_pause_on_expired = COALESCE(${req.autoPauseOnExpired ?? null}::boolean, auto_pause_on_expired),
            temp_unsched_until = CASE
              WHEN ${cooldown.untilIso !== undefined}::boolean THEN ${toDateOrNull(cooldown.untilIso)}::timestamptz
              ELSE temp_unsched_until
            END,
            temp_unsched_reason = COALESCE(${cooldown.reason ?? null}, temp_unsched_reason),
            temp_unsched_rules = COALESCE(${rulesJson}::jsonb, temp_unsched_rules),
            credentials_enc = COALESCE(${secretBuf}, credentials_enc),
            credential_preview = COALESCE(${credential?.preview ?? null}, credential_preview),
            credential_fingerprint = COALESCE(${credential?.fingerprint ?? null}, credential_fingerprint),
            updated_at = NOW()
        WHERE id = ${accountId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Account ${accountId} not found`);
      }
      return (await this.getAccount(accountId))!;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.accounts WHERE id = ${accountId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
  }

  async recordAccountPrivacy(accountId: string, mode: AccountPrivacyMode, checkedAtIso: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE core.accounts
      SET privacy_mode = ${mode}, privacy_checked_at = ${new Date(checkedAtIso)}
      WHERE id = ${accountId}
      RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
  }

  async recordAccountTestResult(accountId: string, result: AccountTestResult): Promise<void> {
    await this.sql`
      UPDATE core.accounts
      SET last_test_at = ${new Date(result.atIso)},
          last_test_ok = ${result.ok},
          last_test_model = ${result.model},
          last_test_duration_ms = ${result.durationMs},
          last_test_message = ${result.message}
      WHERE id = ${accountId}
    `;
  }

  async listAccountSecrets(accountIds?: string[]): Promise<AccountSecretRecord[]> {
    type Row = { id: string; credentials_enc: Uint8Array; credential_fingerprint: string | null };
    const rows = accountIds
      ? await this.sql<Row[]>`
          SELECT id, credentials_enc, credential_fingerprint
          FROM core.accounts
          WHERE id = ANY(${accountIds}::text[])
          ORDER BY priority ASC, created_at DESC
        `
      : await this.sql<Row[]>`
          SELECT id, credentials_enc, credential_fingerprint
          FROM core.accounts
          ORDER BY priority ASC, created_at DESC
        `;
    return rows.map((r) => ({
      accountId: r.id,
      encrypted: new Uint8Array(r.credentials_enc),
      fingerprint: r.credential_fingerprint,
    }));
  }

  async findAccountsByFingerprint(fingerprints: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (fingerprints.length === 0) return out;
    const rows = await this.sql<{ id: string; credential_fingerprint: string }[]>`
      SELECT id, credential_fingerprint
      FROM core.accounts
      WHERE credential_fingerprint = ANY(${fingerprints}::text[])
      ORDER BY created_at ASC
    `;
    for (const r of rows) {
      if (!out.has(r.credential_fingerprint)) out.set(r.credential_fingerprint, r.id);
    }
    return out;
  }

  async setCredentialFingerprint(accountId: string, fingerprint: string): Promise<void> {
    await this.sql`
      UPDATE core.accounts SET credential_fingerprint = ${fingerprint} WHERE id = ${accountId}
    `;
  }

  async summarizeAccountUsage(sinceIso: string): Promise<AccountUsageSummaryItem[]> {
    const rows = await this.sql<
      {
        account_id: string;
        requests: string;
        errors: string;
        input_tokens: string;
        output_tokens: string;
        cost_nano_usd: string;
      }[]
    >`
      SELECT
        account_id,
        COUNT(*)::text AS requests,
        COUNT(*) FILTER (WHERE status_code >= 400)::text AS errors,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(cost_nano_usd), 0)::text AS cost_nano_usd
      FROM core.usage_logs
      WHERE created_at >= ${new Date(sinceIso)}
      GROUP BY account_id
    `;
    return rows.map((r) => ({
      accountId: r.account_id,
      requests: Number.parseInt(r.requests, 10),
      errors: Number.parseInt(r.errors, 10),
      inputTokens: Number.parseInt(r.input_tokens, 10),
      outputTokens: Number.parseInt(r.output_tokens, 10),
      // NUMERIC(39,0) sums print without a fraction; keep only the integer part regardless.
      costNanoUsd: BigInt(r.cost_nano_usd.split(".")[0] || "0").toString(),
    }));
  }

  async listUserApiKeys(userId: string): Promise<ApiKeyItem[]> {
    return this.queryApiKeys(this.sql`k.user_id = ${userId}`);
  }

  /** Keys with their rolling-window spend (honouring each key's window reset). */
  private async queryApiKeys(where: postgres.Fragment): Promise<ApiKeyItem[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        user_id: string;
        group_id: string;
        group_name: string;
        key_prefix: string;
        rpm_limit: number;
        concurrency_limit: number;
        ip_allowlist: string[];
        ip_denylist: string[];
        enabled: boolean;
        expires_at: Date | null;
        created_at: Date;
        quota: string;
        spent: string;
        l5h: string;
        l1d: string;
        l7d: string;
        u5h: string;
        u1d: string;
        u7d: string;
        last_used_at: Date | null;
      }[]
    >`
      SELECT
        k.id, k.name, k.user_id, k.group_id, g.name AS group_name, k.key_prefix, k.rpm_limit,
        k.concurrency_limit, k.ip_allowlist, k.ip_denylist, k.enabled, k.expires_at, k.created_at,
        k.quota_nano_usd::text AS quota, k.spent_nano_usd::text AS spent,
        k.limit_5h_nano_usd::text AS l5h, k.limit_1d_nano_usd::text AS l1d, k.limit_7d_nano_usd::text AS l7d,
        COALESCE(w.h5, 0)::text AS u5h, COALESCE(w.d1, 0)::text AS u1d, COALESCE(w.d7, 0)::text AS u7d,
        k.last_used_at
      FROM core.api_keys k
      JOIN core.groups g ON g.id = k.group_id
      LEFT JOIN LATERAL (
        SELECT SUM(l.cost_nano_usd) FILTER (WHERE l.created_at >= GREATEST(NOW() - INTERVAL '5 hours', COALESCE(k.usage_reset_at, '-infinity'::timestamptz))) AS h5,
               SUM(l.cost_nano_usd) FILTER (WHERE l.created_at >= GREATEST(NOW() - INTERVAL '1 day', COALESCE(k.usage_reset_at, '-infinity'::timestamptz))) AS d1,
               SUM(l.cost_nano_usd) AS d7
          FROM core.usage_logs l
         WHERE l.api_key_id = k.id
           AND l.created_at >= GREATEST(NOW() - INTERVAL '7 days', COALESCE(k.usage_reset_at, '-infinity'::timestamptz))
           AND (k.usage_reset_at IS NULL OR l.created_at > k.usage_reset_at)
      ) w ON TRUE
      WHERE ${where}
      ORDER BY k.created_at DESC
    `;
    return rows.map((r) => {
      const over = (limit: string, used: string) => BigInt(limit) > 0n && BigInt(used) >= BigInt(limit);
      const limitState: ApiKeyItem["limitState"] =
        BigInt(r.quota) > 0n && BigInt(r.spent) >= BigInt(r.quota)
          ? "quota_exhausted"
          : over(r.l5h, r.u5h) || over(r.l1d, r.u1d) || over(r.l7d, r.u7d)
            ? "window_exhausted"
            : "ok";
      return {
        id: r.id,
        name: r.name,
        userId: r.user_id,
        groupId: r.group_id,
        groupName: r.group_name,
        keyPrefix: r.key_prefix,
        rpmLimit: r.rpm_limit,
        concurrencyLimit: r.concurrency_limit,
        ipAllowlist: jsonArray(r.ip_allowlist),
        ipDenylist: jsonArray(r.ip_denylist),
        enabled: r.enabled,
        expiresAtIso: r.expires_at ? toIso(r.expires_at) : null,
        createdAtIso: toIso(r.created_at),
        quotaNanoUsd: r.quota,
        spentNanoUsd: r.spent,
        limit5hNanoUsd: r.l5h,
        limit1dNanoUsd: r.l1d,
        limit7dNanoUsd: r.l7d,
        usage5hNanoUsd: r.u5h,
        usage1dNanoUsd: r.u1d,
        usage7dNanoUsd: r.u7d,
        lastUsedAtIso: r.last_used_at ? toIso(r.last_used_at) : null,
        limitState,
      };
    });
  }

  async createApiKey(
    userId: string,
    req: CreateApiKeyRequest,
    keyPrefix: string,
    keyHash: Uint8Array,
  ): Promise<ApiKeyItem> {
    const id = `key_${crypto.randomUUID()}`;
    try {
      await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        // Same contract as MemoryControlStore: keys may only be minted on an existing,
        // enabled group. FOR SHARE holds off a concurrent disable/delete until commit.
        const groups = await tx<{ id: string }[]>`
          SELECT id FROM core.groups WHERE id = ${req.groupId} AND enabled FOR SHARE
        `;
        if (groups.length === 0) {
          throw new StoreError("bad_request", `Group ${req.groupId} is unavailable`);
        }
        await tx`
          INSERT INTO core.api_keys (
            id, name, user_id, group_id, key_prefix, key_hash_blake3,
            rpm_limit, concurrency_limit, ip_allowlist, ip_denylist, enabled, expires_at,
            quota_nano_usd, limit_5h_nano_usd, limit_1d_nano_usd, limit_7d_nano_usd
          )
          VALUES (
            ${id},
            ${req.name},
            ${userId},
            ${req.groupId},
            ${keyPrefix},
            ${Buffer.from(keyHash)},
            ${req.rpmLimit},
            ${req.concurrencyLimit},
            ${this.sql.json(req.ipAllowlist)},
            ${this.sql.json(req.ipDenylist)},
            TRUE,
            ${req.expiresAtIso ? new Date(req.expiresAtIso) : null},
            ${limitNano(req.quotaUsd ?? "0")}::numeric,
            ${limitNano(req.limit5hUsd ?? "0")}::numeric,
            ${limitNano(req.limit1dUsd ?? "0")}::numeric,
            ${limitNano(req.limit7dUsd ?? "0")}::numeric
          )
        `;
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      if ((err as { code?: string })?.code === "23505") throw new StoreError("conflict", "That key is already in use");
      mapPgError(err);
    }
    // Just the new key (its spend windows are empty anyway), not a listing of all the user's keys.
    return (await this.queryApiKeys(this.sql`k.id = ${id}`))[0]!;
  }

  async updateUserApiKey(
    userId: string,
    keyId: string,
    req: UpdateApiKeyRequest,
  ): Promise<ApiKeyItem> {
    const { items, failed } = await this.updateUserApiKeys(userId, [keyId], req);
    if (failed[0]) throw failed[0].error;
    return items[0]!;
  }

  async updateUserApiKeys(userId: string, keyIds: string[], req: UpdateApiKeyRequest): Promise<ApiKeyBulkResult> {
    const ids = [...new Set(keyIds)];
    const result: ApiKeyBulkResult = { items: [], failed: [] };
    if (ids.length === 0) return result;
    const okIds: string[] = [];
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlExecutor;
      const owned = await tx<{ id: string; group_id: string }[]>`
        SELECT id, group_id FROM core.api_keys WHERE user_id = ${userId} AND id = ANY(${ids}) FOR UPDATE
      `;
      // Same contract as MemoryControlStore: an unknown key is not_found first, and the target
      // group must be enabled only when the key actually moves (repeating its current group,
      // e.g. a bulk patch that carries it, stays valid after that group is disabled). FOR SHARE
      // holds off a concurrent disable/delete of the target until commit, as createApiKey does.
      let targetUsable = true;
      if (req.groupId !== undefined) {
        const target = await tx`SELECT 1 FROM core.groups WHERE id = ${req.groupId} AND enabled FOR SHARE`;
        targetUsable = target.length > 0;
      }
      const groupOf = new Map(owned.map((r) => [r.id, r.group_id]));
      for (const id of ids) {
        const current = groupOf.get(id);
        if (current === undefined) {
          result.failed.push({ keyId: id, error: new StoreError("not_found", `API key ${id} not found`) });
        } else if (req.groupId !== undefined && current !== req.groupId && !targetUsable) {
          result.failed.push({ keyId: id, error: new StoreError("bad_request", `Group ${req.groupId} is unavailable`) });
        } else {
          okIds.push(id);
        }
      }
      if (okIds.length === 0) return;
      const allow = req.ipAllowlist ? this.sql.json(req.ipAllowlist) : null;
      const deny = req.ipDenylist ? this.sql.json(req.ipDenylist) : null;
      const expiresSent = req.expiresAtIso !== undefined;
      await tx`
        UPDATE core.api_keys
        SET name = COALESCE(${req.name ?? null}, name),
            group_id = COALESCE(${req.groupId ?? null}, group_id),
            rpm_limit = COALESCE(${req.rpmLimit ?? null}, rpm_limit),
            concurrency_limit = COALESCE(${req.concurrencyLimit ?? null}, concurrency_limit),
            enabled = COALESCE(${req.enabled ?? null}, enabled),
            ip_allowlist = COALESCE(${allow}::jsonb, ip_allowlist),
            ip_denylist = COALESCE(${deny}::jsonb, ip_denylist),
            expires_at = CASE WHEN ${expiresSent} THEN ${req.expiresAtIso ? new Date(req.expiresAtIso) : null}::timestamptz ELSE expires_at END,
            quota_nano_usd = COALESCE(${optionalLimitNano(req.quotaUsd)}::numeric, quota_nano_usd),
            limit_5h_nano_usd = COALESCE(${optionalLimitNano(req.limit5hUsd)}::numeric, limit_5h_nano_usd),
            limit_1d_nano_usd = COALESCE(${optionalLimitNano(req.limit1dUsd)}::numeric, limit_1d_nano_usd),
            limit_7d_nano_usd = COALESCE(${optionalLimitNano(req.limit7dUsd)}::numeric, limit_7d_nano_usd),
            spent_nano_usd = CASE WHEN ${req.resetQuota === true} THEN 0 ELSE spent_nano_usd END,
            usage_reset_at = CASE WHEN ${req.resetWindows === true} THEN NOW() ELSE usage_reset_at END
        WHERE user_id = ${userId} AND id = ANY(${okIds})
      `;
    });
    if (okIds.length > 0) {
      // Spend windows for just the updated keys, once (not a listing of every key per key).
      const byId = new Map((await this.queryApiKeys(this.sql`k.id = ANY(${okIds})`)).map((k) => [k.id, k]));
      for (const id of okIds) {
        const item = byId.get(id);
        if (item) result.items.push(item);
      }
    }
    return result;
  }

  async listLimitedKeyIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM core.api_keys
       WHERE quota_nano_usd > 0 OR limit_5h_nano_usd > 0 OR limit_1d_nano_usd > 0 OR limit_7d_nano_usd > 0
    `;
    return rows.map((r) => r.id);
  }

  async listOverLimitKeyIds(): Promise<string[]> {
    const keys = await this.queryLimitStates(
      this.sql`(k.quota_nano_usd > 0 OR k.limit_5h_nano_usd > 0 OR k.limit_1d_nano_usd > 0 OR k.limit_7d_nano_usd > 0)`,
    );
    return keys.filter((k) => k.limitState !== "ok").map((k) => k.id);
  }

  async getApiKeyLimitState(keyId: string): Promise<ApiKeyItem["limitState"] | null> {
    const rows = await this.queryLimitStates(this.sql`k.id = ${keyId}`);
    return rows[0]?.limitState ?? null;
  }

  /**
   * Same verdict as queryApiKeys' limitState, at the cost of only the windows that matter: the
   * usage scan is bounded by the widest window that has a cap (none for quota-only or exhausted
   * keys: the bound is +infinity, an empty index range), and each sum is index-only on
   * idx_core_usage_logs_key_time_cost.
   */
  private async queryLimitStates(where: postgres.Fragment): Promise<{ id: string; limitState: ApiKeyItem["limitState"] }[]> {
    const rows = await this.sql<
      { id: string; quota: string; spent: string; l5h: string; l1d: string; l7d: string; u5h: string; u1d: string; u7d: string }[]
    >`
      SELECT
        k.id, k.quota_nano_usd::text AS quota, k.spent_nano_usd::text AS spent,
        k.limit_5h_nano_usd::text AS l5h, k.limit_1d_nano_usd::text AS l1d, k.limit_7d_nano_usd::text AS l7d,
        COALESCE(w.h5, 0)::text AS u5h, COALESCE(w.d1, 0)::text AS u1d, COALESCE(w.d7, 0)::text AS u7d
      FROM core.api_keys k
      LEFT JOIN LATERAL (
        SELECT SUM(l.cost_nano_usd) FILTER (WHERE k.limit_5h_nano_usd > 0 AND l.created_at >= GREATEST(NOW() - INTERVAL '5 hours', COALESCE(k.usage_reset_at, '-infinity'::timestamptz))) AS h5,
               SUM(l.cost_nano_usd) FILTER (WHERE k.limit_1d_nano_usd > 0 AND l.created_at >= GREATEST(NOW() - INTERVAL '1 day', COALESCE(k.usage_reset_at, '-infinity'::timestamptz))) AS d1,
               SUM(l.cost_nano_usd) FILTER (WHERE k.limit_7d_nano_usd > 0) AS d7
          FROM core.usage_logs l
         WHERE l.api_key_id = k.id
           AND l.created_at >= GREATEST(
                 COALESCE(
                   NOW() - CASE
                     WHEN k.quota_nano_usd > 0 AND k.spent_nano_usd >= k.quota_nano_usd THEN NULL
                     WHEN k.limit_7d_nano_usd > 0 THEN INTERVAL '7 days'
                     WHEN k.limit_1d_nano_usd > 0 THEN INTERVAL '1 day'
                     WHEN k.limit_5h_nano_usd > 0 THEN INTERVAL '5 hours'
                   END,
                   'infinity'::timestamptz
                 ),
                 COALESCE(k.usage_reset_at, '-infinity'::timestamptz)
               )
           AND (k.usage_reset_at IS NULL OR l.created_at > k.usage_reset_at)
      ) w ON TRUE
      WHERE ${where}
    `;
    return rows.map((r) => {
      const over = (limit: string, used: string) => BigInt(limit) > 0n && BigInt(used) >= BigInt(limit);
      const limitState: ApiKeyItem["limitState"] =
        BigInt(r.quota) > 0n && BigInt(r.spent) >= BigInt(r.quota)
          ? "quota_exhausted"
          : over(r.l5h, r.u5h) || over(r.l1d, r.u1d) || over(r.l7d, r.u7d)
            ? "window_exhausted"
            : "ok";
      return { id: r.id, limitState };
    });
  }

  async deleteUserApiKey(userId: string, keyId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.api_keys WHERE id = ${keyId} AND user_id = ${userId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `API key ${keyId} not found`);
    }
  }

  async listCompositeRoutes(groupId?: string): Promise<StoredCompositeRoute[]> {
    const rows = await this.sql<
      {
        id: string;
        group_id: string;
        public_model: string;
        match_type: StoredCompositeRoute["matchType"];
        target_platform: StoredCompositeRoute["targetPlatform"];
        upstream_model: string;
        endpoint: StoredCompositeRoute["endpoint"];
        priority: number;
        enabled: boolean;
        created_at: Date;
      }[]
    >`
      SELECT
        id,
        group_id,
        public_model,
        match_type,
        target_platform,
        upstream_model,
        endpoint,
        priority,
        enabled,
        created_at
      FROM core.composite_routes
      WHERE (${groupId ?? null}::text IS NULL OR group_id = ${groupId ?? null})
      ORDER BY priority ASC, id ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      publicModel: r.public_model,
      matchType: r.match_type,
      targetPlatform: r.target_platform,
      upstreamModel: r.upstream_model,
      endpoint: r.endpoint,
      priority: r.priority,
      enabled: r.enabled,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createCompositeRoute(req: CreateCompositeRouteRequest): Promise<StoredCompositeRoute> {
    try {
      const id = `rte_${crypto.randomUUID()}`;
      const rows = await this.sql<{ created_at: Date }[]>`
        INSERT INTO core.composite_routes (
          id, group_id, public_model, match_type, target_platform,
          upstream_model, endpoint, priority, enabled
        )
        VALUES (
          ${id},
          ${req.groupId},
          ${req.publicModel},
          ${req.matchType},
          ${req.targetPlatform},
          ${req.upstreamModel},
          ${req.endpoint},
          ${req.priority},
          ${req.enabled}
        )
        RETURNING created_at
      `;
      return {
        id,
        groupId: req.groupId,
        publicModel: req.publicModel,
        matchType: req.matchType,
        targetPlatform: req.targetPlatform,
        upstreamModel: req.upstreamModel,
        endpoint: req.endpoint,
        priority: req.priority,
        enabled: req.enabled,
        createdAtIso: toIso(rows[0]?.created_at),
      };
    } catch (err) {
      mapPgError(err);
    }
  }

  async deleteCompositeRoute(routeId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.composite_routes WHERE id = ${routeId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Composite route ${routeId} not found`);
    }
  }

  async exportDataPlaneSnapshot(): Promise<DataPlaneSyncSnapshot> {
    // Taken before the reads: every settlement committed before this instant is in the balances,
    // which is what slipgate-core compares its confirmed local debits against.
    const revisionUnixMs = Date.now();
    const [groups, routes, accRows, keyRows, walletRows, banRows] = await Promise.all([
      this.listGroups(false),
      this.listCompositeRoutes(),
      this.sql<
        {
          id: string;
          group_id: string;
          platform: UpstreamAccount["platform"];
          execution_mode: UpstreamAccount["executionMode"];
          auth_kind: string;
          subscription_tier: string | null;
          credentials_enc_hex: string;
          max_concurrency: number;
          priority: number;
          status: UpstreamAccount["status"];
          expires_at: Date | null;
          auto_pause_on_expired: boolean | null;
          temp_unsched_until: Date | null;
          temp_unsched_rules: unknown;
          window_5h_used_bps: number | null;
          window_5h_reset_at: Date | null;
          window_7d_used_bps: number | null;
          window_7d_reset_at: Date | null;
        }[]
      >`
        SELECT
          a.id,
          COALESCE(a.group_id, '') AS group_id,
          a.platform,
          a.execution_mode,
          a.auth_kind,
          a.subscription_tier,
          encode(a.credentials_enc, 'hex') AS credentials_enc_hex,
          a.max_concurrency,
          a.priority,
          a.status,
          a.expires_at,
          a.auto_pause_on_expired,
          a.temp_unsched_until,
          a.temp_unsched_rules,
          q.window_5h_used_bps,
          q.window_5h_reset_at,
          q.window_7d_used_bps,
          q.window_7d_reset_at
        FROM core.accounts a
        LEFT JOIN core.account_window_quotas q ON q.account_id = a.id
        ORDER BY a.priority ASC, a.id ASC
      `,
      this.sql<
        {
          id: string;
          user_id: string;
          group_id: string;
          key_hash_hex: string;
          rpm_limit: number;
          concurrency_limit: number;
          ip_allowlist: string[];
          ip_denylist: string[];
          enabled: boolean;
          expires_at: Date | null;
        }[]
      >`
        SELECT
          id,
          user_id,
          group_id,
          encode(key_hash_blake3, 'hex') AS key_hash_hex,
          rpm_limit,
          concurrency_limit,
          ip_allowlist,
          ip_denylist,
          enabled,
          expires_at
        FROM core.api_keys
      `,
      this.sql<
        {
          user_id: string;
          balance_nano_usd: string;
          held_nano_usd: string;
        }[]
      >`
        SELECT user_id, balance_nano_usd::text, held_nano_usd::text
        FROM core.quota_wallets
      `,
      this.sql<
        {
          subject_kind: "device" | "session" | "api_key" | "ip";
          subject_hash: string;
          strike_level: number;
          expires_at: Date | null;
        }[]
      >`
        SELECT DISTINCT ON (subject_kind, subject_hash)
          subject_kind, subject_hash, strike_level, expires_at
        FROM core.risk_ban_records
        WHERE unbanned_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY subject_kind, subject_hash, strike_level DESC, created_at DESC
      `,
    ]);

    const nowMs = Date.now();
    return {
      revisionUnixMs,
      groups: groups.map((g) => ({
        id: g.id,
        platform: g.platform,
        subscriptionType: g.subscriptionType,
        rateMultiplier: g.rateMultiplier,
        modelAllowlist: g.modelAllowlist,
        enabled: g.enabled,
      })),
      routes,
      accounts: accRows.map((a) => {
        const subscriptionTier = effectiveSubscriptionTier(
          AccountAuthKindSchema.catch("oauth").parse(a.auth_kind),
          SubscriptionTierSchema.catch("standard").parse(a.subscription_tier),
        );
        return {
          id: a.id,
          groupId: a.group_id,
          platform: a.platform,
          executionMode: a.execution_mode,
          authKind: a.auth_kind,
          subscriptionTier,
          tierMultiplier: subscriptionTierMultiplier(a.platform, subscriptionTier),
          credentialsEncHex: a.credentials_enc_hex,
          maxConcurrency: a.max_concurrency,
          priority: a.priority,
          // The data plane only schedules "active"; expiry and cooldown deadlines resolve here.
          status: effectiveAccountStatus(
            {
              status: a.status,
              expiresAtIso: a.expires_at ? toIso(a.expires_at) : null,
              autoPauseOnExpired: a.auto_pause_on_expired ?? true,
              cooldownUntilIso: a.temp_unsched_until ? toIso(a.temp_unsched_until) : null,
            },
            nowMs,
          ),
          window5hUsedBps: a.window_5h_reset_at && a.window_5h_reset_at.getTime() <= nowMs ? 0 : (a.window_5h_used_bps ?? 0),
          window7dUsedBps: a.window_7d_reset_at && a.window_7d_reset_at.getTime() <= nowMs ? 0 : (a.window_7d_used_bps ?? 0),
          ...(a.window_5h_reset_at && a.window_5h_reset_at.getTime() > nowMs
            ? { window5hResetAtUnixMs: a.window_5h_reset_at.getTime() }
            : {}),
          ...(a.window_7d_reset_at && a.window_7d_reset_at.getTime() > nowMs
            ? { window7dResetAtUnixMs: a.window_7d_reset_at.getTime() }
            : {}),
          ...(() => {
            const rules = parseTempUnschedRules(a.temp_unsched_rules);
            return rules.length ? { tempUnschedRules: rules } : {};
          })(),
        };
      }),
      apiKeys: keyRows.map((k) => ({
        id: k.id,
        userId: k.user_id,
        groupId: k.group_id,
        keyHashHex: k.key_hash_hex,
        rpmLimit: k.rpm_limit,
        concurrencyLimit: k.concurrency_limit,
        ipAllowlist: jsonArray(k.ip_allowlist),
        ipDenylist: jsonArray(k.ip_denylist),
        enabled: k.enabled,
        expiresAtIso: k.expires_at ? toIso(k.expires_at) : null,
      })),
      wallets: walletRows.map((w) => ({
        userId: w.user_id,
        balanceNanoUsd: w.balance_nano_usd,
        heldNanoUsd: w.held_nano_usd,
      })),
      riskBans: banRows.map((b) => ({
        subjectKind: b.subject_kind,
        subjectHash: b.subject_hash,
        strikeLevel: Math.max(1, Math.min(3, b.strike_level)),
        bannedUntilUnixMs: b.expires_at ? b.expires_at.getTime() : -1,
      })),
    };
  }

  async recordTurnSettlement(ev: TurnSettlementEvent): Promise<TurnSettlementResult> {
    const costNano = BigInt(ev.costNanoUsd);
    // The server-minted settlement id, never the caller's X-Request-Id, decides "already charged".
    const settlementId = settlementIdOf(ev);
    const idemKey = `settle:${settlementId}`;
    const usageId = `usg_${crypto.randomUUID()}`;
    let walletBalanceAfterNanoUsd: string | undefined;

    const result = await this.sql.begin(async (txRaw): Promise<TurnSettlementResult> => {
      const tx = txRaw as unknown as SqlExecutor;
      // The primary key is the guarantee: a concurrent duplicate blocks on it until the first
      // delivery commits (then conflicts) or rolls back (then proceeds). One index probe, no scan.
      const claimed = await tx<{ settlement_id: string }[]>`
        INSERT INTO core.settlement_ids (settlement_id, usage_id, usage_created_at)
        VALUES (${settlementId}, ${usageId}, NOW())
        ON CONFLICT (settlement_id) DO NOTHING
        RETURNING settlement_id
      `;
      if (claimed.length === 0) {
        const prior = await tx<{ usage_id: string; usage_created_at: Date }[]>`
          SELECT usage_id, usage_created_at FROM core.settlement_ids WHERE settlement_id = ${settlementId}
        `;
        return {
          ...ev,
          settlementId,
          duplicate: true,
          id: prior[0]?.usage_id ?? usageId,
          formattedCostUsd: formatNanoUsd(costNano),
          createdAtIso: toIso(prior[0]?.usage_created_at),
        };
      }

      // Subscription-billed groups are paid for by the subscription: the cost still lands in
      // usage_logs (it drives the caps) but the wallet is left alone, as the data plane does.
      const groupRows = await tx<{ subscription_type: string }[]>`
        SELECT subscription_type FROM core.groups WHERE id = ${ev.groupId} LIMIT 1
      `;
      const billedToWallet = groupRows[0]?.subscription_type !== "subscription";

      await tx`
        UPDATE core.api_keys
           SET spent_nano_usd = spent_nano_usd + ${costNano.toString()}::numeric, last_used_at = NOW()
         WHERE id = ${ev.apiKeyId}
      `;

      if (costNano > 0n && billedToWallet) {
        const existingLedger = await tx<{ id: string }[]>`
          SELECT id FROM core.ledger_entries WHERE idempotency_key = ${idemKey} LIMIT 1
        `;
        if (existingLedger.length === 0) {
          await tx`
            INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
            VALUES (${ev.userId}, 0, 0)
            ON CONFLICT (user_id) DO NOTHING
          `;
          const updatedWallet = await tx<{ balance_nano_usd: string }[]>`
            UPDATE core.quota_wallets
            SET balance_nano_usd = balance_nano_usd - ${costNano.toString()}::numeric,
                spent_nano_usd = spent_nano_usd + ${costNano.toString()}::numeric,
                updated_at = NOW()
            WHERE user_id = ${ev.userId}
            RETURNING balance_nano_usd::text
          `;
          walletBalanceAfterNanoUsd = updatedWallet[0]!.balance_nano_usd;
          await tx`
            INSERT INTO core.ledger_entries (
              id, idempotency_key, user_id, entry_kind, delta_nano_usd,
              balance_after_nano, reference_id, metadata
            )
            VALUES (
              ${`ldg_${crypto.randomUUID()}`},
              ${idemKey},
              ${ev.userId},
              'settle',
              ${(-costNano).toString()}::numeric,
              ${updatedWallet[0]!.balance_nano_usd}::numeric,
              ${settlementId},
              ${this.sql.json({
                requestId: ev.requestId,
                accountId: ev.accountId,
                publicModel: ev.publicModel,
                upstreamModel: ev.upstreamModel,
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              })}
            )
          `;
        }
      }

      const inserted = await tx<{ created_at: Date }[]>`
        INSERT INTO core.usage_logs (
          id, request_id, user_id, api_key_id, account_id, group_id,
          platform, public_model, upstream_model, ingress_codec, egress_codec,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_nano_usd, ttft_ms, duration_ms, status_code,
          service_tier, reasoning_effort, image_count, video_seconds
        )
        VALUES (
          ${usageId},
          ${ev.requestId},
          ${ev.userId},
          ${ev.apiKeyId},
          ${ev.accountId},
          ${ev.groupId},
          ${ev.platform},
          ${ev.publicModel},
          ${ev.upstreamModel},
          ${ev.ingressCodec},
          ${ev.egressCodec},
          ${ev.inputTokens},
          ${ev.outputTokens},
          ${ev.cacheReadTokens},
          ${ev.cacheWriteTokens},
          ${costNano.toString()}::numeric,
          ${ev.ttftMs},
          ${ev.durationMs},
          ${ev.statusCode},
          ${ev.serviceTier ?? ""},
          ${ev.reasoningEffort ?? ""},
          ${ev.imageCount ?? 0},
          ${ev.videoSeconds ?? 0}
        )
        RETURNING created_at
      `;

      const totalTokens = ev.inputTokens + ev.outputTokens;
      const reset5hDate = ev.window5hResetAtUnixMs ? new Date(ev.window5hResetAtUnixMs) : null;
      const reset7dDate = ev.window7dResetAtUnixMs ? new Date(ev.window7dResetAtUnixMs) : null;
      // An account deleted while the turn was in flight must not fail the whole settlement (the
      // foreign key would roll back the charge, and every redelivery would fail the same way).
      await tx`
        INSERT INTO core.account_window_quotas (
          account_id, window_5h_used_bps, window_5h_reset_at, window_7d_used_bps, window_7d_reset_at,
          lifetime_tokens, lifetime_cost_nano_usd, last_used_at, updated_at
        )
        SELECT
          ${ev.accountId},
          ${ev.window5hUsedBps}::int,
          CASE
            WHEN ${reset5hDate}::timestamptz IS NOT NULL THEN ${reset5hDate}::timestamptz
            WHEN ${ev.window5hUsedBps}::int > 0 THEN NOW() + INTERVAL '5 hours'
            ELSE NULL
          END,
          ${ev.window7dUsedBps}::int,
          CASE
            WHEN ${reset7dDate}::timestamptz IS NOT NULL THEN ${reset7dDate}::timestamptz
            WHEN ${ev.window7dUsedBps}::int > 0 THEN NOW() + INTERVAL '7 days'
            ELSE NULL
          END,
          ${totalTokens}::bigint,
          ${costNano.toString()}::numeric,
          NOW(),
          NOW()
        WHERE EXISTS (SELECT 1 FROM core.accounts WHERE id = ${ev.accountId})
        ON CONFLICT (account_id) DO UPDATE SET
          window_5h_used_bps = CASE
            WHEN EXCLUDED.window_5h_used_bps > 0 THEN EXCLUDED.window_5h_used_bps
            WHEN core.account_window_quotas.window_5h_reset_at IS NOT NULL AND core.account_window_quotas.window_5h_reset_at <= NOW() THEN 0
            ELSE core.account_window_quotas.window_5h_used_bps
          END,
          window_5h_reset_at = CASE
            WHEN ${reset5hDate}::timestamptz IS NOT NULL THEN ${reset5hDate}::timestamptz
            WHEN EXCLUDED.window_5h_used_bps > 0 AND (core.account_window_quotas.window_5h_reset_at IS NULL OR core.account_window_quotas.window_5h_reset_at <= NOW())
              THEN NOW() + INTERVAL '5 hours'
            WHEN core.account_window_quotas.window_5h_reset_at IS NOT NULL AND core.account_window_quotas.window_5h_reset_at <= NOW() THEN NULL
            ELSE core.account_window_quotas.window_5h_reset_at
          END,
          window_7d_used_bps = CASE
            WHEN EXCLUDED.window_7d_used_bps > 0 THEN EXCLUDED.window_7d_used_bps
            WHEN core.account_window_quotas.window_7d_reset_at IS NOT NULL AND core.account_window_quotas.window_7d_reset_at <= NOW() THEN 0
            ELSE core.account_window_quotas.window_7d_used_bps
          END,
          window_7d_reset_at = CASE
            WHEN ${reset7dDate}::timestamptz IS NOT NULL THEN ${reset7dDate}::timestamptz
            WHEN EXCLUDED.window_7d_used_bps > 0 AND (core.account_window_quotas.window_7d_reset_at IS NULL OR core.account_window_quotas.window_7d_reset_at <= NOW())
              THEN NOW() + INTERVAL '7 days'
            WHEN core.account_window_quotas.window_7d_reset_at IS NOT NULL AND core.account_window_quotas.window_7d_reset_at <= NOW() THEN NULL
            ELSE core.account_window_quotas.window_7d_reset_at
          END,
          lifetime_tokens = core.account_window_quotas.lifetime_tokens + EXCLUDED.lifetime_tokens,
          lifetime_cost_nano_usd = core.account_window_quotas.lifetime_cost_nano_usd + EXCLUDED.lifetime_cost_nano_usd,
          last_used_at = NOW(),
          updated_at = NOW()
      `;

      return {
        ...ev,
        settlementId,
        duplicate: false,
        id: usageId,
        formattedCostUsd: formatNanoUsd(costNano),
        createdAtIso: toIso(inserted[0]?.created_at),
        ...(walletBalanceAfterNanoUsd !== undefined ? { walletBalanceAfterNanoUsd } : {}),
      };
    });
    this.maybePruneSettlementIds();
    return result;
  }

  /**
   * Keeps core.settlement_ids bounded, outside any settlement tx: one prune at a time, every five
   * minutes, each running until no expired id is left (or its time budget is spent, in which case
   * the next one starts after 30 s). So deletes keep pace with inserts at any settlement rate.
   */
  private maybePruneSettlementIds(): void {
    const now = Date.now();
    if (this.settlementPruneRunning || now < this.settlementPruneAt) return;
    this.settlementPruneRunning = true;
    this.settlementPruneAt = now + SETTLEMENT_PRUNE_INTERVAL_MS;
    void pruneSettlementIds(this.sql)
      .then(({ backlog }) => {
        if (backlog) this.settlementPruneAt = Date.now() + SETTLEMENT_PRUNE_BACKLOG_RETRY_MS;
      })
      .catch((err) => {
        console.warn(`[slipgate-bff] settlement id prune skipped: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.settlementPruneRunning = false;
      });
  }

  async listUsageLogs(filter?: UsageLogFilter): Promise<UsageLogItem[]> {
    const cap = filter?.sinceIso ? 100_000 : 200;
    const limit = Math.max(1, Math.min(cap, filter?.limit ?? 50));
    const since = filter?.sinceIso ? new Date(filter.sinceIso) : null;
    const rows = await this.sql<
      {
        id: string;
        request_id: string;
        user_id: string;
        api_key_id: string;
        account_id: string;
        group_id: string;
        platform: UsageLogItem["platform"];
        public_model: string;
        upstream_model: string;
        ingress_codec: string;
        egress_codec: string;
        input_tokens: string;
        output_tokens: string;
        cache_read_tokens: string;
        cache_write_tokens: string;
        cost_nano_usd: string;
        ttft_ms: number | null;
        duration_ms: number | null;
        status_code: number;
        created_at: Date;
      }[]
    >`
      SELECT
        id, request_id, user_id, api_key_id, account_id, group_id,
        platform, public_model, upstream_model, ingress_codec, egress_codec,
        input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text,
        cost_nano_usd::text, ttft_ms, duration_ms, status_code, created_at
      FROM core.usage_logs
      WHERE (${filter?.userId ?? null}::text IS NULL OR user_id = ${filter?.userId ?? null})
        AND (${filter?.accountId ?? null}::text IS NULL OR account_id = ${filter?.accountId ?? null})
        AND (${filter?.groupIds ?? null}::text[] IS NULL OR group_id = ANY(${filter?.groupIds ?? []}::text[]))
        AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => {
      const cost = BigInt(r.cost_nano_usd);
      return {
        id: r.id,
        requestId: r.request_id,
        userId: r.user_id,
        apiKeyId: r.api_key_id,
        accountId: r.account_id,
        groupId: r.group_id,
        platform: r.platform,
        publicModel: r.public_model,
        upstreamModel: r.upstream_model,
        ingressCodec: r.ingress_codec,
        egressCodec: r.egress_codec,
        inputTokens: Number.parseInt(r.input_tokens, 10),
        outputTokens: Number.parseInt(r.output_tokens, 10),
        cacheReadTokens: Number.parseInt(r.cache_read_tokens, 10),
        cacheWriteTokens: Number.parseInt(r.cache_write_tokens, 10),
        costNanoUsd: cost.toString(),
        formattedCostUsd: formatNanoUsd(cost),
        ttftMs: r.ttft_ms ?? 0,
        durationMs: r.duration_ms ?? 0,
        // Quota watermarks live on the account (core.account_window_quotas), not on each usage row.
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: r.status_code,
        createdAtIso: toIso(r.created_at),
      };
    });
  }

  async recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent> {
    const id = `rsk_${crypto.randomUUID()}`;
    const now = Date.now();
    let expiresAt: Date | null = null;
    if (ev.banDuration === "10m") {
      expiresAt = new Date(now + 10 * 60_000);
    } else if (ev.banDuration === "24h") {
      expiresAt = new Date(now + 24 * 3_600_000);
    }

    const rows = await this.sql<{ created_at: Date }[]>`
      INSERT INTO core.risk_ban_records (
        id, subject_kind, subject_hash, strike_level,
        ban_reason, source_request_id, expires_at
      )
      VALUES (
        ${id},
        ${ev.subjectKind},
        ${ev.subjectHash},
        ${ev.strikeLevel},
        ${ev.reason},
        ${ev.sourceRequestId ?? null},
        ${expiresAt}
      )
      RETURNING created_at
    `;
    return {
      eventId: id,
      subjectKind: ev.subjectKind,
      subjectHash: ev.subjectHash,
      strikeLevel: ev.strikeLevel,
      banDuration: ev.banDuration,
      reason: ev.reason,
      ordinaryUpstream400Count: ev.ordinaryUpstream400Count,
      downgradedCount: ev.downgradedCount,
      active: true,
      unbannedAtIso: null,
      createdAtIso: toIso(rows[0]?.created_at),
    };
  }

  async listRiskBanEvents(limit = 50): Promise<RiskBanEvent[]> {
    const capped = Math.max(1, Math.min(200, limit));
    const rows = await this.sql<
      {
        id: string;
        subject_kind: RiskBanEvent["subjectKind"];
        subject_hash: string;
        strike_level: number;
        ban_reason: string;
        expires_at: Date | null;
        unbanned_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, subject_kind, subject_hash, strike_level, ban_reason, expires_at, unbanned_at, created_at
      FROM core.risk_ban_records
      ORDER BY created_at DESC
      LIMIT ${capped}
    `;
    const nowMs = Date.now();
    return rows.map((r) => {
      let banDuration: RiskBanEvent["banDuration"] = "permanent";
      if (r.expires_at) {
        const diffMs = r.expires_at.getTime() - r.created_at.getTime();
        banDuration = diffMs > 3_600_000 ? "24h" : "10m";
      }
      const unbannedAtIso = r.unbanned_at ? toIso(r.unbanned_at) : null;
      const active = r.unbanned_at === null && (r.expires_at === null || r.expires_at.getTime() > nowMs);
      return {
        eventId: r.id,
        subjectKind: r.subject_kind,
        subjectHash: r.subject_hash,
        strikeLevel: r.strike_level,
        banDuration,
        reason: r.ban_reason,
        ordinaryUpstream400Count: 0,
        downgradedCount: 0,
        active,
        unbannedAtIso,
        createdAtIso: toIso(r.created_at),
      };
    });
  }

  async unbanRiskSubject(subjectKind: RiskBanEvent["subjectKind"], subjectHash: string): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE core.risk_ban_records
      SET unbanned_at = NOW()
      WHERE subject_kind = ${subjectKind}
        AND subject_hash = ${subjectHash}
        AND unbanned_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id
    `;
    return rows.length;
  }

  async clearRiskBansAndRefusalCache(): Promise<{ unbanned: number; refusalCacheCleared: number }> {
    const [banRows, cacheRows] = await Promise.all([
      this.sql<{ id: string }[]>`
        UPDATE core.risk_ban_records
        SET unbanned_at = NOW()
        WHERE unbanned_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id
      `,
      this.sql<{ request_fingerprint: string }[]>`
        DELETE FROM core.refusal_cache
        RETURNING request_fingerprint
      `,
    ]);
    return {
      unbanned: banRows.length,
      refusalCacheCleared: cacheRows.length,
    };
  }

  async listPricingRules(): Promise<ModelPricingRule[]> {
    const rows = await this.sql<
      {
        id: string;
        pattern: string;
        input: string;
        output: string;
        cache_read: string;
        cache_write: string;
        per_req: string;
        per_img: string;
        per_vid: string;
        lc_thresh: number;
        lc_in: string | null;
        lc_out: string | null;
        tier_fast: string | null;
        tier_flex: string | null;
        effort_json: unknown;
        enabled: boolean;
        notes: string;
        updated_at: Date;
      }[]
    >`
      SELECT id, pattern,
             input_nano_per_mtok::text AS input,
             output_nano_per_mtok::text AS output,
             cache_read_nano_per_mtok::text AS cache_read,
             cache_write_nano_per_mtok::text AS cache_write,
             per_request_nano_usd::text AS per_req,
             per_image_nano_usd::text AS per_img,
             per_video_second_nano_usd::text AS per_vid,
             long_context_threshold_tokens AS lc_thresh,
             long_context_input_multiplier::text AS lc_in,
             long_context_output_multiplier::text AS lc_out,
             service_tier_fast_multiplier::text AS tier_fast,
             service_tier_flex_multiplier::text AS tier_flex,
             reasoning_effort_multipliers AS effort_json,
             enabled, notes, updated_at
        FROM core.model_pricing_rules
       ORDER BY updated_at ASC, id ASC
    `;
    if (rows.length === 0) {
      // One-time transparent migration from legacy portal_settings.model_pricing JSON blob.
      const blob = await this.ops.getBlob("model_pricing");
      const legacy = Array.isArray(blob?.rules) ? blob.rules : [];
      const migrated = legacy.flatMap((r) => {
        const parsed = ModelPricingRuleSchema.safeParse(r);
        return parsed.success ? [parsed.data] : [];
      });
      if (migrated.length > 0) {
        await this.savePricingRules(migrated);
        return migrated;
      }
      return [];
    }
    return rows.flatMap((r) => {
      const effort = jsonColumn<Record<string, unknown>>(r.effort_json);
      const hasEffort = effort && typeof effort === "object" && Object.keys(effort).length > 0;
      const candidate: Record<string, unknown> = {
        id: r.id,
        pattern: r.pattern,
        inputNanoPerMTok: r.input,
        outputNanoPerMTok: r.output,
        cacheReadNanoPerMTok: r.cache_read,
        cacheWriteNanoPerMTok: r.cache_write,
        ...(r.per_req !== "0" ? { perRequestNanoUsd: r.per_req } : {}),
        ...(r.per_img !== "0" ? { perImageNanoUsd: r.per_img } : {}),
        ...(r.per_vid !== "0" ? { perVideoSecondNanoUsd: r.per_vid } : {}),
        ...(r.lc_thresh > 0 ? { longContextThresholdTokens: r.lc_thresh } : {}),
        ...(r.lc_in !== null ? { longContextInputMultiplier: Number(r.lc_in) } : {}),
        ...(r.lc_out !== null ? { longContextOutputMultiplier: Number(r.lc_out) } : {}),
        ...(r.tier_fast !== null ? { serviceTierFastMultiplier: Number(r.tier_fast) } : {}),
        ...(r.tier_flex !== null ? { serviceTierFlexMultiplier: Number(r.tier_flex) } : {}),
        ...(hasEffort ? { reasoningEffortMultipliers: effort } : {}),
        enabled: r.enabled,
        notes: r.notes,
        updatedAtIso: toIso(r.updated_at),
      };
      const parsed = ModelPricingRuleSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async savePricingRules(rules: ModelPricingRule[]): Promise<void> {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof this.sql;
      await tx`SELECT pg_advisory_xact_lock(727172804)`;
      const ids = rules.map((r) => r.id);
      if (ids.length === 0) {
        await tx`DELETE FROM core.model_pricing_rules`;
      } else {
        await tx`DELETE FROM core.model_pricing_rules WHERE NOT (id = ANY(${ids}::text[]))`;
      }
      for (const r of rules) {
        await tx`
          INSERT INTO core.model_pricing_rules (
            id, pattern, input_nano_per_mtok, output_nano_per_mtok,
            cache_read_nano_per_mtok, cache_write_nano_per_mtok,
            per_request_nano_usd, per_image_nano_usd, per_video_second_nano_usd,
            long_context_threshold_tokens, long_context_input_multiplier, long_context_output_multiplier,
            service_tier_fast_multiplier, service_tier_flex_multiplier, reasoning_effort_multipliers,
            enabled, notes, updated_at
          )
          VALUES (
            ${r.id}, ${r.pattern}, ${r.inputNanoPerMTok}::numeric, ${r.outputNanoPerMTok}::numeric,
            ${r.cacheReadNanoPerMTok}::numeric, ${r.cacheWriteNanoPerMTok}::numeric,
            ${(r.perRequestNanoUsd ?? "0")}::numeric, ${(r.perImageNanoUsd ?? "0")}::numeric, ${(r.perVideoSecondNanoUsd ?? "0")}::numeric,
            ${r.longContextThresholdTokens ?? 0},
            ${r.longContextInputMultiplier ?? null},
            ${r.longContextOutputMultiplier ?? null},
            ${r.serviceTierFastMultiplier ?? null},
            ${r.serviceTierFlexMultiplier ?? null},
            ${tx.json((r.reasoningEffortMultipliers ?? {}) as postgres.JSONValue)},
            ${r.enabled}, ${r.notes}, ${new Date(r.updatedAtIso)}
          )
          ON CONFLICT (pattern) DO UPDATE SET
            id = EXCLUDED.id,
            input_nano_per_mtok = EXCLUDED.input_nano_per_mtok,
            output_nano_per_mtok = EXCLUDED.output_nano_per_mtok,
            cache_read_nano_per_mtok = EXCLUDED.cache_read_nano_per_mtok,
            cache_write_nano_per_mtok = EXCLUDED.cache_write_nano_per_mtok,
            per_request_nano_usd = EXCLUDED.per_request_nano_usd,
            per_image_nano_usd = EXCLUDED.per_image_nano_usd,
            per_video_second_nano_usd = EXCLUDED.per_video_second_nano_usd,
            long_context_threshold_tokens = EXCLUDED.long_context_threshold_tokens,
            long_context_input_multiplier = EXCLUDED.long_context_input_multiplier,
            long_context_output_multiplier = EXCLUDED.long_context_output_multiplier,
            service_tier_fast_multiplier = EXCLUDED.service_tier_fast_multiplier,
            service_tier_flex_multiplier = EXCLUDED.service_tier_flex_multiplier,
            reasoning_effort_multipliers = EXCLUDED.reasoning_effort_multipliers,
            enabled = EXCLUDED.enabled,
            notes = EXCLUDED.notes,
            updated_at = EXCLUDED.updated_at
        `;
      }
    });
  }

  async upsertMediaTask(task: Omit<PersistedMediaTaskRecord, "createdAtIso">): Promise<PersistedMediaTaskRecord> {
    const pk = `${task.kind}:${task.id}`;
    const rows = await this.sql<{ created_at: Date }[]>`
      INSERT INTO core.media_tasks (
        id, upstream_task_id, user_id, api_key_id, account_id, group_id, platform, kind,
        public_model, upstream_model, status, result_json, expires_at, updated_at
      )
      VALUES (
        ${pk}, ${task.upstreamTaskId}, ${task.userId}, ${task.apiKeyId}, ${task.accountId},
        ${task.groupId}, ${task.platform}, ${task.kind}, ${task.publicModel}, ${task.upstreamModel},
        ${task.status}, ${this.sql.json(task.resultJson as postgres.JSONValue)}, ${new Date(task.expiresAtIso)}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        result_json = EXCLUDED.result_json,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      RETURNING created_at
    `;
    await this.sql`DELETE FROM core.media_tasks WHERE expires_at <= NOW()`.catch(() => undefined);
    return { ...task, createdAtIso: toIso(rows[0]?.created_at) };
  }

  async getMediaTask(
    apiKeyId: string,
    kind: PersistedMediaTaskRecord["kind"],
    id: string,
  ): Promise<PersistedMediaTaskRecord | null> {
    const pk = `${kind}:${id}`;
    const rows = await this.sql<
      {
        upstream_task_id: string;
        user_id: string;
        api_key_id: string;
        account_id: string;
        group_id: string;
        platform: string;
        public_model: string;
        upstream_model: string;
        status: string;
        result_json: unknown;
        expires_at: Date;
        created_at: Date;
      }[]
    >`
      SELECT upstream_task_id, user_id, api_key_id, account_id, group_id, platform,
             public_model, upstream_model, status, result_json, expires_at, created_at
        FROM core.media_tasks
       WHERE id = ${pk} AND api_key_id = ${apiKeyId} AND kind = ${kind} AND expires_at > NOW()
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    const decoded = jsonColumn<Record<string, unknown>>(r.result_json) ?? {};
    return {
      id,
      apiKeyId: r.api_key_id,
      userId: r.user_id,
      accountId: r.account_id,
      groupId: r.group_id,
      platform: r.platform,
      kind,
      upstreamTaskId: r.upstream_task_id,
      publicModel: r.public_model,
      upstreamModel: r.upstream_model,
      status: r.status,
      resultJson: decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {},
      expiresAtIso: toIso(r.expires_at),
      createdAtIso: toIso(r.created_at),
    };
  }

  async deleteMediaTask(
    apiKeyId: string,
    kind: PersistedMediaTaskRecord["kind"],
    id: string,
  ): Promise<boolean> {
    const pk = `${kind}:${id}`;
    const rows = await this.sql`
      DELETE FROM core.media_tasks
       WHERE id = ${pk} AND api_key_id = ${apiKeyId} AND kind = ${kind} AND expires_at > NOW()
      RETURNING id
    `;
    return rows.length > 0;
  }
}
