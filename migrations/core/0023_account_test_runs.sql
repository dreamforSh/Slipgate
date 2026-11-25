-- Account test history (sub2api "测试结果"): every console, scheduled and automatic account test,
-- any kind (text / image / embedding / speech / transcription / video). The BFF keeps the newest
-- ACCOUNT_TEST_HISTORY_LIMIT (50) rows per account and prunes older ones on insert; media are
-- counted, never stored. Idempotent; the BFF applies the same statements at startup.

CREATE TABLE IF NOT EXISTS core.account_test_runs (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source       TEXT NOT NULL,
    kind         TEXT NOT NULL,
    ok           BOOLEAN NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    status       INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    ttft_ms      INTEGER,
    code         TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL DEFAULT '',
    output       TEXT NOT NULL DEFAULT '',
    media_count  INTEGER NOT NULL DEFAULT 0,
    dimensions   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_core_account_test_runs_account_at
    ON core.account_test_runs (account_id, at DESC);
