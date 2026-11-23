-- Single-Writer Schema: commerce (owned exclusively by slipgate-bff / Bun TS)
-- Operations & commerce: user administration fields, redeem/promo codes, announcements,
-- audit log and group subscriptions. Every statement is idempotent; slipgate-bff re-applies
-- the same DDL at startup (store/pg_ops_schema.ts) so existing databases upgrade in place.

ALTER TABLE commerce.users
    ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS allowed_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS invite_code TEXT,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_users_invite_code
    ON commerce.users (invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_users_created ON commerce.users (created_at DESC);

ALTER TABLE commerce.redeem_codes
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'balance',
    ADD COLUMN IF NOT EXISTS group_id TEXT,
    ADD COLUMN IF NOT EXISTS validity_days INTEGER,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unused',
    ADD COLUMN IF NOT EXISTS batch_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Rows written before status existed: a redeemed code is used.
UPDATE commerce.redeem_codes SET status = 'used' WHERE redeemed_by IS NOT NULL AND status = 'unused';

CREATE INDEX IF NOT EXISTS idx_commerce_redeem_codes_created ON commerce.redeem_codes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_redeem_codes_redeemed_by ON commerce.redeem_codes (redeemed_by, redeemed_at DESC);

CREATE TABLE IF NOT EXISTS commerce.promo_codes (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    bonus_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0,
    max_uses        INTEGER NOT NULL DEFAULT 0,
    used_count      INTEGER NOT NULL DEFAULT 0,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at      TIMESTAMPTZ,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.promo_code_usages (
    promo_code_id   TEXT NOT NULL REFERENCES commerce.promo_codes(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    bonus_nano_usd  NUMERIC(39, 0) NOT NULL DEFAULT 0,
    used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (promo_code_id, user_id)
);

CREATE TABLE IF NOT EXISTS commerce.announcements (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL DEFAULT 'info',
    status      TEXT NOT NULL DEFAULT 'draft',
    audience    TEXT NOT NULL DEFAULT 'all',
    pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    popup       BOOLEAN NOT NULL DEFAULT FALSE,
    starts_at   TIMESTAMPTZ,
    ends_at     TIMESTAMPTZ,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.announcement_reads (
    announcement_id TEXT NOT NULL REFERENCES commerce.announcements(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS commerce.audit_logs (
    id           TEXT PRIMARY KEY,
    actor_id     TEXT NOT NULL,
    actor_email  TEXT NOT NULL DEFAULT '',
    actor_role   TEXT NOT NULL DEFAULT '',
    method       TEXT NOT NULL,
    route        TEXT NOT NULL,
    path         TEXT NOT NULL,
    target_id    TEXT NOT NULL DEFAULT '',
    status_code  INTEGER NOT NULL,
    ip           TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT '',
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    request_body TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_created ON commerce.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_actor ON commerce.audit_logs (actor_id, created_at DESC);

ALTER TABLE commerce.subscriptions
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin',
    ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_commerce_subscriptions_user_group
    ON commerce.subscriptions (user_id, group_id, status);
CREATE INDEX IF NOT EXISTS idx_commerce_subscriptions_created ON commerce.subscriptions (created_at DESC);
