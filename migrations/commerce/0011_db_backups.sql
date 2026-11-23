-- Lane S2. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Full database backups to S3-compatible storage: the catalogue of backups (one row per backup,
-- its stored parts, restore state and monthly-archive protection) and the single-row backup
-- configuration (S3 target with the secret AES-GCM encrypted by the BFF vault key, cron schedule,
-- monthly-archive checkpoint). Mirrored by PG_DB_BACKUPS_SCHEMA_SQL
-- (services/bff-ts/src/store/db_backups_postgres.ts).

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.db_backups (
    id                  TEXT PRIMARY KEY,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    backup_type         TEXT NOT NULL DEFAULT 'postgres',
    triggered_by        TEXT NOT NULL CHECK (triggered_by IN ('manual', 'scheduled')),
    created_by          TEXT,
    file_name           TEXT NOT NULL,
    s3_key              TEXT NOT NULL DEFAULT '',
    -- [{ "index": 1, "s3Key": "...", "sizeBytes": 123, "sha256": "..." }]
    parts               JSONB NOT NULL DEFAULT '[]'::jsonb,
    size_bytes          BIGINT NOT NULL DEFAULT 0,
    progress            TEXT NOT NULL DEFAULT '',
    error_message       TEXT NOT NULL DEFAULT '',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    scheduled_for       TIMESTAMPTZ,
    restore_status      TEXT NOT NULL DEFAULT ''
                        CHECK (restore_status IN ('', 'running', 'completed', 'failed')),
    restore_started_at  TIMESTAMPTZ,
    restore_error       TEXT NOT NULL DEFAULT '',
    restored_at         TIMESTAMPTZ,
    restored_by         TEXT,
    -- { "dates": ["2026-11-01"], "retainCount": 12 } once kept as a monthly archive copy.
    monthly_archive     JSONB,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- History listing (newest first) and retention walk.
CREATE INDEX IF NOT EXISTS idx_commerce_db_backups_started
    ON commerce.db_backups (started_at DESC, id DESC);

-- One scheduled backup per cron slot, whichever instance fires first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_db_backups_scheduled_for
    ON commerce.db_backups (scheduled_for) WHERE scheduled_for IS NOT NULL;

-- Interrupted-operation recovery only looks at the few unfinished rows.
CREATE INDEX IF NOT EXISTS idx_commerce_db_backups_unfinished
    ON commerce.db_backups (id) WHERE status IN ('pending', 'running') OR restore_status = 'running';

CREATE TABLE IF NOT EXISTS commerce.db_backup_config (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- { endpoint, region, bucket, accessKeyId, prefix, forcePathStyle } (no secret)
    s3_config           JSONB,
    s3_secret_enc       BYTEA,
    -- BackupSchedule JSON; NULL = defaults (off).
    schedule            JSONB,
    -- Last date (YYYY-MM-DD, schedule time zone) the monthly-archive rule was evaluated for.
    archive_checkpoint  TEXT NOT NULL DEFAULT '',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
