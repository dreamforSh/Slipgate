-- Lane U2: Per-user platform spend quotas and per-window subscription resets.
-- Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.

CREATE TABLE IF NOT EXISTS core.user_platform_quotas (
    user_id                 TEXT NOT NULL,
    platform                TEXT NOT NULL,
    daily_limit_nano_usd    NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (daily_limit_nano_usd >= 0),
    weekly_limit_nano_usd   NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (weekly_limit_nano_usd >= 0),
    monthly_limit_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (monthly_limit_nano_usd >= 0),
    daily_reset_at          TIMESTAMPTZ,
    weekly_reset_at         TIMESTAMPTZ,
    monthly_reset_at        TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_core_user_platform_quotas_user
    ON core.user_platform_quotas (user_id);

DO $$
BEGIN
    IF to_regclass('commerce.subscriptions') IS NOT NULL THEN
        ALTER TABLE commerce.subscriptions
            ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS weekly_reset_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ;
    END IF;
END $$;
