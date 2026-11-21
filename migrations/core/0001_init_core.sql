-- Single-Writer Schema: core (owned exclusively by slipgate-core / Zig)

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.groups (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    platform        TEXT NOT NULL,
    subscription_type TEXT NOT NULL DEFAULT 'balance',
    rate_multiplier NUMERIC(12, 6) NOT NULL DEFAULT 1.000000,
    model_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.accounts (
    id                  TEXT PRIMARY KEY,
    group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
    platform            TEXT NOT NULL,
    auth_kind           TEXT NOT NULL,
    credentials_enc     BYTEA NOT NULL,
    max_concurrency     INTEGER NOT NULL DEFAULT 5,
    priority            INTEGER NOT NULL DEFAULT 100,
    is_shadow_follower  BOOLEAN NOT NULL DEFAULT FALSE,
    parent_account_id   TEXT REFERENCES core.accounts(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    temp_unsched_until  TIMESTAMPTZ,
    temp_unsched_reason TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_accounts_group_status
    ON core.accounts (group_id, status, priority);

CREATE TABLE IF NOT EXISTS core.composite_routes (
    id              TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL REFERENCES core.groups(id) ON DELETE CASCADE,
    public_model    TEXT NOT NULL,
    match_type      TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix')),
    target_platform TEXT NOT NULL,
    upstream_model  TEXT NOT NULL,
    endpoint        TEXT NOT NULL DEFAULT 'any',
    priority        INTEGER NOT NULL DEFAULT 100,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_composite_routes_lookup
    ON core.composite_routes (group_id, enabled, priority, id);

CREATE TABLE IF NOT EXISTS core.api_keys (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    group_id            TEXT NOT NULL REFERENCES core.groups(id) ON DELETE RESTRICT,
    key_prefix          TEXT NOT NULL,
    key_hash_blake3     BYTEA NOT NULL UNIQUE,
    rpm_limit           INTEGER NOT NULL DEFAULT 60,
    concurrency_limit   INTEGER NOT NULL DEFAULT 5,
    ip_allowlist        JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_api_keys_user
    ON core.api_keys (user_id, enabled);

CREATE TABLE IF NOT EXISTS core.quota_wallets (
    user_id             TEXT PRIMARY KEY,
    balance_nano_usd    NUMERIC(39, 0) NOT NULL DEFAULT 0,
    held_nano_usd       NUMERIC(39, 0) NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_core_wallet_non_negative_held CHECK (held_nano_usd >= 0)
);

CREATE TABLE IF NOT EXISTS core.ledger_entries (
    id                  TEXT PRIMARY KEY,
    idempotency_key     TEXT NOT NULL UNIQUE,
    user_id             TEXT NOT NULL REFERENCES core.quota_wallets(user_id) ON DELETE RESTRICT,
    entry_kind          TEXT NOT NULL CHECK (entry_kind IN ('credit', 'hold', 'settle', 'release', 'adjust')),
    delta_nano_usd      NUMERIC(39, 0) NOT NULL,
    balance_after_nano  NUMERIC(39, 0) NOT NULL,
    reference_id        TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_ledger_user_created
    ON core.ledger_entries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS core.usage_logs (
    id                  TEXT NOT NULL,
    request_id          TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    api_key_id          TEXT NOT NULL,
    account_id          TEXT NOT NULL,
    group_id            TEXT NOT NULL,
    platform            TEXT NOT NULL,
    public_model        TEXT NOT NULL,
    upstream_model      TEXT NOT NULL,
    ingress_codec       TEXT NOT NULL,
    egress_codec        TEXT NOT NULL,
    input_tokens        BIGINT NOT NULL DEFAULT 0,
    output_tokens       BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
    cost_nano_usd       NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ttft_ms             INTEGER,
    duration_ms         INTEGER,
    status_code         INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS core.usage_logs_default
    PARTITION OF core.usage_logs DEFAULT;

CREATE INDEX IF NOT EXISTS idx_core_usage_logs_user_time
    ON core.usage_logs (user_id, created_at DESC);
