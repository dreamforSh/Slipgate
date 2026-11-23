-- group D: session revocation / token versions.
-- Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup
-- (services/bff-ts/src/store/postgres_ops.ts PG_SESSION_SCHEMA_SQL).
--
--   * commerce.users.token_version: every console access token carries the user's token version
--     (JWT claim `ver`). Password changes and resets, suspension, role changes and "sign out of all
--     devices" bump it, which ends every token issued before. Each authenticated request re-reads
--     it (with the user's status and role) through a short-lived cache.
--   * commerce.revoked_tokens: server-side logout. A signed-out token's id (JWT claim `jti`) stays
--     here until the token's own expiry, then is pruned. No foreign key: a deleted user's tokens
--     are refused anyway, and a logout racing a deletion must not fail.
--   * The last-admin guard serialises on a transaction-scoped advisory lock (no DDL needed).

ALTER TABLE commerce.users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS commerce.revoked_tokens (
    jti         TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_revoked_tokens_expires ON commerce.revoked_tokens (expires_at);
