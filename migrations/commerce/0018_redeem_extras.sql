-- Lane C4: multi-use redeem codes, per-user and per-batch claim limits, and individual claim history.
CREATE SCHEMA IF NOT EXISTS commerce;

ALTER TABLE commerce.redeem_codes
    ADD COLUMN IF NOT EXISTS max_uses INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS batch_per_user_limit INTEGER NOT NULL DEFAULT 0;

UPDATE commerce.redeem_codes
   SET used_count = 1
 WHERE status = 'used' AND used_count = 0;

CREATE TABLE IF NOT EXISTS commerce.redeem_code_claims (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL REFERENCES commerce.redeem_codes(code) ON DELETE CASCADE,
    batch_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    amount_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    group_id TEXT,
    validity_days INTEGER,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_code_user
    ON commerce.redeem_code_claims (code, user_id);
CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_batch_user
    ON commerce.redeem_code_claims (batch_id, user_id);
CREATE INDEX IF NOT EXISTS idx_commerce_redeem_claims_user
    ON commerce.redeem_code_claims (user_id, redeemed_at DESC);
