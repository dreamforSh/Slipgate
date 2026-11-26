-- Scheduled account test plans (sub2api "定时测试计划"): an account may have several, each a cron
-- expression in an IANA time zone, a model, a result retention (max_results) and auto-recover.
-- Plan runs land in core.account_test_runs with plan_id set and are pruned per plan; deleting a plan
-- deletes its runs. The BFF claims a due plan (moves next_run_at) before running it. Idempotent;
-- the BFF applies the same statements at startup.

CREATE TABLE IF NOT EXISTS core.account_test_plans (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
    model         TEXT NOT NULL DEFAULT '',
    cron_expr     TEXT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    max_results   INTEGER NOT NULL DEFAULT 50,
    auto_recover  BOOLEAN NOT NULL DEFAULT FALSE,
    last_run_at   TIMESTAMPTZ,
    last_ok       BOOLEAN,
    last_message  TEXT NOT NULL DEFAULT '',
    next_run_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_core_account_test_plans_account
    ON core.account_test_plans (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_core_account_test_plans_due
    ON core.account_test_plans (next_run_at) WHERE enabled;

ALTER TABLE core.account_test_runs
    ADD COLUMN IF NOT EXISTS plan_id TEXT REFERENCES core.account_test_plans(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_core_account_test_runs_plan_at
    ON core.account_test_runs (plan_id, at DESC) WHERE plan_id IS NOT NULL;
