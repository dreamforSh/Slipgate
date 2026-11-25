-- Per-account temporary-unschedulable rules: [{statusCode, keywords, durationMinutes, description}].
-- slipgate-net puts the account into cooldown when an upstream error matches one of them.
-- Idempotent; the BFF applies the same statement at startup.

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS temp_unsched_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
