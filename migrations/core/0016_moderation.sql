-- Lane O5. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.moderation_settings (
    id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled              BOOLEAN NOT NULL DEFAULT FALSE,
    external_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    external_endpoint    TEXT NOT NULL DEFAULT '',
    external_api_key_enc BYTEA,
    external_model       TEXT NOT NULL DEFAULT 'omni-moderation-latest',
    external_timeout_ms  INTEGER NOT NULL DEFAULT 3000,
    external_fail_open   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.moderation_rules (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    kind            TEXT NOT NULL CHECK (kind IN ('keyword', 'regex')),
    pattern         TEXT NOT NULL,
    case_sensitive  BOOLEAN NOT NULL DEFAULT FALSE,
    action          TEXT NOT NULL CHECK (action IN ('block', 'log_only', 'strike')),
    scope_platforms TEXT[] NOT NULL DEFAULT '{}',
    scope_group_ids TEXT[] NOT NULL DEFAULT '{}',
    reject_message  TEXT NOT NULL DEFAULT 'Request blocked by content moderation policy',
    priority        INTEGER NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.moderation_events (
    id              TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL DEFAULT '',
    user_id         TEXT,
    api_key_id      TEXT,
    group_id        TEXT,
    platform        TEXT NOT NULL DEFAULT '',
    public_model    TEXT NOT NULL DEFAULT '',
    rule_id         TEXT,
    rule_name       TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL CHECK (source IN ('local_rule', 'external_api')),
    action          TEXT NOT NULL CHECK (action IN ('block', 'log_only', 'strike')),
    matched_excerpt TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_moderation_events_created
    ON core.moderation_events (created_at DESC);

ALTER TABLE core.risk_ban_records
    ADD COLUMN IF NOT EXISTS unbanned_at TIMESTAMPTZ;
