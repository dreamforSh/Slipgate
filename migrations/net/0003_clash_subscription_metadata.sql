-- Additive schema metadata for real Clash (mihomo) pool and uTLS fingerprint profiles.
-- Owned exclusively by slipgate-net (Go).

ALTER TABLE net.clash_subscriptions
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'url';

ALTER TABLE net.clash_nodes
    ADD COLUMN IF NOT EXISTS proxy_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS server TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS server_port INTEGER NOT NULL DEFAULT 0;

ALTER TABLE net.tls_profiles
    ADD COLUMN IF NOT EXISTS client_hello_preset TEXT NOT NULL DEFAULT 'chrome_auto',
    ADD COLUMN IF NOT EXISTS built_in BOOLEAN NOT NULL DEFAULT FALSE;
