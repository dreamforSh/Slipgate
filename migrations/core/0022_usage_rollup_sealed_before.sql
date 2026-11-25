-- Usage rollups: sealed horizon. A retention cleanup summarises whole UTC days from complete
-- detail rows, records the cutoff here, then deletes those rows; backfills never recompute a
-- bucket before it, so repeated cleanups can no longer shrink historical counts and amounts.
-- Mirrored by PG_USAGE_ROLLUPS_SCHEMA_SQL (services/bff-ts/src/store/postgres_usage_rollups.ts).
ALTER TABLE core.usage_rollup_state ADD COLUMN IF NOT EXISTS sealed_before TIMESTAMPTZ;
