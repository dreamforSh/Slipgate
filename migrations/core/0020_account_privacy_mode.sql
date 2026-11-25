-- Outcome of the admin "set privacy" action on OAuth accounts (ChatGPT training off /
-- Antigravity telemetry off): training_off, training_set_failed, training_set_cf_blocked,
-- privacy_set, privacy_set_failed. NULL = never set.
-- Idempotent; the BFF applies the same statement at startup.

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS privacy_mode TEXT,
    ADD COLUMN IF NOT EXISTS privacy_checked_at TIMESTAMPTZ;
