-- Single-Writer Schema: commerce (owned exclusively by slipgate-bff / Bun TS)
-- Purchasable plans, richer payment orders (fiat minor units, plan snapshot, expiry, pay URL)
-- and affiliate commission invitees. Idempotent; slipgate-bff re-applies it at startup
-- (store/postgres_payments.ts) so existing databases upgrade in place.

CREATE TABLE IF NOT EXISTS commerce.payment_plans (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL CHECK (kind IN ('recharge', 'subscription')),
    price_minor     INTEGER NOT NULL CHECK (price_minor > 0),
    currency        TEXT NOT NULL DEFAULT 'CNY',
    credit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    group_id        TEXT,
    validity_days   INTEGER,
    badge           TEXT NOT NULL DEFAULT '',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

ALTER TABLE commerce.affiliate_commissions
    ADD COLUMN IF NOT EXISTS invitee_id TEXT;
CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_commissions_beneficiary
    ON commerce.affiliate_commissions (beneficiary_id, created_at DESC);
