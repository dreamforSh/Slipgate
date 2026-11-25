-- Per-account spend quota (sub2api "quota limit"): daily / weekly rolling windows and a total cap,
-- nano-USD, 0 = no limit. quota_reset_at: usage before it no longer counts ("reset quota").
-- Reaching any limit takes the account out of scheduling (the BFF sends it as paused).
-- Idempotent; the BFF applies the same statement at startup.

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS quota_daily_limit_nano_usd NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quota_weekly_limit_nano_usd NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quota_total_limit_nano_usd NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quota_reset_at TIMESTAMPTZ;
