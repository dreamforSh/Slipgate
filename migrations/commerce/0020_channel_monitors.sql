-- Lane O3. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.channel_monitors (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    account_id          TEXT NOT NULL,
    group_id            TEXT NOT NULL DEFAULT '',
    platform            TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    interval_seconds    INTEGER NOT NULL DEFAULT 300,
    timeout_ms          INTEGER NOT NULL DEFAULT 30000,
    degraded_latency_ms INTEGER NOT NULL DEFAULT 8000,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    is_public           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    last_status         TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (last_status IN ('unknown', 'up', 'degraded', 'down')),
    last_latency_ms     INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT NOT NULL DEFAULT '',
    last_checked_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.channel_monitor_runs (
    id            BIGSERIAL PRIMARY KEY,
    monitor_id    TEXT NOT NULL REFERENCES commerce.channel_monitors(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
    ok            BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms    INTEGER NOT NULL DEFAULT 0,
    model         TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitors_enabled_order
    ON commerce.channel_monitors (enabled, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitor_runs_monitor_checked
    ON commerce.channel_monitor_runs (monitor_id, checked_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_channel_monitor_runs_checked
    ON commerce.channel_monitor_runs (checked_at DESC);
