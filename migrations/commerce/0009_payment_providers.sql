-- Lane C1. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Payment provider instances (several merchants per gateway, load balanced with per-channel
-- limits), the instance and in-page QR / checkout data on orders, gateway refunds (partial
-- amounts, pending / failed states), user refund requests, and a persisted `expired` status for
-- orders the sweeper has checked with their provider. Mirrored by PG_PAYMENT_PROVIDERS_SCHEMA_SQL
-- (services/bff-ts/src/store/postgres_payment_providers.ts).

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
