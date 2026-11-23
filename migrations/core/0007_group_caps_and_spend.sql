-- Core schema (written by the transitional slipgate-bff ControlStore)
-- Subscription spend caps on groups, a lifetime spend counter on wallets, and usage_logs
-- indexes for per-group status pages and per-key usage lookups. slipgate-bff re-applies the
-- column changes at startup. The usage_logs indexes below only build here, on a fresh database;
-- on existing databases slipgate-bff builds the same indexes on each partition CONCURRENTLY in the
-- background and ATTACHes them to these parent indexes, attaching (not duplicating) any equal
-- index that already exists (store/postgres_settlement.ts ensureUsageLogIndexes). 0009 replaces
-- idx_core_usage_logs_key_time with a covering (api_key_id, created_at) INCLUDE (cost) index.

ALTER TABLE core.groups
    ADD COLUMN IF NOT EXISTS daily_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS weekly_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_limit_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS default_validity_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE core.quota_wallets
    ADD COLUMN IF NOT EXISTS spent_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_core_usage_logs_group_time
    ON core.usage_logs (group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_usage_logs_key_time
    ON core.usage_logs (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_usage_logs_time
    ON core.usage_logs (created_at DESC);
