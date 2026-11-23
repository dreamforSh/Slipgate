-- Core schema (written by the transitional slipgate-bff ControlStore)
-- API key spend caps (lifetime quota + 5h/1d/7d rolling windows), IP denylist and last use.
-- slipgate-bff re-applies these columns at startup (store/postgres_ops.ts PG_OPS_SCHEMA_SQL).

ALTER TABLE core.api_keys
    ADD COLUMN IF NOT EXISTS ip_denylist JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS quota_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS spent_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS limit_5h_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS limit_1d_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS limit_7d_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
