-- Single-Writer Schema: commerce (owned exclusively by slipgate-bff / Bun TS)

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status          TEXT NOT NULL DEFAULT 'active',
    totp_secret_enc BYTEA,
    totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    referrer_id     TEXT REFERENCES commerce.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.auth_identities (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    subject         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS commerce.passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    credential_id   BYTEA NOT NULL UNIQUE,
    public_key      BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.payment_orders (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE RESTRICT,
    provider            TEXT NOT NULL,
    provider_trade_no   TEXT,
    amount_nano_usd     NUMERIC(39, 0) NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'USD',
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    idempotency_key     TEXT NOT NULL UNIQUE,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.outbox_events (
    id              TEXT PRIMARY KEY,
    event_type      TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'dead_letter')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_outbox_pending
    ON commerce.outbox_events (status, next_retry_at);

CREATE TABLE IF NOT EXISTS commerce.subscriptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    group_id        TEXT NOT NULL,
    plan_code       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    starts_at       TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.redeem_codes (
    code            TEXT PRIMARY KEY,
    amount_nano_usd NUMERIC(39, 0) NOT NULL,
    redeemed_by     TEXT REFERENCES commerce.users(id) ON DELETE SET NULL,
    redeemed_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.affiliate_commissions (
    id              TEXT PRIMARY KEY,
    beneficiary_id  TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE RESTRICT,
    source_order_id TEXT NOT NULL REFERENCES commerce.payment_orders(id) ON DELETE RESTRICT,
    amount_nano_usd NUMERIC(39, 0) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
