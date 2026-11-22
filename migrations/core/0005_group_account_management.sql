-- Single-Writer Schema: core (transitional BFF ControlStore)
-- Group management: description, exclusive flag (admin-only key binding) and display order.
-- Account management: free-form notes and the outcome of the most recent admin connectivity test.

ALTER TABLE core.groups
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN,
    ADD COLUMN IF NOT EXISTS last_test_model TEXT,
    ADD COLUMN IF NOT EXISTS last_test_duration_ms INTEGER,
    ADD COLUMN IF NOT EXISTS last_test_message TEXT;
