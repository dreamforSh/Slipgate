import postgres from "postgres";
import type { PaymentChannelLimit, PaymentInstanceProvider } from "@slipgate/contracts";
import {
  newInstanceId,
  OPEN_INSTANCE_ORDER_STATUSES,
  type PaymentInstanceInput,
  type PaymentInstanceRecord,
  type PaymentInstanceStore,
} from "./payment_providers_types.ts";
import { StoreError } from "./types.ts";

type Sql = ReturnType<typeof postgres>;

/**
 * Idempotent DDL mirrored by migrations/commerce/0009_payment_providers.sql (applied at BFF
 * startup after PG_PAYMENTS_SCHEMA_SQL): provider instances, the instance / QR / checkout and
 * refund columns of payment_orders, and the widened status check.
 */
export const PG_PAYMENT_PROVIDERS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS commerce.payment_provider_instances (
      id                TEXT PRIMARY KEY,
      provider          TEXT NOT NULL CHECK (provider IN ('easypay', 'stripe', 'alipay', 'wxpay', 'airwallex')),
      name              TEXT NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      supported_types   JSONB NOT NULL DEFAULT '[]'::jsonb,
      payment_mode      TEXT NOT NULL DEFAULT '',
      refund_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      allow_user_refund BOOLEAN NOT NULL DEFAULT FALSE,
      limits_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
      config_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- AES-GCM (vault secret) of the JSON secret map, hex; never returned by the API.
      credentials_enc   TEXT NOT NULL DEFAULT '',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_provider_instances_provider
      ON commerce.payment_provider_instances (provider, sort_order);

  ALTER TABLE commerce.payment_orders
      ADD COLUMN IF NOT EXISTS provider_instance_id TEXT,
      ADD COLUMN IF NOT EXISTS qr_code TEXT,
      ADD COLUMN IF NOT EXISTS checkout_json JSONB,
      ADD COLUMN IF NOT EXISTS refund_amount_minor INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_reason TEXT,
      ADD COLUMN IF NOT EXISTS refund_error TEXT,
      ADD COLUMN IF NOT EXISTS provider_refund_id TEXT,
      ADD COLUMN IF NOT EXISTS refund_reclaim BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS refund_force BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS refund_reclaimed_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_request_reason TEXT,
      ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

  -- Daily usage per instance (load balancer limits) and the expiry sweeper's scan.
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_orders_instance_created
      ON commerce.payment_orders (provider_instance_id, created_at) WHERE provider_instance_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_orders_pending_expiry
      ON commerce.payment_orders (expires_at) WHERE status = 'pending';
  -- Gateway refunds awaiting confirmation (polled by the sweeper and the admin "query" action).
  CREATE INDEX IF NOT EXISTS idx_commerce_payment_orders_refund_pending
      ON commerce.payment_orders (updated_at) WHERE status = 'refund_pending';

  DO $$
  BEGIN
      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'payment_orders_status_check'
             AND pg_get_constraintdef(oid) LIKE '%partially_refunded%'
      ) THEN
          ALTER TABLE commerce.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
          ALTER TABLE commerce.payment_orders ADD CONSTRAINT payment_orders_status_check
              CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'cancelled', 'expired',
                                'refund_requested', 'refund_pending', 'refund_failed', 'partially_refunded'));
      END IF;
  END $$;
