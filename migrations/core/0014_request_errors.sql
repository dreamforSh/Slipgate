-- Lane O1. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.request_errors (
    id                BIGSERIAL PRIMARY KEY,
    request_id        TEXT NOT NULL DEFAULT '',
    client_request_id TEXT NOT NULL DEFAULT '',
    user_id           TEXT,
    api_key_id        TEXT,
    account_id        TEXT,
    group_id          TEXT,
    platform          TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    upstream_model    TEXT NOT NULL DEFAULT '',
    phase             TEXT NOT NULL DEFAULT 'other'
                      CHECK (phase IN ('ingress', 'core_eval', 'outbound', 'upstream_http', 'stream_relay', 'other')),
    kind              TEXT NOT NULL DEFAULT '',
    status_code       INTEGER NOT NULL DEFAULT 500,
    upstream_status   INTEGER NOT NULL DEFAULT 0,
    error_type        TEXT NOT NULL DEFAULT '',
    error_code        TEXT NOT NULL DEFAULT '',
    error_message     TEXT NOT NULL DEFAULT '',
    upstream_body     TEXT NOT NULL DEFAULT '',
    attempt           INTEGER NOT NULL DEFAULT 1,
    failover_used     BOOLEAN NOT NULL DEFAULT FALSE,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    execution_mode    TEXT NOT NULL DEFAULT '',
    metadata_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved          BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at       TIMESTAMPTZ,
    resolved_by       TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_request_errors_created
    ON core.request_errors (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_core_request_errors_phase_created
    ON core.request_errors (phase, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_request_errors_status_created
    ON core.request_errors (status_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_request_errors_account_created
    ON core.request_errors (account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_core_request_errors_user_created
    ON core.request_errors (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_core_request_errors_request_id
    ON core.request_errors (request_id) WHERE request_id <> '';
CREATE INDEX IF NOT EXISTS idx_core_request_errors_resolved_created
    ON core.request_errors (resolved, created_at DESC);
