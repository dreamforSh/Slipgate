-- Lane O6. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Announcement targeting conditions and audit-log retention. Mirrored by
-- PG_ANNOUNCEMENT_TARGETING_SCHEMA_SQL (services/bff-ts/src/store/postgres_announcements.ts).

-- { "anyOf": [ { "allOf": [ { "type": "subscription", "operator": "in", "groupIds": [...] },
--                           { "type": "balance", "operator": "gt|gte|lt|lte|eq", "valueNanoUsd": "..." } ] } ] }
-- OR across groups, AND inside a group; '{}' (every existing row) = no restriction.
ALTER TABLE commerce.announcements
    ADD COLUMN IF NOT EXISTS targeting JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Read status pages every account against one announcement: (announcement_id, user_id) is the
-- primary key of commerce.announcement_reads, so the per-user LEFT JOIN is an index probe.

-- The retention sweeper deletes the oldest rows in batches by created_at (0003 creates this
-- index; re-asserted for databases that skipped it).
DO $$
BEGIN
    IF to_regclass('commerce.audit_logs') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_commerce_audit_logs_created ON commerce.audit_logs (created_at DESC);
    END IF;
END
$$;
