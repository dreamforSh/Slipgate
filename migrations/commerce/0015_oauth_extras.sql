-- Lane A3. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS commerce;

ALTER TABLE commerce.users
    ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS commerce.oauth_pending_signups (
    token_hash         TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,
    subject            TEXT NOT NULL,
    suggested_email    TEXT NOT NULL DEFAULT '',
    suggested_username TEXT NOT NULL DEFAULT '',
    avatar_url         TEXT NOT NULL DEFAULT '',
    binding_hash       TEXT NOT NULL,
    redirect_path      TEXT NOT NULL DEFAULT '/dashboard',
    expires_at         TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_oauth_pending_expires
    ON commerce.oauth_pending_signups (expires_at);
