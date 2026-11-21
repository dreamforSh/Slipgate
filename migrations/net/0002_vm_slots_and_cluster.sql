-- Single-Writer Schema: net (owned exclusively by slipgate-net / Go)
-- Manages agentless SSH VPS nodes, VM/container full-emulation slots, immutable hardware personas, and migrations.

CREATE TABLE IF NOT EXISTS net.cluster_nodes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    ssh_addr        TEXT NOT NULL,
    arch            TEXT NOT NULL DEFAULT 'amd64' CHECK (arch IN ('amd64', 'arm64')),
    kvm_capable     BOOLEAN NOT NULL DEFAULT FALSE,
    docker_capable  BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'online',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.vm_slots (
    id              TEXT PRIMARY KEY,
    cluster_node_id TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    account_id      TEXT NOT NULL UNIQUE,
    clash_node_id   TEXT NOT NULL UNIQUE REFERENCES net.clash_nodes(id) ON DELETE RESTRICT,
    hypervisor_kind TEXT NOT NULL CHECK (hypervisor_kind IN ('kvm_qemu', 'docker_hardened', 'macos_native')),
    vsock_cid       INTEGER UNIQUE,
    guest_uds_path  TEXT,
    max_subagents   INTEGER NOT NULL DEFAULT 20 CHECK (max_subagents BETWEEN 1 AND 64),
    telemetry_mode  TEXT NOT NULL DEFAULT 'isolated' CHECK (telemetry_mode IN ('enabled', 'isolated', 'disabled')),
    cleanse_mode    TEXT NOT NULL DEFAULT 'zero' CHECK (cleanse_mode IN ('zero', 'official', 'template')),
    memory_mib      INTEGER NOT NULL DEFAULT 2048 CHECK (memory_mib >= 512),
    state           TEXT NOT NULL DEFAULT 'provisioning',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.vm_hardware_personas (
    slot_id          TEXT PRIMARY KEY REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    guest_machine_id TEXT NOT NULL UNIQUE CHECK (guest_machine_id ~ '^[0-9a-f]{32}$' AND guest_machine_id <> repeat('0', 32)),
    mac_address      TEXT NOT NULL UNIQUE,
    smbios_uuid      TEXT NOT NULL UNIQUE,
    smbios_serial    TEXT NOT NULL,
    cpu_model        TEXT NOT NULL,
    cpu_cores        INTEGER NOT NULL DEFAULT 4 CHECK (cpu_cores >= 1),
    timezone         TEXT NOT NULL DEFAULT 'UTC',
    doh_url          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.vm_migration_jobs (
    id                  TEXT PRIMARY KEY,
    slot_id             TEXT NOT NULL REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    source_node_id      TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    target_node_id      TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    target_memory_mib   INTEGER NOT NULL CHECK (target_memory_mib >= 512),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'draining', 'transferring', 'completed', 'rolled_back', 'failed')),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);
