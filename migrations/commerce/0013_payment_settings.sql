-- Lane C2: dedicated singleton table for payment configuration (mirrored in PostgresPaymentsStore).
CREATE SCHEMA IF NOT EXISTS commerce;

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
