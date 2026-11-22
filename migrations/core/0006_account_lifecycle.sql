-- Single-Writer Schema: core (transitional BFF ControlStore)
-- Account lifecycle and operations:
--   * expires_at / auto_pause_on_expired: subscription expiry; the exported data-plane status
--     becomes 'expired' once the deadline passes (temp_unsched_until from 0001 is the cooldown deadline).
--   * credential_fingerprint: HMAC of the canonical credential, used to skip duplicates on import.
--   * account_window_quotas.last_used_at: last settled request per account.
--   * usage_logs (account_id, created_at): per-account usage summaries and stats.
--
-- The BFF re-applies the column changes at startup, so existing databases pick them up
-- without running this file. The usage_logs index is only created here (on a fresh,
-- empty database). On an existing database with traffic, build it without blocking writes:
--
--   CREATE INDEX IF NOT EXISTS idx_core_usage_logs_account_time
--       ON ONLY core.usage_logs (account_id, created_at DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_logs_default_account_time_idx
--       ON core.usage_logs_default (account_id, created_at DESC);
--   ALTER INDEX core.idx_core_usage_logs_account_time
--       ATTACH PARTITION core.usage_logs_default_account_time_idx;
--   -- (repeat the last two statements for every other partition)

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_pause_on_expired BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_core_accounts_credential_fingerprint
    ON core.accounts (credential_fingerprint);

ALTER TABLE core.account_window_quotas
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_core_usage_logs_account_time
    ON core.usage_logs (account_id, created_at DESC);
