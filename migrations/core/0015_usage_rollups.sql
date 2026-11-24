-- Lane O4. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.usage_rollups_hourly (
    bucket_start       TIMESTAMPTZ NOT NULL,
    user_id            TEXT NOT NULL,
    group_id           TEXT NOT NULL,
    platform           TEXT NOT NULL,
    public_model       TEXT NOT NULL,
    account_id         TEXT NOT NULL,
    requests           BIGINT NOT NULL DEFAULT 0,
    errors             BIGINT NOT NULL DEFAULT 0,
    input_tokens       BIGINT NOT NULL DEFAULT 0,
    output_tokens      BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    cost_nano_usd      NUMERIC(39, 0) NOT NULL DEFAULT 0,
    duration_sum_ms    BIGINT NOT NULL DEFAULT 0,
    duration_count     BIGINT NOT NULL DEFAULT 0,
    ttft_sum_ms        BIGINT NOT NULL DEFAULT 0,
    ttft_count         BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_start, user_id, group_id, platform, public_model, account_id)
);

CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_hourly_bucket
    ON core.usage_rollups_hourly (bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_hourly_user
    ON core.usage_rollups_hourly (user_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS core.usage_rollups_daily (
    bucket_date        DATE NOT NULL,
    user_id            TEXT NOT NULL,
    group_id           TEXT NOT NULL,
    platform           TEXT NOT NULL,
    public_model       TEXT NOT NULL,
    account_id         TEXT NOT NULL,
    requests           BIGINT NOT NULL DEFAULT 0,
    errors             BIGINT NOT NULL DEFAULT 0,
    input_tokens       BIGINT NOT NULL DEFAULT 0,
    output_tokens      BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    cost_nano_usd      NUMERIC(39, 0) NOT NULL DEFAULT 0,
    duration_sum_ms    BIGINT NOT NULL DEFAULT 0,
    duration_count     BIGINT NOT NULL DEFAULT 0,
    ttft_sum_ms        BIGINT NOT NULL DEFAULT 0,
    ttft_count         BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_date, user_id, group_id, platform, public_model, account_id)
);

CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_daily_date
    ON core.usage_rollups_daily (bucket_date DESC);
CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_daily_user
    ON core.usage_rollups_daily (user_id, bucket_date DESC);

CREATE TABLE IF NOT EXISTS core.usage_rollup_state (
    id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_hourly_at       TIMESTAMPTZ,
    last_daily_at        TIMESTAMPTZ,
    last_cleanup_at      TIMESTAMPTZ,
    last_cleanup_deleted INTEGER NOT NULL DEFAULT 0,
    usage_retention_days INTEGER NOT NULL DEFAULT 90,
    rollup_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
