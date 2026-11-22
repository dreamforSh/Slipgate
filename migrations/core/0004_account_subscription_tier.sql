-- Single-Writer Schema: core (owned by slipgate-core; transitional BFF ControlStore)
-- Adds provider subscription tier taxonomy on core.accounts:
--   Codex:  plus (1x), pro_5x (5x), pro_10x (10x), pro_25x (25x)
--   Claude: pro (1x), max (5x), ultra (20x)

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'standard'
        CHECK (subscription_tier IN ('standard', 'plus', 'pro', 'pro_5x', 'pro_10x', 'pro_25x', 'max', 'ultra'));
