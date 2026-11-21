-- Transitional console metadata extensions for core.accounts and core.api_keys.

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'stealth_http'
        CHECK (execution_mode IN ('stealth_http', 'vm_slot', 'direct_api')),
    ADD COLUMN IF NOT EXISTS credential_preview TEXT NOT NULL DEFAULT '';

ALTER TABLE core.api_keys
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'default';
