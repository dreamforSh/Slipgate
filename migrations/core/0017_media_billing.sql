-- Lane M1: Multimodal media billing & async video/media task affinity tracking.
-- Idempotent DDL (IF NOT EXISTS / guarded ALTERs); the BFF applies the same statements at startup.

ALTER TABLE core.usage_logs
    ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS video_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS core.media_tasks (
    id                TEXT PRIMARY KEY,
    upstream_task_id  TEXT NOT NULL DEFAULT '',
    user_id           TEXT NOT NULL DEFAULT '',
    api_key_id        TEXT NOT NULL,
    account_id        TEXT NOT NULL DEFAULT '',
    group_id          TEXT NOT NULL DEFAULT '',
    platform          TEXT NOT NULL DEFAULT '',
    kind              TEXT NOT NULL DEFAULT 'video',
    public_model      TEXT NOT NULL DEFAULT '',
    upstream_model    TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'pending',
    video_seconds     NUMERIC(12, 3) NOT NULL DEFAULT 0,
    image_count       INTEGER NOT NULL DEFAULT 0,
    cost_nano_usd     NUMERIC(39, 0) NOT NULL DEFAULT 0,
    result_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

ALTER TABLE core.media_tasks
    ADD COLUMN IF NOT EXISTS group_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS video_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');

ALTER TABLE core.media_tasks DROP CONSTRAINT IF EXISTS media_tasks_kind_check;

CREATE INDEX IF NOT EXISTS idx_media_tasks_key_expires
    ON core.media_tasks (api_key_id, kind, expires_at DESC);
