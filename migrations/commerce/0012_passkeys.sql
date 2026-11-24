-- Lane A2. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.user_passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    credential_id   TEXT NOT NULL UNIQUE,
    public_key_spki BYTEA NOT NULL,
    algorithm       INTEGER NOT NULL DEFAULT -7,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      TEXT[] NOT NULL DEFAULT '{}',
    device_name     TEXT NOT NULL DEFAULT 'Passkey',
    backed_up       BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_user_passkeys_user
    ON commerce.user_passkeys (user_id, created_at DESC);
