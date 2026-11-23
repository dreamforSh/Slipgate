-- Lane U1. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Per-user request caps, per-group per-user caps, per-user group rate multipliers and RPM
-- overrides (packages/contracts/src/user_limits.ts). slipgate-bff re-applies this file's DDL at
-- startup (services/bff-ts/src/store/postgres_user_limits.ts PG_USER_LIMITS_SCHEMA_SQL).
--
-- Limits are whole numbers; 0 = no cap. A user's own cap may be NULL = inherit the portal
-- default (commerce.portal_settings defaultUserRpm / defaultUserConcurrency).

-- Per-user caps inside a group, across all of that user's keys in it (0 = none).
ALTER TABLE core.groups
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concurrency_limit INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_core_groups_user_caps') THEN
        ALTER TABLE core.groups
            ADD CONSTRAINT chk_core_groups_user_caps CHECK (rpm_limit >= 0 AND concurrency_limit >= 0);
    END IF;
END $$;

-- A user's own caps across every key and group. No row = both caps inherit the portal default.
CREATE TABLE IF NOT EXISTS core.user_limits (
    user_id             TEXT PRIMARY KEY REFERENCES commerce.users(id) ON DELETE CASCADE,
    rpm_limit           INTEGER CHECK (rpm_limit IS NULL OR rpm_limit >= 0),
    concurrency_limit   INTEGER CHECK (concurrency_limit IS NULL OR concurrency_limit >= 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user's custom multiplier and/or RPM override in one group. A row with both NULL is deleted.
CREATE TABLE IF NOT EXISTS core.user_group_rates (
    user_id             TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
    rate_multiplier     NUMERIC(12, 6) CHECK (rate_multiplier IS NULL OR (rate_multiplier > 0 AND rate_multiplier <= 100)),
    rpm_override        INTEGER CHECK (rpm_override IS NULL OR rpm_override >= 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_core_user_group_rates_group
    ON core.user_group_rates (group_id);

-- Keys by group (admin group key list, API-key-group user filter, replace-group moves).
CREATE INDEX IF NOT EXISTS idx_core_api_keys_group_user
    ON core.api_keys (group_id, user_id);
