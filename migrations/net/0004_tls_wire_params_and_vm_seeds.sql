-- Additive wire-level uTLS ClientHello parameters and VM slot seed / runtime storage.
-- Owned exclusively by slipgate-net (Go). Builds cleanly on top of 0001 + 0002 + 0003.

ALTER TABLE net.tls_profiles
    ADD COLUMN IF NOT EXISTS description          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS enable_grease        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS cipher_suites        JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS curves               JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS point_formats        JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS signature_algorithms JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS supported_versions   JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS key_share_groups     JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS psk_modes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS extensions           JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS os_hint              TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE net.cluster_nodes
    ADD COLUMN IF NOT EXISTS driver_kind          TEXT NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS ssh_user             TEXT NOT NULL DEFAULT 'root',
    ADD COLUMN IF NOT EXISTS ssh_key_enc          BYTEA,
    ADD COLUMN IF NOT EXISTS max_slots            INTEGER NOT NULL DEFAULT 16,
    ADD COLUMN IF NOT EXISTS labels               JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE net.vm_slots
    ADD COLUMN IF NOT EXISTS exit_ip              INET,
    ADD COLUMN IF NOT EXISTS root_dir             TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS guest_pid            INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daemon_version       TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS active_subagents     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_heartbeat_at    TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS net.vm_slot_seeds (
    slot_id                TEXT PRIMARY KEY REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    settings_json_enc      BYTEA NOT NULL,
    custom_setting_enc     BYTEA NOT NULL,
    proxy_env_enc          BYTEA NOT NULL,
    bootstrap_script_enc   BYTEA NOT NULL,
    reject_client_settings BOOLEAN NOT NULL DEFAULT TRUE,
    reject_client_identity BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by             TEXT NOT NULL DEFAULT 'system',
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.vm_terminal_audit (
    id                   BIGSERIAL PRIMARY KEY,
    slot_id              TEXT NOT NULL REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    actor                TEXT NOT NULL DEFAULT 'admin',
    command_preview      TEXT NOT NULL DEFAULT '',
    exit_code            INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_net_vm_terminal_audit_slot
    ON net.vm_terminal_audit (slot_id, created_at DESC);
