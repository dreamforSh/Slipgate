import postgres from "postgres";
import {
  PAID_ORDER_STATUSES,
  type AffiliateRebateItem,
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
      ADD COLUMN IF NOT EXISTS prior_refund_amount_minor INTEGER NOT NULL DEFAULT 0;
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
${PG_PAYMENTS_INTEGRITY_SQL}`;

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
    const rows = await this.sql<{ value_json: unknown }[]>`
      SELECT value_json FROM commerce.portal_settings WHERE key = 'payment_config'
    `;
    const v = rows[0]?.value_json;
    const decoded = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  }

  async saveConfigBlob(blob: Record<string, unknown>) {
    await this.sql`
      INSERT INTO commerce.portal_settings (key, value_json, updated_at)
      VALUES ('payment_config', ${this.sql.json(blob as postgres.JSONValue)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
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
    if (input.kind === "subscription" && (await this.subscriptionGroupProblem(this.sql, input.groupId))) {
      throw new StoreError("conflict", "This plan cannot be purchased right now");
    }
    const id = `ord_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    try {
      await this.sql`
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
      if (rebate.enabled && rebate.bps > 0 && o.kind === "recharge" && credit > 0n) {
        const ref = await tx<{ referrer_id: string | null }[]>`SELECT referrer_id FROM commerce.users WHERE id = ${o.user_id}`;
        const referrerId = ref[0]?.referrer_id;
        const amount = (credit * BigInt(rebate.bps)) / 10_000n;
        if (referrerId && amount > 0n && (await pgApplyWalletDelta(tx, referrerId, amount, `rebate:${id}`, "credit", `rebate:${id}`))) {
          await tx`
            INSERT INTO commerce.affiliate_commissions (id, beneficiary_id, source_order_id, amount_nano_usd, status, invitee_id)
            VALUES (${`cms_${crypto.randomUUID()}`}, ${referrerId}, ${id}, ${amount.toString()}::numeric, 'settled', ${o.user_id})
          `;
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
             delivery_error, refund_amount_minor, prior_refund_amount_minor, refund_reclaim, refund_request_reason, updated_at
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
      if (o.status !== "refund_pending") throw new StoreError("conflict", "The refund is no longer pending");
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
      // One rebate per order (fulfilment credits it under the ledger key rebate:<order>).
      const rebate = await tx<{ id: string; beneficiary_id: string; amount: string }[]>`
        SELECT id, beneficiary_id, amount_nano_usd::text AS amount FROM commerce.affiliate_commissions
         WHERE source_order_id = ${id} AND status <> 'reversed'
         ORDER BY created_at LIMIT 1 FOR UPDATE
      `;
      if (rebate[0]) {
        const r = rebate[0];
        const whole = BigInt(r.amount);
        const back = proportion(whole, part, remainingBeforePart);
        if (back > 0n) {
          await pgApplyWalletDelta(tx, r.beneficiary_id, -back, `rebate-refund:${id}${ledgerSuffix}`, "adjust", `rebate-refund:${id}${ledgerSuffix}`);
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
               updated_at = NOW()
         WHERE id = ${id}
      `;
    });
    return (await this.getOrder(id))!;
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
      { id: string; beneficiary_id: string; b_email: string | null; i_email: string | null; source_order_id: string; amount: string; created_at: Date }[]
    >`
      SELECT c.id, c.beneficiary_id, b.email AS b_email, i.email AS i_email, c.source_order_id,
             c.amount_nano_usd::text AS amount, c.created_at
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
}
