-- Single-Writer Schema: net (owned exclusively by slipgate-net / Go)

CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE IF NOT EXISTS net.clash_subscriptions (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    source_url_enc      BYTEA NOT NULL,
    user_agent          TEXT NOT NULL DEFAULT 'clash.meta',
    exclude_regex       TEXT NOT NULL DEFAULT '剩余流量|到期时间|官网',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    last_sync_at        TIMESTAMPTZ,
    last_sync_status    TEXT NOT NULL DEFAULT 'pending',
    last_node_count     INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.clash_nodes (
    id                  TEXT PRIMARY KEY,
    subscription_id     TEXT NOT NULL REFERENCES net.clash_subscriptions(id) ON DELETE CASCADE,
    node_name           TEXT NOT NULL,
    proxy_slot_id       TEXT NOT NULL UNIQUE,
    listener_port       INTEGER NOT NULL UNIQUE,
    socks_username      TEXT NOT NULL,
    socks_password_enc  BYTEA NOT NULL,
    raw_config_enc      BYTEA NOT NULL,
    exit_ip             INET,
    latency_ms          INTEGER,
    health_status       TEXT NOT NULL DEFAULT 'unknown',
    consecutive_fails   INTEGER NOT NULL DEFAULT 0,
    consecutive_passes  INTEGER NOT NULL DEFAULT 0,
    drift_unconfirmed   BOOLEAN NOT NULL DEFAULT FALSE,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    last_probed_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_net_clash_nodes_exit_ip
    ON net.clash_nodes (exit_ip, enabled);

CREATE TABLE IF NOT EXISTS net.tls_profiles (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    ja3_fingerprint     TEXT,
    ja4_fingerprint     TEXT,
    alpn_protocols      JSONB NOT NULL DEFAULT '["h2","http/1.1"]'::jsonb,
    h2_settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
    user_agent_template TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.proxy_bindings (
    account_id          TEXT PRIMARY KEY,
    node_id             TEXT NOT NULL REFERENCES net.clash_nodes(id) ON DELETE RESTRICT,
    utls_profile_id     TEXT REFERENCES net.tls_profiles(id) ON DELETE SET NULL,
    is_shadow_follower  BOOLEAN NOT NULL DEFAULT FALSE,
    bound_exit_ip       INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_net_proxy_bindings_node
    ON net.proxy_bindings (node_id);

CREATE TABLE IF NOT EXISTS net.node_traffic_daily (
    node_id             TEXT NOT NULL REFERENCES net.clash_nodes(id) ON DELETE CASCADE,
    stat_date           DATE NOT NULL,
    upload_bytes        BIGINT NOT NULL DEFAULT 0,
    download_bytes      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, stat_date)
);
