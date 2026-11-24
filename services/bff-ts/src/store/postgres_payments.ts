import postgres from "postgres";
import {
  DEFAULT_PAYMENT_CONFIG,
  PAID_ORDER_STATUSES,
  type AffiliateAccountItem,
  type AffiliateRebateItem,
  type AffiliateWithdrawalItem,
  type AffiliateWithdrawalStatus,
  type OrderListQuery,
  type PaymentCheckout,
  type PaymentCurrency,
  type PaymentDashboard,
  type PaymentOrderItem,
  type PaymentOrderStatus,
  type PaymentPlan,
} from "@slipgate/contracts";
import { reRedactStoredAuditBody } from "../insights.ts";
import {
  effectiveOrderStatus,
  proportion,
  REFUND_BALANCE_MESSAGE,
  REFUND_IN_PROGRESS_MESSAGE,
  REFUND_RESEND_AFTER_MS,
  REVENUE_ORDER_STATUSES,
} from "./memory_payments.ts";
import { clampPage, likePattern } from "./ops_shared.ts";
import {
  REFUNDABLE_STATUSES,
  type BeginRefundResult,
  type FulfillResult,
  type OrderInput,
  type OrderPaymentPatch,
  type PaymentsStore,
  type PlanInput,
  type RebatePolicy,
  type RefundInput,
} from "./payments_types.ts";
import { PostgresPaymentInstanceStore } from "./postgres_payment_providers.ts";
import { pgApplyWalletDelta, pgAssignSubscriptionTx } from "./postgres_ops.ts";
import { StoreError } from "./types.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Mirrors migrations/commerce/0006_payments_integrity.sql: what a paid order delivered (so a
 * refund can take it back), paid orders that could not be delivered, reversed rebates, a
 * one-off scrub of provider secrets (EasyPay `key`, SSH key PEMs) that the audit-log redaction
 * used to let through (scrubStoredAuditSecrets then applies the full current rules), and a
 * one-off reversal of the rebates on orders refunded before refunds reversed them.
 */
const PG_PAYMENTS_INTEGRITY_SQL = `
  ALTER TABLE commerce.payment_orders
      ADD COLUMN IF NOT EXISTS subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS delivery_error TEXT,
      ADD COLUMN IF NOT EXISTS prior_refund_amount_minor INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS applied_refund_ids TEXT[] NOT NULL DEFAULT '{}';
  ALTER TABLE commerce.affiliate_commissions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_commissions_order ON commerce.affiliate_commissions (source_order_id);
  DO $$
  BEGIN
      IF to_regclass('commerce.audit_logs') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM commerce.portal_settings WHERE key = 'audit_secret_scrub_v1') THEN
          UPDATE commerce.audit_logs
             SET request_body = regexp_replace(
                     regexp_replace(request_body, '"([A-Za-z0-9_-]*(?:[Kk]eys?|[Pp]em))":"(?:\\\\.|[^"\\\\])+("|$)', '"\\1":"[redacted]"', 'g'),
                     '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\\\.|[^"\\\\])*', '[redacted]', 'g')
           WHERE request_body ~ '"[A-Za-z0-9_-]*(?:[Kk]eys?|[Pp]em)":"' OR request_body LIKE '%PRIVATE KEY-----%';
          INSERT INTO commerce.portal_settings (key, value_json) VALUES ('audit_secret_scrub_v1', '{"done": true}'::jsonb)
          ON CONFLICT (key) DO NOTHING;
      END IF;
  END $$;
  DO $$
  DECLARE
      r RECORD;
      after_balance NUMERIC;
  BEGIN
      IF NOT EXISTS (SELECT 1 FROM commerce.portal_settings WHERE key = 'rebate_refund_backfill_v1') THEN
          FOR r IN
              SELECT c.id, c.beneficiary_id, c.source_order_id, c.amount_nano_usd
                FROM commerce.affiliate_commissions c
                JOIN commerce.payment_orders o ON o.id = c.source_order_id
               WHERE o.status = 'refunded' AND c.status <> 'reversed'
               ORDER BY c.created_at
                 FOR UPDATE OF c
          LOOP
              IF r.amount_nano_usd > 0
                 AND EXISTS (SELECT 1 FROM core.ledger_entries WHERE idempotency_key = 'rebate:' || r.source_order_id)
                 AND NOT EXISTS (SELECT 1 FROM core.ledger_entries WHERE idempotency_key = 'rebate-refund:' || r.source_order_id) THEN
                  INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
                  VALUES (r.beneficiary_id, 0, 0) ON CONFLICT (user_id) DO NOTHING;
                  UPDATE core.quota_wallets
                     SET balance_nano_usd = balance_nano_usd - r.amount_nano_usd, updated_at = NOW()
                   WHERE user_id = r.beneficiary_id
                  RETURNING balance_nano_usd INTO after_balance;
                  INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, metadata)
                  VALUES ('ldg_' || gen_random_uuid()::text, 'rebate-refund:' || r.source_order_id, r.beneficiary_id, 'adjust',
                          -r.amount_nano_usd, after_balance, jsonb_build_object('reason', 'rebate-refund:' || r.source_order_id));
              END IF;
              UPDATE commerce.affiliate_commissions SET status = 'reversed', reversed_at = NOW() WHERE id = r.id;
          END LOOP;
          INSERT INTO commerce.portal_settings (key, value_json) VALUES ('rebate_refund_backfill_v1', '{"done": true}'::jsonb)
          ON CONFLICT (key) DO NOTHING;
      END IF;
  END $$;
`;

const AUDIT_RESCRUB_MARKER = "audit_secret_scrub_v2";

