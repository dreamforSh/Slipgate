-- Lane O2. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS commerce.alert_rules (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    metric            TEXT NOT NULL
                      CHECK (metric IN ('error_rate', 'latency_p95', 'account_unhealthy', 'request_errors_count', 'dead_letter_count')),
    operator          TEXT NOT NULL DEFAULT 'gte'
                      CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
    threshold         DOUBLE PRECISION NOT NULL,
    window_minutes    INTEGER NOT NULL DEFAULT 15,
    cooldown_minutes  INTEGER NOT NULL DEFAULT 30,
    severity          TEXT NOT NULL DEFAULT 'warning'
                      CHECK (severity IN ('info', 'warning', 'critical')),
    scope_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    notify_emails     JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by        TEXT NOT NULL DEFAULT '',
    last_evaluated_at TIMESTAMPTZ,
    last_triggered_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce.alert_events (
    id              TEXT PRIMARY KEY,
    rule_id         TEXT NOT NULL REFERENCES commerce.alert_rules(id) ON DELETE CASCADE,
    rule_name       TEXT NOT NULL DEFAULT '',
    metric          TEXT NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status          TEXT NOT NULL DEFAULT 'firing'
                    CHECK (status IN ('firing', 'resolved', 'silenced')),
    observed_value  DOUBLE PRECISION NOT NULL DEFAULT 0,
    threshold       DOUBLE PRECISION NOT NULL DEFAULT 0,
    message         TEXT NOT NULL DEFAULT '',
    details_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    notified        BOOLEAN NOT NULL DEFAULT FALSE,
    notify_error    TEXT NOT NULL DEFAULT '',
    fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    acknowledged_by TEXT NOT NULL DEFAULT '',
    acknowledged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS commerce.alert_silences (
    id         TEXT PRIMARY KEY,
    rule_id    TEXT REFERENCES commerce.alert_rules(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL DEFAULT '',
    starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at    TIMESTAMPTZ NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_alert_events_rule_fired
    ON commerce.alert_events (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_alert_events_status_fired
    ON commerce.alert_events (status, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_alert_silences_ends
    ON commerce.alert_silences (ends_at DESC);
