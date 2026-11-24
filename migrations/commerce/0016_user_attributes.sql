-- Lane A4: user custom attributes, scoped group managers, and dedicated admin API keys.

ALTER TABLE commerce.users
    ADD COLUMN IF NOT EXISTS managed_group_ids TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE TABLE IF NOT EXISTS commerce.user_attribute_definitions (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL CHECK (type IN ('text', 'number', 'select', 'multiselect', 'date', 'url')),
    options     TEXT[] NOT NULL DEFAULT '{}'::text[],
    required    BOOLEAN NOT NULL DEFAULT FALSE,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_user_attr_defs_order
    ON commerce.user_attribute_definitions (sort_order, created_at);

CREATE TABLE IF NOT EXISTS commerce.user_attribute_values (
    user_id      TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    attribute_id TEXT NOT NULL REFERENCES commerce.user_attribute_definitions(id) ON DELETE CASCADE,
    value        TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_user_attr_vals_attr
    ON commerce.user_attribute_values (attribute_id);

CREATE TABLE IF NOT EXISTS commerce.admin_api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_admin_api_keys_user
    ON commerce.admin_api_keys (user_id, created_at DESC);