async function markAuditScrubDone(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO commerce.portal_settings (key, value_json) VALUES (${AUDIT_RESCRUB_MARKER}, '{"done": true}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `;
}

/**
 * Startup half of scrubStoredAuditSecrets, awaited before the BFF listens (two small queries):
 * null once the pass has run, or when there is nothing to scrub (a fresh database, then marked
 * done); otherwise the pass, for the caller to run in the background.
 */
export async function pendingAuditSecretScrub(sql: Sql): Promise<(() => Promise<number>) | null> {
  try {
    if ((await sql`SELECT 1 FROM commerce.portal_settings WHERE key = ${AUDIT_RESCRUB_MARKER}`).length > 0) return null;
    if ((await sql`SELECT 1 FROM commerce.audit_logs LIMIT 1`).length === 0) {
      await markAuditScrubDone(sql);
      return null;
    }
    return () => scrubStoredAuditSecrets(sql);
  } catch (err) {
    console.warn(`[slipgate-bff] audit-log secret scrub skipped: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Runs the current audit-log redaction (reRedactStoredAuditBody) once over every stored row, so
 * rows written by older builds lose what the runtime now hides from new ones and the SQL scrub
 * above does not cover: credentials in URLs, bearer tokens, JWTs and API-key shapes in free text,
 * signature / mnemonic / totp / otp fields. Pages by id and rewrites only rows that change; a
 * portal_settings marker makes it a one-off. Idempotent, so concurrent starts are harmless.
 * Never throws (logged instead): the console works without it. Returns the rows rewritten.
 */
export async function scrubStoredAuditSecrets(sql: Sql, pageSize = 500): Promise<number> {
  try {
    const done = await sql`SELECT 1 FROM commerce.portal_settings WHERE key = ${AUDIT_RESCRUB_MARKER}`;
    if (done.length > 0) return 0;
    let after = "";
    let changed = 0;
    for (;;) {
      const rows = await sql<{ id: string; request_body: string }[]>`
        SELECT id, request_body FROM commerce.audit_logs WHERE id > ${after} ORDER BY id LIMIT ${pageSize}
      `;
      for (const row of rows) {
        const next = reRedactStoredAuditBody(row.request_body);
        if (next === row.request_body) continue;
        await sql`UPDATE commerce.audit_logs SET request_body = ${next} WHERE id = ${row.id}`;
        changed++;
      }
      if (rows.length < pageSize) break;
      after = rows[rows.length - 1]!.id;
    }
    await markAuditScrubDone(sql);
    return changed;
  } catch (err) {
    console.warn(`[slipgate-bff] audit-log secret scrub skipped: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

/** Idempotent DDL mirrored by migrations/commerce/0013_payment_settings.sql (Lane C2). */
export const PG_PAYMENT_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS commerce.payment_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      currency TEXT NOT NULL DEFAULT 'CNY',
      custom_amount_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      minor_per_usd INTEGER NOT NULL DEFAULT 720,
      min_amount_minor INTEGER NOT NULL DEFAULT 100,
      max_amount_minor INTEGER NOT NULL DEFAULT 1000000,
      order_timeout_minutes INTEGER NOT NULL DEFAULT 30,
      max_pending_orders INTEGER NOT NULL DEFAULT 5,
      callback_base_url TEXT NOT NULL DEFAULT '',
      load_balance_strategy TEXT NOT NULL DEFAULT 'round-robin',
      easypay_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      stripe_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      manual_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  DO $$
  DECLARE
      legacy JSONB;
  BEGIN
      IF NOT EXISTS (SELECT 1 FROM commerce.payment_settings WHERE id = 1)
         AND EXISTS (SELECT 1 FROM commerce.portal_settings WHERE key = 'payment_config') THEN
          SELECT value_json INTO legacy FROM commerce.portal_settings WHERE key = 'payment_config';
          IF jsonb_typeof(legacy) = 'string' THEN
              legacy := (legacy #>> '{}')::jsonb;
          END IF;
          IF jsonb_typeof(legacy) = 'object' THEN
              INSERT INTO commerce.payment_settings (
                  id, enabled, currency, custom_amount_enabled, minor_per_usd,
                  min_amount_minor, max_amount_minor, order_timeout_minutes, max_pending_orders,
                  callback_base_url, load_balance_strategy, easypay_json, stripe_json, manual_json, updated_at
              ) VALUES (
                  1,
                  COALESCE((legacy->>'enabled')::boolean, FALSE),
                  COALESCE(NULLIF(legacy->>'currency', ''), 'CNY'),
                  COALESCE((legacy->>'customAmountEnabled')::boolean, TRUE),
                  COALESCE((legacy->>'minorPerUsd')::integer, 720),
                  COALESCE((legacy->>'minAmountMinor')::integer, 100),
                  COALESCE((legacy->>'maxAmountMinor')::integer, 1000000),
                  COALESCE((legacy->>'orderTimeoutMinutes')::integer, 30),
                  COALESCE((legacy->>'maxPendingOrders')::integer, 5),
                  COALESCE(legacy->>'callbackBaseUrl', ''),
                  COALESCE(NULLIF(legacy->>'loadBalanceStrategy', ''), 'round-robin'),
                  COALESCE(legacy->'easypay', '{}'::jsonb),
                  COALESCE(legacy->'stripe', '{}'::jsonb),
                  COALESCE(legacy->'manual', '{}'::jsonb),
                  NOW()
              )
              ON CONFLICT (id) DO NOTHING;
          END IF;
      END IF;
  END $$;
`;

/** Idempotent DDL mirrored by migrations/commerce/0017_affiliate.sql (Lane C3). */
export const PG_AFFILIATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS commerce.affiliate_accounts (
      user_id TEXT PRIMARY KEY REFERENCES commerce.users(id) ON DELETE CASCADE,
      custom_rebate_bps INTEGER CHECK (custom_rebate_bps IS NULL OR (custom_rebate_bps >= 0 AND custom_rebate_bps <= 5000)),
      balance_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (balance_nano_usd >= 0),
      total_earned_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_earned_nano_usd >= 0),
      total_transferred_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_transferred_nano_usd >= 0),
      total_withdrawn_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_withdrawn_nano_usd >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS commerce.affiliate_withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('wallet_transfer', 'payout')),
      amount_nano_usd NUMERIC(39, 0) NOT NULL CHECK (amount_nano_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
      payout_method TEXT NOT NULL DEFAULT '',
      payout_account TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_withdrawals_user
      ON commerce.affiliate_withdrawals (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_withdrawals_status
      ON commerce.affiliate_withdrawals (status, created_at DESC);
  ALTER TABLE commerce.affiliate_commissions
      ADD COLUMN IF NOT EXISTS credited_to TEXT NOT NULL DEFAULT 'wallet';
`;

/** Idempotent DDL mirrored by migrations/commerce/0004_payments.sql and 0006 (runs at BFF startup). */
export const PG_PAYMENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS commerce.payment_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('recharge', 'subscription')),
      price_minor INTEGER NOT NULL CHECK (price_minor > 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      credit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      group_id TEXT,
      validity_days INTEGER,
      badge TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE commerce.payment_orders
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'recharge',
      ADD COLUMN IF NOT EXISTS plan_id TEXT,
      ADD COLUMN IF NOT EXISTS plan_name TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS method TEXT,
      ADD COLUMN IF NOT EXISTS amount_minor INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS group_id TEXT,
      ADD COLUMN IF NOT EXISTS validity_days INTEGER,
      ADD COLUMN IF NOT EXISTS pay_url TEXT,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
  DO $$
  BEGIN
      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'payment_orders_status_check'
             AND pg_get_constraintdef(oid) LIKE '%cancelled%'
      ) THEN
          ALTER TABLE commerce.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
          ALTER TABLE commerce.payment_orders ADD CONSTRAINT payment_orders_status_check
              CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'cancelled'));
      END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_orders_user ON commerce.payment_orders (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_orders_created ON commerce.payment_orders (created_at DESC);
  ALTER TABLE commerce.affiliate_commissions ADD COLUMN IF NOT EXISTS invitee_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_commissions_beneficiary
      ON commerce.affiliate_commissions (beneficiary_id, created_at DESC);
${PG_PAYMENTS_INTEGRITY_SQL}
${PG_PAYMENT_SETTINGS_SCHEMA_SQL}
${PG_AFFILIATE_SCHEMA_SQL}`;

function iso(v: Date | string | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function and(sql: Sql, parts: Fragment[]): Fragment {
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

interface PlanRow {
  id: string;
  name: string;
  description: string;
  kind: PaymentPlan["kind"];
  price_minor: number;
  currency: PaymentCurrency;
  credit: string;
  group_id: string | null;
  group_name: string | null;
  validity_days: number | null;
  badge: string;
  enabled: boolean;
  sort_order: number;
  created_at: Date;
}

interface OrderRow {
  id: string;
  user_id: string;
  user_email: string | null;
  kind: PaymentOrderItem["kind"];
  plan_id: string | null;
  plan_name: string;
  provider: PaymentOrderItem["provider"];
  method: string | null;
  status: PaymentOrderStatus;
  amount_minor: number;
  currency: PaymentCurrency;
  credit: string;
  group_id: string | null;
  group_name: string | null;
  validity_days: number | null;
  provider_trade_no: string | null;
  pay_url: string | null;
  delivery_error: string | null;
  created_at: Date;
  paid_at: Date | null;
  expires_at: Date | null;
  provider_instance_id: string | null;
  instance_name: string | null;
  qr_code: string | null;
  checkout_json: unknown;
  refund_amount_minor: number;
  refund_reason: string | null;
  refund_error: string | null;
  provider_refund_id: string | null;
  refund_reclaimed: string;
  refunded_at: Date | null;
  refund_requested_at: Date | null;
  refund_request_reason: string | null;
}

interface RefundOrderRow {
  user_id: string;
  kind: string;
  status: string;
  credit: string;
  amount_minor: number;
  group_id: string | null;
  validity_days: number | null;
  subscription_id: string | null;
  delivery_error: string | null;
  refund_amount_minor: number;
  prior_refund_amount_minor: number;
  refund_reclaim: boolean;
  refund_request_reason: string | null;
  applied_refund_ids: string[];
  updated_at: Date;
}

/** Spendable balance (balance minus holds, never below zero), with the wallet row locked. */
async function availableBalanceTx(tx: Sql, userId: string): Promise<bigint> {
  const rows = await tx<{ free: string }[]>`
    SELECT GREATEST(balance_nano_usd - held_nano_usd, 0)::text AS free FROM core.quota_wallets WHERE user_id = ${userId} FOR UPDATE
  `;
  return BigInt(rows[0]?.free ?? "0");
}

export class PostgresPaymentsStore implements PaymentsStore {
  readonly instances: PostgresPaymentInstanceStore;

  constructor(private readonly sql: Sql) {
    this.instances = new PostgresPaymentInstanceStore(sql);
  }

  async getConfigBlob() {
    const rows = await this.sql<{
      enabled: boolean;
      currency: string;
      custom_amount_enabled: boolean;
      minor_per_usd: number;
      min_amount_minor: number;
      max_amount_minor: number;
      order_timeout_minutes: number;
      max_pending_orders: number;
      callback_base_url: string;
      load_balance_strategy: string;
      easypay_json: unknown;
      stripe_json: unknown;
      manual_json: unknown;
    }[]>`
      SELECT enabled, currency, custom_amount_enabled, minor_per_usd,
             min_amount_minor, max_amount_minor, order_timeout_minutes, max_pending_orders,
             callback_base_url, load_balance_strategy, easypay_json, stripe_json, manual_json
        FROM commerce.payment_settings WHERE id = 1
    `;
    const r = rows[0];
    if (r) {
      const decodeObj = (v: unknown): Record<string, unknown> => {
        const parsed = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      };
      return {
        enabled: r.enabled,
        currency: r.currency,
        customAmountEnabled: r.custom_amount_enabled,
        minorPerUsd: r.minor_per_usd,
        minAmountMinor: r.min_amount_minor,
        maxAmountMinor: r.max_amount_minor,
        orderTimeoutMinutes: r.order_timeout_minutes,
        maxPendingOrders: r.max_pending_orders,
        callbackBaseUrl: r.callback_base_url,
        loadBalanceStrategy: r.load_balance_strategy,
        easypay: decodeObj(r.easypay_json),
        stripe: decodeObj(r.stripe_json),
        manual: decodeObj(r.manual_json),
      };
    }
    const legacy = await this.sql<{ value_json: unknown }[]>`
      SELECT value_json FROM commerce.portal_settings WHERE key = 'payment_config'
    `;
    const v = legacy[0]?.value_json;
    const decoded = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  }

  async saveConfigBlob(blob: Record<string, unknown>) {
    const enabled = Boolean(blob.enabled ?? DEFAULT_PAYMENT_CONFIG.enabled);
    const currency = typeof blob.currency === "string" && blob.currency ? blob.currency : DEFAULT_PAYMENT_CONFIG.currency;
    const customAmountEnabled = Boolean(blob.customAmountEnabled ?? DEFAULT_PAYMENT_CONFIG.customAmountEnabled);
    const minorPerUsd = Number(blob.minorPerUsd ?? DEFAULT_PAYMENT_CONFIG.minorPerUsd);
    const minAmountMinor = Number(blob.minAmountMinor ?? DEFAULT_PAYMENT_CONFIG.minAmountMinor);
    const maxAmountMinor = Number(blob.maxAmountMinor ?? DEFAULT_PAYMENT_CONFIG.maxAmountMinor);
    const orderTimeoutMinutes = Number(blob.orderTimeoutMinutes ?? DEFAULT_PAYMENT_CONFIG.orderTimeoutMinutes);
    const maxPendingOrders = Number(blob.maxPendingOrders ?? DEFAULT_PAYMENT_CONFIG.maxPendingOrders);
    const callbackBaseUrl = typeof blob.callbackBaseUrl === "string" ? blob.callbackBaseUrl : DEFAULT_PAYMENT_CONFIG.callbackBaseUrl;
    const loadBalanceStrategy =
      typeof blob.loadBalanceStrategy === "string" && blob.loadBalanceStrategy
        ? blob.loadBalanceStrategy
        : DEFAULT_PAYMENT_CONFIG.loadBalanceStrategy;
    const easypayJson = (blob.easypay ?? DEFAULT_PAYMENT_CONFIG.easypay) as postgres.JSONValue;
    const stripeJson = (blob.stripe ?? DEFAULT_PAYMENT_CONFIG.stripe) as postgres.JSONValue;
    const manualJson = (blob.manual ?? DEFAULT_PAYMENT_CONFIG.manual) as postgres.JSONValue;

    await this.sql`
      INSERT INTO commerce.payment_settings (
        id, enabled, currency, custom_amount_enabled, minor_per_usd,
        min_amount_minor, max_amount_minor, order_timeout_minutes, max_pending_orders,
        callback_base_url, load_balance_strategy, easypay_json, stripe_json, manual_json, updated_at
      )
      VALUES (
        1, ${enabled}, ${currency}, ${customAmountEnabled}, ${minorPerUsd},
        ${minAmountMinor}, ${maxAmountMinor}, ${orderTimeoutMinutes}, ${maxPendingOrders},
        ${callbackBaseUrl}, ${loadBalanceStrategy}, ${this.sql.json(easypayJson)}, ${this.sql.json(stripeJson)},
        ${this.sql.json(manualJson)}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        currency = EXCLUDED.currency,
        custom_amount_enabled = EXCLUDED.custom_amount_enabled,
        minor_per_usd = EXCLUDED.minor_per_usd,
        min_amount_minor = EXCLUDED.min_amount_minor,
        max_amount_minor = EXCLUDED.max_amount_minor,
        order_timeout_minutes = EXCLUDED.order_timeout_minutes,
        max_pending_orders = EXCLUDED.max_pending_orders,
        callback_base_url = EXCLUDED.callback_base_url,
        load_balance_strategy = EXCLUDED.load_balance_strategy,
        easypay_json = EXCLUDED.easypay_json,
        stripe_json = EXCLUDED.stripe_json,
        manual_json = EXCLUDED.manual_json,
        updated_at = NOW()
    `;
  }

  /* ---------------- Plans ---------------- */

  private planSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT p.id, p.name, p.description, p.kind, p.price_minor, p.currency, p.credit_nano_usd::text AS credit,
             p.group_id, g.name AS group_name, p.validity_days, p.badge, p.enabled, p.sort_order, p.created_at
        FROM commerce.payment_plans p LEFT JOIN core.groups g ON g.id = p.group_id
       WHERE ${where}
    `;
  }

  private toPlan(r: PlanRow): PaymentPlan {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      priceMinor: r.price_minor,
      currency: r.currency,
      creditNanoUsd: r.credit,
      groupId: r.group_id,
      groupName: r.group_name,
      validityDays: r.validity_days,
      badge: r.badge,
      enabled: r.enabled,
      sortOrder: r.sort_order,
      createdAtIso: iso(r.created_at),
    };
  }

  async listPlans(includeDisabled: boolean) {
    const purchasable = this.sql`p.enabled AND (p.kind <> 'subscription' OR g.subscription_type = 'subscription')`;
    const rows = await this.sql<PlanRow[]>`
      ${this.planSelect(includeDisabled ? this.sql`TRUE` : purchasable)} ORDER BY p.sort_order, p.price_minor
    `;
    return rows.map((r) => this.toPlan(r));
  }

  async getPlan(id: string) {
    const rows = await this.sql<PlanRow[]>`${this.planSelect(this.sql`p.id = ${id}`)}`;
    return rows[0] ? this.toPlan(rows[0]) : null;
  }

  /**
   * Why a subscription to this group cannot be granted now (same wording as the memory store),
   * or null. With `lock` the group row is held (FOR SHARE) until the transaction ends, so it
   * cannot be deleted or switched to balance billing between this check and the grant.
   */
  private async subscriptionGroupProblem(db: Sql, groupId: string | null, lock = false): Promise<string | null> {
    const rows = lock
      ? await db<{ subscription_type: string; name: string }[]>`
          SELECT subscription_type, name FROM core.groups WHERE id = ${groupId ?? ""} FOR SHARE
        `
      : await db<{ subscription_type: string; name: string }[]>`
          SELECT subscription_type, name FROM core.groups WHERE id = ${groupId ?? ""}
        `;
    const g = rows[0];
    if (!g) return `Group ${groupId ?? ""} not found`;
    if (g.subscription_type !== "subscription") return `Group ${g.name} is not subscription-billed`;
    return null;
  }

  private async checkPlanGroup(input: PlanInput) {
    if (input.kind !== "subscription") return;
    const g = await this.sql<{ subscription_type: string }[]>`SELECT subscription_type FROM core.groups WHERE id = ${input.groupId ?? ""}`;
    if (!g[0]) throw new StoreError("not_found", "Group not found");
    if (g[0].subscription_type !== "subscription") throw new StoreError("bad_request", "That group is not subscription-billed");
  }

  async createPlan(input: PlanInput) {
    await this.checkPlanGroup(input);
    const id = `plan_${crypto.randomUUID()}`;
    await this.sql`
      INSERT INTO commerce.payment_plans (id, name, description, kind, price_minor, currency, credit_nano_usd, group_id,
                                          validity_days, badge, enabled, sort_order)
      VALUES (${id}, ${input.name}, ${input.description}, ${input.kind}, ${input.priceMinor}, ${input.currency},
              ${input.creditNano.toString()}::numeric, ${input.groupId}, ${input.validityDays}, ${input.badge},
              ${input.enabled}, ${input.sortOrder})
    `;
    return (await this.getPlan(id))!;
  }

  async updatePlan(id: string, input: PlanInput) {
    await this.checkPlanGroup(input);
    const rows = await this.sql`
      UPDATE commerce.payment_plans
         SET name = ${input.name}, description = ${input.description}, kind = ${input.kind}, price_minor = ${input.priceMinor},
             currency = ${input.currency}, credit_nano_usd = ${input.creditNano.toString()}::numeric, group_id = ${input.groupId},
             validity_days = ${input.validityDays}, badge = ${input.badge}, enabled = ${input.enabled},
             sort_order = ${input.sortOrder}, updated_at = NOW()
       WHERE id = ${id} RETURNING id
    `;
    if (rows.length === 0) throw new StoreError("not_found", "Plan not found");
    return (await this.getPlan(id))!;
  }

  async deletePlan(id: string) {
    const rows = await this.sql`DELETE FROM commerce.payment_plans WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw new StoreError("not_found", "Plan not found");
  }

  /* ---------------- Orders ---------------- */

  private orderSelect(where: Fragment): Fragment {
    return this.sql`
      SELECT o.id, o.user_id, u.email AS user_email, o.kind, o.plan_id, o.plan_name, o.provider, o.method, o.status,
             o.amount_minor, o.currency, o.amount_nano_usd::text AS credit, o.group_id, g.name AS group_name,
             o.validity_days, o.provider_trade_no, o.pay_url, o.delivery_error, o.created_at, o.paid_at, o.expires_at,
             o.provider_instance_id, pi.name AS instance_name, o.qr_code, o.checkout_json, o.refund_amount_minor,
             o.refund_reason, o.refund_error, o.provider_refund_id, o.refund_reclaimed_nano_usd::text AS refund_reclaimed,
             o.refunded_at, o.refund_requested_at, o.refund_request_reason
        FROM commerce.payment_orders o
        LEFT JOIN commerce.users u ON u.id = o.user_id
        LEFT JOIN core.groups g ON g.id = o.group_id
        LEFT JOIN commerce.payment_provider_instances pi ON pi.id = o.provider_instance_id
       WHERE ${where}
    `;
  }

  private toOrder(r: OrderRow, nowMs = Date.now()): PaymentOrderItem {
    const expiresAtIso = iso(r.expires_at ?? r.created_at);
    const status = effectiveOrderStatus(r.status, expiresAtIso, nowMs);
    const checkout = typeof r.checkout_json === "string" ? (JSON.parse(r.checkout_json) as unknown) : r.checkout_json;
    return {
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email ?? "",
      kind: r.kind,
      planId: r.plan_id,
      planName: r.plan_name,
      provider: r.provider,
      method: r.method,
      status,
      amountMinor: r.amount_minor,
      currency: r.currency,
      creditNanoUsd: r.credit,
      groupId: r.group_id,
      groupName: r.group_name,
      validityDays: r.validity_days,
      providerTradeNo: r.provider_trade_no,
      payUrl: r.pay_url,
      providerInstanceId: r.provider_instance_id,
      providerInstanceName: r.instance_name,
      qrCode: r.qr_code,
      // Only an order that can still be paid needs its checkout data.
      checkout: status === "pending" && checkout && typeof checkout === "object" ? (checkout as PaymentCheckout) : null,
      deliveryError: r.delivery_error,
      createdAtIso: iso(r.created_at),
      paidAtIso: r.paid_at ? iso(r.paid_at) : null,
      expiresAtIso,
      refundAmountMinor: r.refund_amount_minor,
      refundReason: r.refund_reason,
      refundError: r.refund_error,
      providerRefundId: r.provider_refund_id,
      refundReclaimedNanoUsd: r.refund_reclaimed,
      refundedAtIso: r.refunded_at ? iso(r.refunded_at) : null,
      refundRequestedAtIso: r.refund_requested_at ? iso(r.refund_requested_at) : null,
      refundRequestReason: r.refund_request_reason,
      canRequestRefund: false,
    };
  }

  async createOrder(input: OrderInput) {
    const id = `ord_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      // Serialise order creation per user so maxPendingOrders cannot be pierced concurrently.
      await tx`SELECT pg_advisory_xact_lock(74210051, hashtext(${input.userId}::text))`;
      if (input.maxPendingOrders !== undefined && input.maxPendingOrders > 0) {
        const pending = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM commerce.payment_orders
           WHERE user_id = ${input.userId} AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())
        `;
        if ((pending[0]?.n ?? 0) >= input.maxPendingOrders) {
          throw new StoreError("conflict", "Too many unpaid orders; pay or cancel one first");
        }
      }
      if (
        input.merchantDailyLimitMinor !== undefined &&
        input.merchantDailyLimitMinor > 0 &&
        input.merchantUsageKey &&
        input.dayStartIso
      ) {
        await tx`SELECT pg_advisory_xact_lock(74210052, hashtext(${input.merchantUsageKey}::text))`;
        const [mKey, chType] = input.merchantUsageKey.split("|");
        const statuses = [...REVENUE_ORDER_STATUSES];
        const usedRows = await tx<{ total: string }[]>`
          SELECT COALESCE(SUM(amount_minor), 0)::text AS total
            FROM commerce.payment_orders
           WHERE created_at >= ${new Date(input.dayStartIso)}
             AND COALESCE(provider_instance_id, 'builtin:' || provider) = ${mKey ?? ""}
             AND COALESCE(method, provider) = ${chType ?? ""}
             AND (status = ANY(${statuses}::text[]) OR (status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())))
        `;
        const used = Number(usedRows[0]?.total ?? "0");
        if (used + input.amountMinor > input.merchantDailyLimitMinor) {
          throw new StoreError("conflict", "This payment method has reached its limit for this amount; try another method or amount");
        }
      }
      if (input.kind === "subscription" && (await this.subscriptionGroupProblem(tx, input.groupId, true))) {
        throw new StoreError("conflict", "This plan cannot be purchased right now");
      }
      try {
        await tx`
          INSERT INTO commerce.payment_orders (id, user_id, provider, amount_nano_usd, currency, status, idempotency_key,
                                               kind, plan_id, plan_name, method, amount_minor, group_id, validity_days, expires_at,
                                               provider_instance_id)
          VALUES (${id}, ${input.userId}, ${input.provider}, ${input.creditNano.toString()}::numeric, ${input.currency}, 'pending',
                  ${`order:${id}`}, ${input.kind}, ${input.planId}, ${input.planName}, ${input.method}, ${input.amountMinor},
                  ${input.groupId}, ${input.validityDays}, ${new Date(input.expiresAtIso)}, ${input.providerInstanceId ?? null})
        `;
      } catch (err) {
        if ((err as { code?: string })?.code === "23503") throw new StoreError("not_found", "User not found");
        throw err;
      }
    });
    return (await this.getOrder(id))!;
  }

  async setOrderPayment(id: string, patch: OrderPaymentPatch) {
    const checkout = patch.checkout ? this.sql.json(patch.checkout as unknown as postgres.JSONValue) : null;
    await this.sql`
      UPDATE commerce.payment_orders
         SET pay_url = ${patch.payUrl}, qr_code = ${patch.qrCode}, checkout_json = ${checkout},
             provider_trade_no = COALESCE(${patch.providerTradeNo}, provider_trade_no), updated_at = NOW()
       WHERE id = ${id}
    `;
  }

  async getOrder(id: string) {
    const rows = await this.sql<OrderRow[]>`${this.orderSelect(this.sql`o.id = ${id}`)}`;
    return rows[0] ? this.toOrder(rows[0]) : null;
  }

  async listOrders(query: OrderListQuery) {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (query.status === "expired") parts.push(sql`(o.status = 'expired' OR (o.status = 'pending' AND o.expires_at <= NOW()))`);
    else if (query.status === "pending") parts.push(sql`o.status = 'pending' AND (o.expires_at IS NULL OR o.expires_at > NOW())`);
    else if (query.status) parts.push(sql`o.status = ${query.status}`);
    if (query.provider) parts.push(sql`o.provider = ${query.provider}`);
    if (query.userId) parts.push(sql`o.user_id = ${query.userId}`);
    if (query.search) {
      const p = likePattern(query.search);
      parts.push(sql`(o.id ILIKE ${p} OR u.email ILIKE ${p} OR o.plan_name ILIKE ${p} OR o.provider_trade_no ILIKE ${p})`);
    }
    const where = and(sql, parts);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const [rows, totals] = await Promise.all([
      sql<OrderRow[]>`${this.orderSelect(where)} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM commerce.payment_orders o LEFT JOIN commerce.users u ON u.id = o.user_id WHERE ${where}
      `,
    ]);
    const now = Date.now();
    return { items: rows.map((r) => this.toOrder(r, now)), total: totals[0]?.n ?? 0 };
  }

  async countPendingOrders(userId: string) {
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM commerce.payment_orders
       WHERE user_id = ${userId} AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())
    `;
    return rows[0]?.n ?? 0;
  }

  async fulfillOrder(id: string, providerTradeNo: string | null, rebate: RebatePolicy): Promise<FulfillResult> {
    const outcome = await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<
        {
          user_id: string;
          kind: string;
          status: string;
          credit: string;
          group_id: string | null;
          validity_days: number | null;
          delivery_error: string | null;
        }[]
      >`
        SELECT user_id, kind, status, amount_nano_usd::text AS credit, group_id, validity_days, delivery_error
          FROM commerce.payment_orders WHERE id = ${id} FOR UPDATE
      `;
      const o = rows[0];
      if (!o) throw new StoreError("not_found", "Order not found");
      // Pending, expired, cancelled or failed: money arrived, so deliver what was paid for.
      const firstPayment = !(PAID_ORDER_STATUSES as readonly string[]).includes(o.status);
      const retry = o.status === "paid" && o.delivery_error !== null;
      if (!firstPayment && !retry) return { fulfilled: false, delivered: false };
      const credit = BigInt(o.credit);
      let delivered = false;
      if (o.kind === "subscription") {
        // The group may have been deleted or switched to balance billing since the order was
        // placed. The payment is still accepted (refusing it would only make the provider retry
        // forever) and the order is flagged for the admin to redeliver or refund.
        const problem = await this.subscriptionGroupProblem(tx, o.group_id, true);
        if (problem) {
          await tx`UPDATE commerce.payment_orders SET delivery_error = ${problem}, updated_at = NOW() WHERE id = ${id}`;
        } else {
          const subscriptionId = await pgAssignSubscriptionTx(tx, o.user_id, o.group_id!, o.validity_days ?? 30, "", `order:${id}`);
          await tx`
            UPDATE commerce.payment_orders SET subscription_id = ${subscriptionId}, delivery_error = NULL, updated_at = NOW()
             WHERE id = ${id}
          `;
          delivered = true;
        }
      } else {
        if (credit > 0n) await pgApplyWalletDelta(tx, o.user_id, credit, `order:${id}`, "credit", `order:${id}`);
        delivered = true;
      }
      if (!firstPayment) return { fulfilled: false, delivered };
      await tx`
        UPDATE commerce.payment_orders
           SET status = 'paid', paid_at = NOW(), provider_trade_no = COALESCE(${providerTradeNo}, provider_trade_no), updated_at = NOW()
         WHERE id = ${id}
      `;
      if (rebate.enabled && o.kind === "recharge" && credit > 0n) {
        const ref = await tx<{ referrer_id: string | null }[]>`SELECT referrer_id FROM commerce.users WHERE id = ${o.user_id}`;
        const referrerId = ref[0]?.referrer_id;
        if (referrerId) {
          const affRows = await tx<{ custom_rebate_bps: number | null }[]>`
            SELECT custom_rebate_bps FROM commerce.affiliate_accounts WHERE user_id = ${referrerId} FOR UPDATE
          `;
          const effectiveBps = affRows[0]?.custom_rebate_bps ?? rebate.bps;
          const amount = effectiveBps > 0 ? (credit * BigInt(effectiveBps)) / 10_000n : 0n;
          if (amount > 0n) {
            const creditMode = rebate.creditMode === "commission_pool" ? "commission_pool" : "wallet";
            const amtText = amount.toString();
            if (creditMode === "commission_pool") {
              const existing = await tx`SELECT 1 FROM commerce.affiliate_commissions WHERE source_order_id = ${id} LIMIT 1`;
              const refExists = await tx`SELECT 1 FROM commerce.users WHERE id = ${referrerId}`;
              if (existing.length === 0 && refExists.length > 0) {
                await tx`
                  INSERT INTO commerce.affiliate_accounts (user_id, balance_nano_usd, total_earned_nano_usd, updated_at)
                  VALUES (${referrerId}, ${amtText}::numeric, ${amtText}::numeric, NOW())
                  ON CONFLICT (user_id) DO UPDATE
                     SET balance_nano_usd = commerce.affiliate_accounts.balance_nano_usd + EXCLUDED.balance_nano_usd,
                         total_earned_nano_usd = commerce.affiliate_accounts.total_earned_nano_usd + EXCLUDED.total_earned_nano_usd,
                         updated_at = NOW()
                `;
                await tx`
                  INSERT INTO commerce.affiliate_commissions (id, beneficiary_id, source_order_id, amount_nano_usd, status, invitee_id, credited_to)
                  VALUES (${`cms_${crypto.randomUUID()}`}, ${referrerId}, ${id}, ${amtText}::numeric, 'settled', ${o.user_id}, 'commission_pool')
                `;
              }
            } else if (await pgApplyWalletDelta(tx, referrerId, amount, `rebate:${id}`, "credit", `rebate:${id}`)) {
              await tx`
                INSERT INTO commerce.affiliate_accounts (user_id, total_earned_nano_usd, updated_at)
                VALUES (${referrerId}, ${amtText}::numeric, NOW())
                ON CONFLICT (user_id) DO UPDATE
                   SET total_earned_nano_usd = commerce.affiliate_accounts.total_earned_nano_usd + EXCLUDED.total_earned_nano_usd,
                       updated_at = NOW()
              `;
              await tx`
                INSERT INTO commerce.affiliate_commissions (id, beneficiary_id, source_order_id, amount_nano_usd, status, invitee_id, credited_to)
                VALUES (${`cms_${crypto.randomUUID()}`}, ${referrerId}, ${id}, ${amtText}::numeric, 'settled', ${o.user_id}, 'wallet')
              `;
            }
          }
        }
      }
      return { fulfilled: true, delivered };
    });
    return { order: (await this.getOrder(id))!, ...outcome };
  }

  async cancelOrder(id: string, userId?: string) {
    const rows = await this.sql<{ id: string; status: string; user_id: string }[]>`
      SELECT id, status, user_id FROM commerce.payment_orders WHERE id = ${id}
    `;
    const o = rows[0];
    if (!o || (userId && o.user_id !== userId)) throw new StoreError("not_found", "Order not found");
    const updated = await this.sql`
      UPDATE commerce.payment_orders SET status = 'cancelled', updated_at = NOW() WHERE id = ${id} AND status = 'pending' RETURNING id
    `;
    if (updated.length === 0) throw new StoreError("conflict", "Only pending orders can be cancelled");
    return (await this.getOrder(id))!;
  }

  /* ---------------- Refunds ---------------- */

  /** The order row locked for a refund step (not_found when missing). */
  private async lockRefundRow(tx: Sql, id: string): Promise<RefundOrderRow> {
    const rows = await tx<RefundOrderRow[]>`
      SELECT user_id, kind, status, amount_nano_usd::text AS credit, amount_minor, group_id, validity_days, subscription_id,
             delivery_error, refund_amount_minor, prior_refund_amount_minor, refund_reclaim, refund_request_reason,
             applied_refund_ids, updated_at
        FROM commerce.payment_orders WHERE id = ${id} FOR UPDATE
    `;
    if (!rows[0]) throw new StoreError("not_found", "Order not found");
    return rows[0];
  }

  async refundOrder(id: string, reclaim: boolean) {
    const o = await this.getOrder(id);
    if (!o) throw new StoreError("not_found", "Order not found");
    if (o.status !== "paid" && o.status !== "partially_refunded" && o.status !== "refund_requested") {
      throw new StoreError("conflict", "Only paid orders can be refunded");
    }
    const already = o.status === "partially_refunded" ? o.refundAmountMinor : 0;
    await this.beginRefund(id, { amountMinor: o.amountMinor - already, reason: o.refundRequestReason ?? "", reclaim, force: true });
    return this.completeRefund(id, null);
  }

  async instanceUsage(sinceIso: string) {
    const statuses = [...REVENUE_ORDER_STATUSES];
    const rows = await this.sql<{ k: string; t: string; total: string }[]>`
      SELECT COALESCE(provider_instance_id, 'builtin:' || provider) AS k, COALESCE(method, provider) AS t,
             SUM(amount_minor)::text AS total
        FROM commerce.payment_orders
       WHERE created_at >= ${new Date(sinceIso)}
         AND (status = ANY(${statuses}::text[]) OR (status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())))
       GROUP BY 1, 2
    `;
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.k}|${r.t}`] = Number(r.total);
    return out;
  }

  async requestRefund(id: string, userId: string, reason: string) {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const o = await this.lockRefundRow(tx, id).catch(() => null);
      if (!o || o.user_id !== userId) throw new StoreError("not_found", "Order not found");
      if (o.status !== "paid") throw new StoreError("conflict", "Only paid orders can be refunded");
      if (o.kind !== "recharge") throw new StoreError("bad_request", "Only balance top-ups can be refunded on request");
      if ((await availableBalanceTx(tx, o.user_id)) < BigInt(o.credit)) throw new StoreError("conflict", REFUND_BALANCE_MESSAGE);
      await tx`
        UPDATE commerce.payment_orders
           SET status = 'refund_requested', refund_requested_at = NOW(), refund_request_reason = ${reason},
               refund_error = NULL, updated_at = NOW()
         WHERE id = ${id}
      `;
    });
    return (await this.getOrder(id))!;
  }

  async rejectRefund(id: string) {
    const rows = await this.sql`
      UPDATE commerce.payment_orders
         SET status = CASE WHEN prior_refund_amount_minor > 0 THEN 'partially_refunded' ELSE 'paid' END,
             refund_amount_minor = prior_refund_amount_minor,
             refund_reason = NULL, refund_error = NULL, provider_refund_id = NULL,
             refund_reclaim = FALSE, refund_force = FALSE, updated_at = NOW()
       WHERE id = ${id} AND status IN ('refund_requested', 'refund_failed')
      RETURNING id
    `;
    if (rows.length === 0) {
      if (!(await this.getOrder(id))) throw new StoreError("not_found", "Order not found");
      throw new StoreError("conflict", "Only requested or failed refunds can be rejected");
    }
    return (await this.getOrder(id))!;
  }

  async beginRefund(id: string, input: RefundInput): Promise<BeginRefundResult> {
    const outcome = await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const o = await this.lockRefundRow(tx, id);
      if (!(REFUNDABLE_STATUSES as readonly string[]).includes(o.status)) {
        throw new StoreError("conflict", "Only paid orders can be refunded");
      }
      // Re-sending a pending refund is for stuck ones only, never a double click.
      if (o.status === "refund_pending" && Date.now() - new Date(o.updated_at).getTime() < REFUND_RESEND_AFTER_MS) {
        throw new StoreError("conflict", REFUND_IN_PROGRESS_MESSAGE);
      }
      const priorMinor =
        o.status === "partially_refunded"
          ? o.refund_amount_minor
          : o.status === "refund_failed" || o.status === "refund_pending"
            ? o.prior_refund_amount_minor
            : 0;
      const remainingMinor = o.amount_minor - priorMinor;
      if (!Number.isInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > remainingMinor) {
        throw new StoreError("bad_request", "Refund amount must be between 0.01 and the remaining refundable amount");
      }
      if (input.reclaim && o.kind === "recharge" && !input.force) {
        const reclaimNano = proportion(BigInt(o.credit), input.amountMinor, o.amount_minor);
        const balanceNano = await availableBalanceTx(tx, o.user_id);
        if (balanceNano < reclaimNano) return { requiresForce: { balanceNano, reclaimNano } };
      }
      const reason = input.reason || o.refund_request_reason || null;
      await tx`
        UPDATE commerce.payment_orders
           SET status = 'refund_pending', prior_refund_amount_minor = ${priorMinor}, refund_amount_minor = ${input.amountMinor},
               refund_reason = ${reason}, refund_reclaim = ${input.reclaim}, refund_force = ${input.force},
               refund_error = NULL, provider_refund_id = NULL, updated_at = NOW()
         WHERE id = ${id}
      `;
      return null;
    });
    if (outcome) return outcome;
    return { order: (await this.getOrder(id))! };
  }

  async noteRefundPending(id: string, providerRefundId: string | null, error: string | null) {
    const rows = await this.sql`
      UPDATE commerce.payment_orders
         SET provider_refund_id = COALESCE(${providerRefundId}, provider_refund_id), refund_error = ${error}, updated_at = NOW()
       WHERE id = ${id} AND status = 'refund_pending'
      RETURNING id
    `;
    if (rows.length === 0) {
      if (!(await this.getOrder(id))) throw new StoreError("not_found", "Order not found");
      throw new StoreError("conflict", "The refund is no longer pending");
    }
    return (await this.getOrder(id))!;
  }

  async completeRefund(id: string, providerRefundId: string | null) {
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const o = await this.lockRefundRow(tx, id);
      if (o.status !== "refund_pending") {
        if (providerRefundId && o.applied_refund_ids.includes(providerRefundId)) return;
        throw new StoreError("conflict", "The refund is no longer pending");
      }
      const part = o.refund_amount_minor;
      const priorMinor = o.prior_refund_amount_minor;
      const totalRefundedMinor = priorMinor + part;
      const remainingBeforePart = Math.max(1, o.amount_minor - priorMinor);
      const ledgerSuffix = priorMinor > 0 ? `:${totalRefundedMinor}` : "";
      const credit = BigInt(o.credit);
      let reclaimed = 0n;
      if (o.refund_reclaim && o.kind === "recharge" && credit > 0n) {
        // The money already went back: take the share of the credit that is still there.
        const want = proportion(credit, part, o.amount_minor);
        const free = await availableBalanceTx(tx, o.user_id);
        const take = want < free ? want : free;
        if (take > 0n && (await pgApplyWalletDelta(tx, o.user_id, -take, `refund:${id}${ledgerSuffix}`, "adjust", `refund:${id}${ledgerSuffix}`))) {
          reclaimed = take;
        }
      }
      // A subscription order with a delivery error never granted anything.
      if (o.refund_reclaim && o.kind === "subscription" && o.delivery_error === null) {
        const days = Number(proportion(BigInt(o.validity_days ?? 30), part, o.amount_minor));
        if (days > 0) await this.reclaimSubscriptionTx(tx, id, o, days);
      }
      // The referrer's rebate was earned on money that is going back: always reverse that share.
      // One rebate per order (fulfilment credits wallet under rebate:<order> or commission pool).
      const rebate = await tx<{ id: string; beneficiary_id: string; amount: string; credited_to: string }[]>`
        SELECT id, beneficiary_id, amount_nano_usd::text AS amount, COALESCE(credited_to, 'wallet') AS credited_to
          FROM commerce.affiliate_commissions
         WHERE source_order_id = ${id} AND status <> 'reversed'
         ORDER BY created_at LIMIT 1 FOR UPDATE
      `;
      if (rebate[0]) {
        const r = rebate[0];
        const whole = BigInt(r.amount);
        const back = proportion(whole, part, remainingBeforePart);
        if (back > 0n) {
          if (r.credited_to === "commission_pool") {
            const poolRows = await tx<{ balance: string }[]>`
              SELECT balance_nano_usd::text AS balance FROM commerce.affiliate_accounts
               WHERE user_id = ${r.beneficiary_id} FOR UPDATE
            `;
            const poolBal = BigInt(poolRows[0]?.balance ?? "0");
            const fromPool = poolBal > back ? back : poolBal;
            if (fromPool > 0n) {
              await tx`
                UPDATE commerce.affiliate_accounts
                   SET balance_nano_usd = balance_nano_usd - ${fromPool.toString()}::numeric, updated_at = NOW()
                 WHERE user_id = ${r.beneficiary_id}
              `;
            }
            const remainder = back - fromPool;
            if (remainder > 0n) {
              await pgApplyWalletDelta(
                tx,
                r.beneficiary_id,
                -remainder,
                `rebate-refund:${id}${ledgerSuffix}`,
                "adjust",
                `rebate-refund:${id}${ledgerSuffix}`,
              );
            }
          } else {
            await pgApplyWalletDelta(
              tx,
              r.beneficiary_id,
              -back,
              `rebate-refund:${id}${ledgerSuffix}`,
              "adjust",
              `rebate-refund:${id}${ledgerSuffix}`,
            );
          }
        }
        if (back >= whole) await tx`UPDATE commerce.affiliate_commissions SET status = 'reversed', reversed_at = NOW() WHERE id = ${r.id}`;
        else await tx`UPDATE commerce.affiliate_commissions SET amount_nano_usd = ${(whole - back).toString()}::numeric WHERE id = ${r.id}`;
      }
      const status = totalRefundedMinor >= o.amount_minor ? "refunded" : "partially_refunded";
      await tx`
        UPDATE commerce.payment_orders
           SET status = ${status},
               refund_amount_minor = ${totalRefundedMinor},
               prior_refund_amount_minor = ${totalRefundedMinor},
               refunded_at = NOW(),
               refund_reclaimed_nano_usd = refund_reclaimed_nano_usd + ${reclaimed.toString()}::numeric,
               refund_error = NULL,
               provider_refund_id = COALESCE(${providerRefundId}, provider_refund_id),
               applied_refund_ids = CASE
                 WHEN ${providerRefundId}::text IS NULL OR ${providerRefundId}::text = ANY(applied_refund_ids) THEN applied_refund_ids
                 ELSE array_append(applied_refund_ids, ${providerRefundId}::text)
               END,
               updated_at = NOW()
         WHERE id = ${id}
      `;
    });
    return (await this.getOrder(id))!;
  }

  async getRefundLedger(id: string) {
    const rows = await this.sql<{ status: string; refund_amount_minor: number; prior_refund_amount_minor: number; applied_refund_ids: string[] }[]>`
      SELECT status, refund_amount_minor, prior_refund_amount_minor, applied_refund_ids FROM commerce.payment_orders WHERE id = ${id}
    `;
    const o = rows[0];
    if (!o) return null;
    const committedMinor = o.status === "refunded" || o.status === "partially_refunded" ? o.refund_amount_minor : o.prior_refund_amount_minor;
    return { committedMinor, appliedRefundIds: o.applied_refund_ids ?? [] };
  }

  async failRefund(id: string, error: string) {
    const rows = await this.sql`
      UPDATE commerce.payment_orders SET status = 'refund_failed', refund_error = ${error.slice(0, 500)}, updated_at = NOW()
       WHERE id = ${id} AND status = 'refund_pending'
      RETURNING id
    `;
    if (rows.length === 0) {
      if (!(await this.getOrder(id))) throw new StoreError("not_found", "Order not found");
      throw new StoreError("conflict", "The refund is no longer pending");
    }
    return (await this.getOrder(id))!;
  }

  async listDueOrders(kind: "expired" | "refund_pending", limit: number) {
    const n = Math.max(1, Math.min(500, limit));
    const rows =
      kind === "expired"
        ? await this.sql<OrderRow[]>`
            ${this.orderSelect(this.sql`o.status = 'pending' AND o.expires_at <= NOW()`)} ORDER BY o.expires_at LIMIT ${n}
          `
        : await this.sql<OrderRow[]>`
            ${this.orderSelect(this.sql`o.status = 'refund_pending' AND o.updated_at <= NOW() - INTERVAL '1 minute'`)}
            ORDER BY o.updated_at LIMIT ${n}
          `;
    const now = Date.now();
    return rows.map((r) => this.toOrder(r, now));
  }

  async markOrderExpired(id: string) {
    const rows = await this.sql`
      UPDATE commerce.payment_orders SET status = 'expired', updated_at = NOW()
       WHERE id = ${id} AND status = 'pending' AND expires_at <= NOW()
      RETURNING id
    `;
    return rows.length > 0;
  }

  /**
   * Takes `days` back from the subscription the order created or extended: shortened when time
   * would remain, revoked when those days are all that is left. Nothing to do once it has run
   * out or an admin deleted it.
   */
  private async reclaimSubscriptionTx(tx: Sql, orderId: string, o: RefundOrderRow, reclaimDays: number) {
    let subscriptionId = o.subscription_id;
    if (!subscriptionId) {
      // Paid before subscription_id was recorded: the grant either created a subscription tagged
      // with the order or extended the newest active one of the pair (pgAssignSubscriptionTx).
      const found = await tx<{ id: string }[]>`
        SELECT id FROM commerce.subscriptions
         WHERE user_id = ${o.user_id} AND group_id = ${o.group_id ?? ""}
         ORDER BY (source = ${`order:${orderId}`}) DESC, (status = 'active') DESC, expires_at DESC
         LIMIT 1
      `;
      subscriptionId = found[0]?.id ?? null;
    }
    if (!subscriptionId) return;
    const days = `${reclaimDays} days`;
    await tx`
      UPDATE commerce.subscriptions
         SET status = CASE WHEN expires_at - ${days}::interval > NOW() THEN status ELSE 'revoked' END,
             expires_at = CASE WHEN expires_at - ${days}::interval > NOW() THEN expires_at - ${days}::interval ELSE expires_at END,
             updated_at = NOW()
       WHERE id = ${subscriptionId} AND expires_at > NOW()
    `;
  }

  /* ---------------- Dashboard & rebates ---------------- */

  async dashboard(days: number, currency: PaymentCurrency): Promise<PaymentDashboard> {
    const since = new Date(Date.now() - days * 86_400_000);
    const sql = this.sql;
    // Paid orders not fully refunded count as revenue, minus what a partial refund sent back.
    const earning = [...REVENUE_ORDER_STATUSES];
    const kept = sql`(amount_minor - CASE WHEN status = 'partially_refunded' THEN refund_amount_minor ELSE 0 END)`;
    const [totals, series, providers, plans, rebates] = await Promise.all([
      sql<{ created: number; paid: number; pending: number; refunded: number; revenue: string; credited: string; payers: number }[]>`
        SELECT COUNT(*)::int AS created,
               COUNT(*) FILTER (WHERE status = ANY(${earning}::text[]))::int AS paid,
               COUNT(*) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > NOW()))::int AS pending,
               COUNT(*) FILTER (WHERE status IN ('refunded', 'partially_refunded'))::int AS refunded,
               COALESCE(SUM(${kept}) FILTER (WHERE status = ANY(${earning}::text[])), 0)::text AS revenue,
               COALESCE(SUM(amount_nano_usd) FILTER (WHERE status = ANY(${earning}::text[])), 0)::text AS credited,
               COUNT(DISTINCT user_id) FILTER (WHERE status = ANY(${earning}::text[]))::int AS payers
          FROM commerce.payment_orders WHERE created_at >= ${since} AND currency = ${currency}
      `,
      sql<{ day: Date; orders: number; revenue: string }[]>`
        SELECT date_trunc('day', COALESCE(paid_at, created_at), 'UTC') AS day, COUNT(*)::int AS orders,
               COALESCE(SUM(${kept}), 0)::text AS revenue
          FROM commerce.payment_orders
         WHERE status = ANY(${earning}::text[]) AND created_at >= ${since} AND currency = ${currency}
         GROUP BY 1
      `,
      // Rank by the numeric sum (the selected revenue is text), ties by name like the memory store.
      sql<{ provider: string; orders: number; revenue: string }[]>`
        SELECT provider, COUNT(*)::int AS orders, COALESCE(SUM(${kept}), 0)::text AS revenue
          FROM commerce.payment_orders WHERE status = ANY(${earning}::text[]) AND created_at >= ${since} AND currency = ${currency}
         GROUP BY provider ORDER BY COALESCE(SUM(${kept}), 0) DESC, provider COLLATE "C"
      `,
      sql<{ plan_name: string; orders: number; revenue: string }[]>`
        SELECT plan_name, COUNT(*)::int AS orders, COALESCE(SUM(${kept}), 0)::text AS revenue
          FROM commerce.payment_orders WHERE status = ANY(${earning}::text[]) AND created_at >= ${since} AND currency = ${currency}
         GROUP BY plan_name ORDER BY COALESCE(SUM(${kept}), 0) DESC, plan_name COLLATE "C" LIMIT 8
      `,
      sql<{ total: string }[]>`
        SELECT COALESCE(SUM(c.amount_nano_usd), 0)::text AS total
          FROM commerce.affiliate_commissions c
          JOIN commerce.payment_orders o ON o.id = c.source_order_id
         WHERE c.created_at >= ${since} AND c.status <> 'reversed' AND o.currency = ${currency}
      `,
    ]);
    const DAY = 86_400_000;
    const firstDay = Math.floor(since.getTime() / DAY) * DAY + DAY;
    const points = Array.from({ length: days }, (_, i) => ({ dateIso: new Date(firstDay + i * DAY).toISOString(), orders: 0, revenueMinor: 0 }));
    for (const row of series) {
      const idx = Math.round((row.day.getTime() - firstDay) / DAY);
      const p = points[idx];
      if (p) {
        p.orders = row.orders;
        p.revenueMinor = Number(row.revenue);
      }
    }
    const t = totals[0]!;
    return {
      generatedAtIso: new Date().toISOString(),
      days,
      currency,
      totals: {
        paidOrders: t.paid,
        revenueMinor: Number(t.revenue),
        pendingOrders: t.pending,
        refundedOrders: t.refunded,
        creditedNanoUsd: t.credited,
        payingUsers: t.payers,
        conversionRate: t.created ? t.paid / t.created : 0,
        rebatesNanoUsd: rebates[0]?.total ?? "0",
      },
      series: points,
      byProvider: providers.map((p) => ({ provider: p.provider, orders: p.orders, revenueMinor: Number(p.revenue) })),
      topPlans: plans.map((p) => ({ planName: p.plan_name, orders: p.orders, revenueMinor: Number(p.revenue) })),
    };
  }

  async listRebates(beneficiaryId: string | null, limit: number): Promise<AffiliateRebateItem[]> {
    const rows = await this.sql<
      {
        id: string;
        beneficiary_id: string;
        b_email: string | null;
        i_email: string | null;
        source_order_id: string;
        amount: string;
        credited_to: string;
        created_at: Date;
      }[]
    >`
      SELECT c.id, c.beneficiary_id, b.email AS b_email, i.email AS i_email, c.source_order_id,
             c.amount_nano_usd::text AS amount, COALESCE(c.credited_to, 'wallet') AS credited_to, c.created_at
        FROM commerce.affiliate_commissions c
        LEFT JOIN commerce.users b ON b.id = c.beneficiary_id
        LEFT JOIN commerce.users i ON i.id = c.invitee_id
       WHERE c.status <> 'reversed' AND (${beneficiaryId}::text IS NULL OR c.beneficiary_id = ${beneficiaryId})
       ORDER BY c.created_at DESC
       LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    return rows.map((r) => ({
      id: r.id,
      beneficiaryId: r.beneficiary_id,
      beneficiaryEmail: r.b_email ?? "",
      inviteeEmail: r.i_email ?? "",
      orderId: r.source_order_id,
      amountNanoUsd: r.amount,
      creditedTo: r.credited_to === "commission_pool" ? "commission_pool" : "wallet",
      createdAtIso: iso(r.created_at),
    }));
  }

  async rebateTotal(beneficiaryId: string) {
    const rows = await this.sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount_nano_usd), 0)::text AS total FROM commerce.affiliate_commissions
       WHERE beneficiary_id = ${beneficiaryId} AND status <> 'reversed'
    `;
    return BigInt(rows[0]?.total ?? "0");
  }

  /* ---------------- Affiliate accounts, rates & withdrawals (Lane C3) ---------------- */

  private toAffiliateAccount(
    r: {
      user_id: string;
      email: string;
      username: string;
      custom_rebate_bps: number | null;
      balance_nano_usd: string | null;
      total_earned_nano_usd: string | null;
      legacy_earned_nano_usd: string | null;
      total_transferred_nano_usd: string | null;
      total_withdrawn_nano_usd: string | null;
      invitee_count: number;
      updated_at: Date | null;
    },
    defaultBps: number,
  ): AffiliateAccountItem {
    const earned = BigInt(r.total_earned_nano_usd ?? "0");
    const legacy = BigInt(r.legacy_earned_nano_usd ?? "0");
    const totalEarned = earned > legacy ? earned : legacy;
    return {
      userId: r.user_id,
      email: r.email,
      username: r.username ?? "",
      customRebateBps: r.custom_rebate_bps,
      effectiveRebateBps: r.custom_rebate_bps ?? defaultBps,
      balanceNanoUsd: r.balance_nano_usd ?? "0",
      totalEarnedNanoUsd: totalEarned.toString(),
      totalTransferredNanoUsd: r.total_transferred_nano_usd ?? "0",
      totalWithdrawnNanoUsd: r.total_withdrawn_nano_usd ?? "0",
      inviteeCount: r.invitee_count ?? 0,
      updatedAtIso: iso(r.updated_at),
    };
  }

  private toAffiliateWithdrawal(r: {
    id: string;
    user_id: string;
    user_email: string | null;
    kind: AffiliateWithdrawalItem["kind"];
    amount_nano_usd: string;
    status: AffiliateWithdrawalStatus;
    payout_method: string;
    payout_account: string;
    notes: string;
    review_note: string;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    created_at: Date;
  }): AffiliateWithdrawalItem {
    return {
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email ?? "",
      kind: r.kind,
      amountNanoUsd: r.amount_nano_usd,
      status: r.status,
      payoutMethod: r.payout_method,
      payoutAccount: r.payout_account,
      notes: r.notes,
      reviewNote: r.review_note,
      reviewedBy: r.reviewed_by,
      reviewedAtIso: r.reviewed_at ? iso(r.reviewed_at) : null,
      createdAtIso: iso(r.created_at),
    };
  }

  async getAffiliateAccount(userId: string, defaultBps: number): Promise<AffiliateAccountItem> {
    const rows = await this.sql<
      {
        user_id: string;
        email: string;
        username: string;
        custom_rebate_bps: number | null;
        balance_nano_usd: string | null;
        total_earned_nano_usd: string | null;
        legacy_earned_nano_usd: string | null;
        total_transferred_nano_usd: string | null;
        total_withdrawn_nano_usd: string | null;
        invitee_count: number;
        updated_at: Date | null;
      }[]
    >`
      SELECT u.id AS user_id, u.email, u.username, a.custom_rebate_bps,
             a.balance_nano_usd::text, a.total_earned_nano_usd::text,
             (SELECT COALESCE(SUM(c.amount_nano_usd), 0)::text
                FROM commerce.affiliate_commissions c
               WHERE c.beneficiary_id = u.id AND c.status <> 'reversed') AS legacy_earned_nano_usd,
             a.total_transferred_nano_usd::text, a.total_withdrawn_nano_usd::text,
             (SELECT COUNT(*)::int FROM commerce.users inv WHERE inv.referrer_id = u.id) AS invitee_count,
             COALESCE(a.updated_at, u.updated_at) AS updated_at
        FROM commerce.users u
        LEFT JOIN commerce.affiliate_accounts a ON a.user_id = u.id
       WHERE u.id = ${userId}
    `;
    if (!rows[0]) throw new StoreError("not_found", `User ${userId} not found`);
    return this.toAffiliateAccount(rows[0], defaultBps);
  }

  async listAffiliateAccounts(defaultBps: number, search?: string): Promise<AffiliateAccountItem[]> {
    const q = search?.trim();
    const where = q
      ? this.sql`(u.email ILIKE ${likePattern(q)} OR u.username ILIKE ${likePattern(q)} OR u.id ILIKE ${likePattern(q)})`
      : this.sql`TRUE`;
    const rows = await this.sql<
      {
        user_id: string;
        email: string;
        username: string;
        custom_rebate_bps: number | null;
        balance_nano_usd: string | null;
        total_earned_nano_usd: string | null;
        legacy_earned_nano_usd: string | null;
        total_transferred_nano_usd: string | null;
        total_withdrawn_nano_usd: string | null;
        invitee_count: number;
        updated_at: Date | null;
      }[]
    >`
      SELECT u.id AS user_id, u.email, u.username, a.custom_rebate_bps,
             a.balance_nano_usd::text, a.total_earned_nano_usd::text,
             (SELECT COALESCE(SUM(c.amount_nano_usd), 0)::text
                FROM commerce.affiliate_commissions c
               WHERE c.beneficiary_id = u.id AND c.status <> 'reversed') AS legacy_earned_nano_usd,
             a.total_transferred_nano_usd::text, a.total_withdrawn_nano_usd::text,
             (SELECT COUNT(*)::int FROM commerce.users inv WHERE inv.referrer_id = u.id) AS invitee_count,
             COALESCE(a.updated_at, u.updated_at) AS updated_at
        FROM commerce.users u
        LEFT JOIN commerce.affiliate_accounts a ON a.user_id = u.id
       WHERE ${where}
       ORDER BY COALESCE(a.balance_nano_usd, 0) DESC,
                COALESCE(a.total_earned_nano_usd, 0) DESC,
                u.created_at DESC
       LIMIT 200
    `;
    return rows.map((r) => this.toAffiliateAccount(r, defaultBps));
  }

  async setAffiliateCustomRate(
    userId: string,
    customRebateBps: number | null,
    defaultBps: number,
  ): Promise<AffiliateAccountItem> {
    const exists = await this.sql`SELECT 1 FROM commerce.users WHERE id = ${userId}`;
    if (exists.length === 0) throw new StoreError("not_found", `User ${userId} not found`);
    await this.sql`
      INSERT INTO commerce.affiliate_accounts (user_id, custom_rebate_bps, updated_at)
      VALUES (${userId}, ${customRebateBps}, NOW())
      ON CONFLICT (user_id) DO UPDATE
         SET custom_rebate_bps = EXCLUDED.custom_rebate_bps, updated_at = NOW()
    `;
    return this.getAffiliateAccount(userId, defaultBps);
  }

  async transferAffiliateToWallet(
    userId: string,
    amountNano: bigint,
  ): Promise<{ withdrawal: AffiliateWithdrawalItem; affiliateBalanceNanoUsd: string; walletBalanceNanoUsd: string }> {
    if (amountNano <= 0n) throw new StoreError("bad_request", "Transfer amount must be positive");
    const amtText = amountNano.toString();
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const u = await tx<{ email: string }[]>`SELECT email FROM commerce.users WHERE id = ${userId}`;
      if (!u[0]) throw new StoreError("not_found", `User ${userId} not found`);
      const acc = await tx<{ balance: string }[]>`
        SELECT balance_nano_usd::text AS balance FROM commerce.affiliate_accounts WHERE user_id = ${userId} FOR UPDATE
      `;
      if (!acc[0] || BigInt(acc[0].balance) < amountNano) {
        throw new StoreError("bad_request", "Insufficient commission balance");
      }
      const updatedAff = await tx<{ balance: string }[]>`
        UPDATE commerce.affiliate_accounts
           SET balance_nano_usd = balance_nano_usd - ${amtText}::numeric,
               total_transferred_nano_usd = total_transferred_nano_usd + ${amtText}::numeric,
               updated_at = NOW()
         WHERE user_id = ${userId}
        RETURNING balance_nano_usd::text AS balance
      `;
      const id = `affw_${crypto.randomUUID()}`;
      await pgApplyWalletDelta(tx, userId, amountNano, `aff-transfer:${id}`, "credit", `aff-transfer:${id}`);
      const wRows = await tx<{ balance: string }[]>`
        SELECT balance_nano_usd::text AS balance FROM core.quota_wallets WHERE user_id = ${userId}
      `;
      const inserted = await tx<{
        id: string;
        user_id: string;
        kind: AffiliateWithdrawalItem["kind"];
        amount_nano_usd: string;
        status: AffiliateWithdrawalStatus;
        payout_method: string;
        payout_account: string;
        notes: string;
        review_note: string;
        reviewed_by: string | null;
        reviewed_at: Date | null;
        created_at: Date;
      }[]>`
        INSERT INTO commerce.affiliate_withdrawals (
          id, user_id, kind, amount_nano_usd, status, payout_method, payout_account, notes, reviewed_at
        )
        VALUES (${id}, ${userId}, 'wallet_transfer', ${amtText}::numeric, 'paid', 'wallet', '', '', NOW())
        RETURNING id, user_id, kind, amount_nano_usd::text, status, payout_method, payout_account, notes,
                  review_note, reviewed_by, reviewed_at, created_at
      `;
      return {
        withdrawal: this.toAffiliateWithdrawal({ ...inserted[0]!, user_email: u[0].email }),
        affiliateBalanceNanoUsd: updatedAff[0]!.balance,
        walletBalanceNanoUsd: wRows[0]?.balance ?? "0",
      };
    });
  }

  async requestAffiliateWithdrawal(
    userId: string,
    amountNano: bigint,
    payoutMethod: string,
    payoutAccount: string,
    notes: string,
  ): Promise<AffiliateWithdrawalItem> {
    if (amountNano <= 0n) throw new StoreError("bad_request", "Withdrawal amount must be positive");
    const amtText = amountNano.toString();
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const u = await tx<{ email: string }[]>`SELECT email FROM commerce.users WHERE id = ${userId}`;
      if (!u[0]) throw new StoreError("not_found", `User ${userId} not found`);
      const acc = await tx<{ balance: string }[]>`
        SELECT balance_nano_usd::text AS balance FROM commerce.affiliate_accounts WHERE user_id = ${userId} FOR UPDATE
      `;
      if (!acc[0] || BigInt(acc[0].balance) < amountNano) {
        throw new StoreError("bad_request", "Insufficient commission balance");
      }
      await tx`
        UPDATE commerce.affiliate_accounts
           SET balance_nano_usd = balance_nano_usd - ${amtText}::numeric, updated_at = NOW()
         WHERE user_id = ${userId}
      `;
      const id = `affw_${crypto.randomUUID()}`;
      const inserted = await tx<{
        id: string;
        user_id: string;
        kind: AffiliateWithdrawalItem["kind"];
        amount_nano_usd: string;
        status: AffiliateWithdrawalStatus;
        payout_method: string;
        payout_account: string;
        notes: string;
        review_note: string;
        reviewed_by: string | null;
        reviewed_at: Date | null;
        created_at: Date;
      }[]>`
        INSERT INTO commerce.affiliate_withdrawals (
          id, user_id, kind, amount_nano_usd, status, payout_method, payout_account, notes
        )
        VALUES (${id}, ${userId}, 'payout', ${amtText}::numeric, 'pending', ${payoutMethod}, ${payoutAccount}, ${notes})
        RETURNING id, user_id, kind, amount_nano_usd::text, status, payout_method, payout_account, notes,
                  review_note, reviewed_by, reviewed_at, created_at
      `;
      return this.toAffiliateWithdrawal({ ...inserted[0]!, user_email: u[0].email });
    });
  }

  async listAffiliateWithdrawals(filter: {
    userId?: string;
    status?: AffiliateWithdrawalStatus;
    limit?: number;
  }): Promise<AffiliateWithdrawalItem[]> {
    const parts: Fragment[] = [];
    if (filter.userId) parts.push(this.sql`w.user_id = ${filter.userId}`);
    if (filter.status) parts.push(this.sql`w.status = ${filter.status}`);
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const rows = await this.sql<{
      id: string;
      user_id: string;
      user_email: string | null;
      kind: AffiliateWithdrawalItem["kind"];
      amount_nano_usd: string;
      status: AffiliateWithdrawalStatus;
      payout_method: string;
      payout_account: string;
      notes: string;
      review_note: string;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      created_at: Date;
    }[]>`
      SELECT w.id, w.user_id, u.email AS user_email, w.kind, w.amount_nano_usd::text, w.status,
             w.payout_method, w.payout_account, w.notes, w.review_note, w.reviewed_by, w.reviewed_at, w.created_at
        FROM commerce.affiliate_withdrawals w
        LEFT JOIN commerce.users u ON u.id = w.user_id
       WHERE ${and(this.sql, parts)}
       ORDER BY w.created_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => this.toAffiliateWithdrawal(r));
  }

  async reviewAffiliateWithdrawal(
    id: string,
    action: "approve" | "mark_paid" | "reject",
    reviewerId: string,
    reviewNote: string,
  ): Promise<AffiliateWithdrawalItem> {
    return this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = await tx<{
        id: string;
        user_id: string;
        user_email: string | null;
        kind: AffiliateWithdrawalItem["kind"];
        amount_nano_usd: string;
        status: AffiliateWithdrawalStatus;
        payout_method: string;
        payout_account: string;
        notes: string;
        review_note: string;
        reviewed_by: string | null;
        reviewed_at: Date | null;
        created_at: Date;
      }[]>`
        SELECT w.id, w.user_id, u.email AS user_email, w.kind, w.amount_nano_usd::text, w.status,
               w.payout_method, w.payout_account, w.notes, w.review_note, w.reviewed_by, w.reviewed_at, w.created_at
          FROM commerce.affiliate_withdrawals w
          LEFT JOIN commerce.users u ON u.id = w.user_id
         WHERE w.id = ${id}
         FOR UPDATE OF w
      `;
      const row = rows[0];
      if (!row) throw new StoreError("not_found", "Withdrawal request not found");
      if (row.kind !== "payout") throw new StoreError("bad_request", "Wallet transfers cannot be reviewed");

      let nextStatus: AffiliateWithdrawalStatus;
      if (action === "approve") {
        if (row.status !== "pending") throw new StoreError("conflict", `Withdrawal is already ${row.status}`);
        nextStatus = "approved";
      } else if (action === "mark_paid") {
        if (row.status !== "pending" && row.status !== "approved") {
          throw new StoreError("conflict", `Withdrawal is already ${row.status}`);
        }
        nextStatus = "paid";
        await tx`
          INSERT INTO commerce.affiliate_accounts (user_id, total_withdrawn_nano_usd, updated_at)
          VALUES (${row.user_id}, ${row.amount_nano_usd}::numeric, NOW())
          ON CONFLICT (user_id) DO UPDATE
             SET total_withdrawn_nano_usd = commerce.affiliate_accounts.total_withdrawn_nano_usd + EXCLUDED.total_withdrawn_nano_usd,
                 updated_at = NOW()
        `;
      } else {
        if (row.status !== "pending" && row.status !== "approved") {
          throw new StoreError("conflict", `Withdrawal is already ${row.status}`);
        }
        nextStatus = "rejected";
        await tx`
          INSERT INTO commerce.affiliate_accounts (user_id, balance_nano_usd, updated_at)
          VALUES (${row.user_id}, ${row.amount_nano_usd}::numeric, NOW())
          ON CONFLICT (user_id) DO UPDATE
             SET balance_nano_usd = commerce.affiliate_accounts.balance_nano_usd + EXCLUDED.balance_nano_usd,
                 updated_at = NOW()
        `;
      }

      const updated = await tx<{
        review_note: string;
        reviewed_by: string | null;
        reviewed_at: Date | null;
      }[]>`
        UPDATE commerce.affiliate_withdrawals
           SET status = ${nextStatus}, review_note = ${reviewNote}, reviewed_by = ${reviewerId}, reviewed_at = NOW()
         WHERE id = ${id}
        RETURNING review_note, reviewed_by, reviewed_at
      `;
      return this.toAffiliateWithdrawal({
        ...row,
        status: nextStatus,
        review_note: updated[0]!.review_note,
        reviewed_by: updated[0]!.reviewed_by,
        reviewed_at: updated[0]!.reviewed_at,
      });
    });
  }
}
