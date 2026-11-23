-- Lane M1: Multimodal media billing & async video/media task affinity tracking.
-- Idempotent DDL (IF NOT EXISTS / guarded ALTERs); the BFF applies the same statements at startup.

ALTER TABLE core.usage_logs
    ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS video_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS core.media_tasks (
    id                TEXT PRIMARY KEY,
    api_key_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    provider          TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'video',
    upstream_task_id  TEXT NOT NULL,
    public_model      TEXT NOT NULL DEFAULT '',
    upstream_model    TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'pending',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_media_tasks_key_expires
    ON core.media_tasks (api_key_id, expires_at DESC);