`;

interface InstanceRow {
  id: string;
  provider: PaymentInstanceProvider;
  name: string;
  enabled: boolean;
  sort_order: number;
  supported_types: unknown;
  payment_mode: string;
  refund_enabled: boolean;
  allow_user_refund: boolean;
  limits_json: unknown;
  config_json: unknown;
  credentials_enc: string;
  created_at: Date;
  updated_at: Date;
}

const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

function toRecord(r: InstanceRow): PaymentInstanceRecord {
  const types = json(r.supported_types);
  const limits = json(r.limits_json);
  const config = json(r.config_json);
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    enabled: r.enabled,
    sortOrder: r.sort_order,
    supportedTypes: Array.isArray(types) ? types.filter((t): t is string => typeof t === "string") : [],
    paymentMode: r.payment_mode,
    refundEnabled: r.refund_enabled,
    allowUserRefund: r.allow_user_refund,
    limits: limits && typeof limits === "object" ? (limits as Record<string, PaymentChannelLimit>) : {},
    config: config && typeof config === "object" ? (config as Record<string, unknown>) : {},
    credentialsEnc: r.credentials_enc,
    createdAtIso: new Date(r.created_at).toISOString(),
    updatedAtIso: new Date(r.updated_at).toISOString(),
  };
}

export class PostgresPaymentInstanceStore implements PaymentInstanceStore {
  constructor(private readonly sql: Sql) {}

  private j(v: unknown) {
    return this.sql.json(v as postgres.JSONValue);
  }

  async listInstances() {
    const rows = await this.sql<InstanceRow[]>`
      SELECT * FROM commerce.payment_provider_instances ORDER BY sort_order, created_at, id
    `;
    return rows.map(toRecord);
  }

  async getInstance(id: string) {
    const rows = await this.sql<InstanceRow[]>`SELECT * FROM commerce.payment_provider_instances WHERE id = ${id}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async createInstance(input: PaymentInstanceInput) {
    const id = newInstanceId();
    await this.sql`
      INSERT INTO commerce.payment_provider_instances
        (id, provider, name, enabled, sort_order, supported_types, payment_mode, refund_enabled, allow_user_refund,
         limits_json, config_json, credentials_enc)
      VALUES (${id}, ${input.provider}, ${input.name}, ${input.enabled}, ${input.sortOrder}, ${this.j(input.supportedTypes)},
              ${input.paymentMode}, ${input.refundEnabled}, ${input.allowUserRefund}, ${this.j(input.limits)},
              ${this.j(input.config)}, ${input.credentialsEnc})
    `;
    return (await this.getInstance(id))!;
  }

  async updateInstance(id: string, input: PaymentInstanceInput) {
    const rows = await this.sql`
      UPDATE commerce.payment_provider_instances
         SET name = ${input.name}, enabled = ${input.enabled}, sort_order = ${input.sortOrder},
             supported_types = ${this.j(input.supportedTypes)}, payment_mode = ${input.paymentMode},
             refund_enabled = ${input.refundEnabled}, allow_user_refund = ${input.allowUserRefund},
             limits_json = ${this.j(input.limits)}, config_json = ${this.j(input.config)},
             credentials_enc = ${input.credentialsEnc}, updated_at = NOW()
       WHERE id = ${id}
      RETURNING id
    `;
    if (rows.length === 0) throw new StoreError("not_found", "Payment provider not found");
    return (await this.getInstance(id))!;
  }

  async deleteInstance(id: string) {
    const statuses = [...OPEN_INSTANCE_ORDER_STATUSES];
    const rows = await this.sql<{ deleted: boolean; open: number; found: boolean }[]>`
      WITH open_orders AS (
        SELECT COUNT(*)::int AS n FROM commerce.payment_orders
         WHERE provider_instance_id = ${id} AND status = ANY(${statuses}::text[])
      ), gone AS (
        DELETE FROM commerce.payment_provider_instances
         WHERE id = ${id} AND (SELECT n FROM open_orders) = 0
        RETURNING id
      )
      SELECT EXISTS (SELECT 1 FROM gone) AS deleted, (SELECT n FROM open_orders) AS open,
             EXISTS (SELECT 1 FROM commerce.payment_provider_instances WHERE id = ${id}) AS found
    `;
    const r = rows[0]!;
    if (r.deleted) return;
    if (!r.found) throw new StoreError("not_found", "Payment provider not found");
    throw new StoreError("conflict", `This provider still has ${r.open} open order(s); disable it instead and delete it once they are settled`);
  }

  async countOpenOrders(id: string) {
    const statuses = [...OPEN_INSTANCE_ORDER_STATUSES];
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM commerce.payment_orders
       WHERE provider_instance_id = ${id} AND status = ANY(${statuses}::text[])
    `;
    return rows[0]?.n ?? 0;
  }

  async reorderInstances(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const orders = unique.map((_, i) => (i + 1) * 10);
    await this.sql`
      UPDATE commerce.payment_provider_instances AS p
         SET sort_order = v.sort_order, updated_at = NOW()
        FROM (SELECT * FROM unnest(${unique}::text[], ${orders}::int[]) AS t(id, sort_order)) AS v
       WHERE p.id = v.id
    `;
  }
}
