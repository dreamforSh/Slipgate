-- Lane B1: Multi-dimensional pricing engine & usage dimension tracking.
-- Idempotent DDL (IF NOT EXISTS / guarded ALTERs); the BFF applies the same statements at startup.

CREATE TABLE IF NOT EXISTS core.model_pricing_rules (
    id                               TEXT PRIMARY KEY,
    pattern                          TEXT NOT NULL UNIQUE,
    input_nano_per_mtok              BIGINT NOT NULL DEFAULT 0,
    output_nano_per_mtok             BIGINT NOT NULL DEFAULT 0,
    cache_read_nano_per_mtok         BIGINT NOT NULL DEFAULT 0,
    cache_write_nano_per_mtok        BIGINT NOT NULL DEFAULT 0,
    per_request_nano_usd             BIGINT NOT NULL DEFAULT 0,
    per_image_nano_usd               BIGINT NOT NULL DEFAULT 0,
    per_video_second_nano_usd        BIGINT NOT NULL DEFAULT 0,
    long_context_threshold_tokens    INTEGER NOT NULL DEFAULT 0,
    long_context_input_multiplier    NUMERIC(10, 4) NOT NULL DEFAULT 1.0000,
    long_context_output_multiplier   NUMERIC(10, 4) NOT NULL DEFAULT 1.0000,
    service_tier_fast_multiplier     NUMERIC(10, 4) NOT NULL DEFAULT 2.0000,
    service_tier_flex_multiplier     NUMERIC(10, 4) NOT NULL DEFAULT 0.5000,
    reasoning_effort_multipliers     JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled                          BOOLEAN NOT NULL DEFAULT TRUE,
    notes                            TEXT NOT NULL DEFAULT '',
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE core.usage_logs
    ADD COLUMN IF NOT EXISTS service_tier TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT '';
