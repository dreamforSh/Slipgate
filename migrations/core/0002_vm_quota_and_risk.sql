-- Single-Writer Schema: core (owned exclusively by slipgate-core / Zig)
-- Tracks 5h/7d official window quotas anchored by account_id, escalating risk bans, and refusal cache.

CREATE TABLE IF NOT EXISTS core.account_window_quotas (
    account_id              TEXT PRIMARY KEY REFERENCES core.accounts(id) ON DELETE CASCADE,
    window_5h_used_bps      INTEGER NOT NULL DEFAULT 0 CHECK (window_5h_used_bps >= 0 AND window_5h_used_bps <= 10000),
    window_5h_reset_at      TIMESTAMPTZ,
    window_7d_used_bps      INTEGER NOT NULL DEFAULT 0 CHECK (window_7d_used_bps >= 0 AND window_7d_used_bps <= 10000),
    window_7d_reset_at      TIMESTAMPTZ,
    lifetime_tokens         BIGINT NOT NULL DEFAULT 0,
    lifetime_cost_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.risk_ban_records (
    id                  TEXT PRIMARY KEY,
    subject_kind        TEXT NOT NULL CHECK (subject_kind IN ('device', 'session', 'api_key', 'ip')),
    subject_hash        TEXT NOT NULL,
    strike_level        SMALLINT NOT NULL CHECK (strike_level BETWEEN 1 AND 3),
    ban_reason          TEXT NOT NULL,
    source_request_id   TEXT,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_risk_ban_lookup
    ON core.risk_ban_records (subject_kind, subject_hash, expires_at DESC);

CREATE TABLE IF NOT EXISTS core.refusal_cache (
    request_fingerprint TEXT PRIMARY KEY,
    reason              TEXT NOT NULL,
    http_status         INTEGER NOT NULL DEFAULT 400,
    response_payload    JSONB NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_core_refusal_cache_expiry
    ON core.refusal_cache (expires_at);
