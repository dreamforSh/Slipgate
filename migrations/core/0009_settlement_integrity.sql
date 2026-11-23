-- Core schema (written by the transitional slipgate-bff ControlStore)
-- group A: settlement idempotency and usage_logs indexes for the settlement path.
-- Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
--
--   * core.settlement_ids: one row per settled turn, keyed by the settlement id slipgate-net mints
--     for the turn and reuses on every delivery retry. Its PRIMARY KEY is the billing idempotency
--     guarantee. usage_logs.request_id is the caller's X-Request-Id and only correlates; a unique
--     index on the partitioned usage_logs would have to include created_at and could not dedupe.
--     slipgate-bff re-creates this table at startup (store/postgres_settlement.ts
--     PG_SETTLEMENT_SCHEMA_SQL) and prunes rows long past the edge's retry horizon.
--   * Covering usage_logs indexes for the per-key spend windows (api_key_id) and the subscription
--     caps (user_id, group_id), so both read only index pages. The covering key index replaces
--     0007's idx_core_usage_logs_key_time. These index builds only run here, on a fresh, empty
--     database. On an existing database slipgate-bff builds them on each partition CONCURRENTLY in
--     the background, attaches them to the parent indexes (the 0006 ON ONLY + ATTACH PARTITION
--     pattern, so the two paths converge on one index per partition) and then drops the superseded
--     and duplicate indexes (store/postgres_settlement.ts ensureUsageLogIndexes).

CREATE TABLE IF NOT EXISTS core.settlement_ids (
    settlement_id    TEXT PRIMARY KEY,
    usage_id         TEXT NOT NULL,
    usage_created_at TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_settlement_ids_created
    ON core.settlement_ids (created_at);

-- listGroups' per-group key count (settlement-path group cache, snapshot export) without a
-- sequential scan of core.api_keys per group.
CREATE INDEX IF NOT EXISTS idx_core_api_keys_group
    ON core.api_keys (group_id);

CREATE INDEX IF NOT EXISTS idx_core_usage_logs_key_time_cost
    ON core.usage_logs (api_key_id, created_at DESC) INCLUDE (cost_nano_usd);
CREATE INDEX IF NOT EXISTS idx_core_usage_logs_user_group_time_cost
    ON core.usage_logs (user_id, group_id, created_at DESC) INCLUDE (cost_nano_usd);

DROP INDEX IF EXISTS core.idx_core_usage_logs_key_time;
