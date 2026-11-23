-- Lane O7. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Persisted system logs: warnings/errors, audit events and (opt-in) request access entries of the
-- BFF, plus the lines slipgate-net forwards for itself and slipgate-core. Written in batches by an
-- in-process queue, pruned after the runtime retention (commerce.portal_settings key
-- 'ops_runtime_log_config', default 30 days). Mirrored by PG_SYSTEM_LOGS_SCHEMA_SQL in
-- services/bff-ts/src/store/postgres_system_logs.ts.

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.system_logs (
    id                BIGSERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level             TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    source            TEXT NOT NULL DEFAULT 'bff' CHECK (source IN ('bff', 'net', 'core')),
    component         TEXT NOT NULL DEFAULT 'app',
    host              TEXT NOT NULL DEFAULT '',
    message           TEXT NOT NULL,
    request_id        TEXT NOT NULL DEFAULT '',
    client_request_id TEXT NOT NULL DEFAULT '',
    user_id           TEXT,
    api_key_id        TEXT,
    account_id        TEXT,
    platform          TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    -- Redacted structured fields as JSON text (searched as text, like the message).
    context           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_created
    ON commerce.system_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_level_created
    ON commerce.system_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_component_created
    ON commerce.system_logs (component, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_request
    ON commerce.system_logs (request_id) WHERE request_id <> '';
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_user_created
    ON commerce.system_logs (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_api_key_created
    ON commerce.system_logs (api_key_id, created_at DESC) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_system_logs_account_created
    ON commerce.system_logs (account_id, created_at DESC) WHERE account_id IS NOT NULL;

-- One row per admin cleanup: who deleted what (the filter) and how many rows.
CREATE TABLE IF NOT EXISTS commerce.system_log_cleanup_audits (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operator_id  TEXT NOT NULL,
    conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted_rows BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_commerce_system_log_cleanup_audits_created
    ON commerce.system_log_cleanup_audits (created_at DESC, id DESC);
