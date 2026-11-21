-- Single-Writer Schema: commerce (owned exclusively by slipgate-bff / Bun TS)
-- Stores portal setup wizard flags, site branding, and registration policies.

CREATE TABLE IF NOT EXISTS commerce.portal_settings (
    key         TEXT PRIMARY KEY,
    value_json  JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
