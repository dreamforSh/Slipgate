-- Lane C3: affiliate commission pool accounts, custom per-user rates, withdrawals and commission credit mode.
CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.affiliate_accounts (
    user_id TEXT PRIMARY KEY REFERENCES commerce.users(id) ON DELETE CASCADE,
    custom_rebate_bps INTEGER CHECK (custom_rebate_bps IS NULL OR (custom_rebate_bps >= 0 AND custom_rebate_bps <= 5000)),
    balance_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (balance_nano_usd >= 0),
    total_earned_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_earned_nano_usd >= 0),
    total_transferred_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_transferred_nano_usd >= 0),
    total_withdrawn_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0 CHECK (total_withdrawn_nano_usd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.affiliate_withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('wallet_transfer', 'payout')),
    amount_nano_usd NUMERIC(39, 0) NOT NULL CHECK (amount_nano_usd > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
    payout_method TEXT NOT NULL DEFAULT '',
    payout_account TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_withdrawals_user
    ON commerce.affiliate_withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_withdrawals_status
    ON commerce.affiliate_withdrawals (status, created_at DESC);

ALTER TABLE commerce.affiliate_commissions
    ADD COLUMN IF NOT EXISTS credited_to TEXT NOT NULL DEFAULT 'wallet';
