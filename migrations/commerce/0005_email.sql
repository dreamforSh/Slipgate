-- Single-Writer Schema: commerce (owned exclusively by slipgate-bff / Bun TS)
-- Email verification codes and password-reset tokens (both stored as SHA-256 digests only).
-- Idempotent; slipgate-bff re-applies it at startup (store/postgres_ops.ts PG_OPS_SCHEMA_SQL).

CREATE TABLE IF NOT EXISTS commerce.email_codes (
    email       TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (email, purpose)
);

CREATE TABLE IF NOT EXISTS commerce.password_resets (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_password_resets_user ON commerce.password_resets (user_id);
