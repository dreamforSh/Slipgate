package vmslot

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

var (
	ErrClusterNodeNotFound  = errors.New("vmslot: cluster node not found")
	ErrClusterNodeProtected = errors.New("vmslot: protected or busy cluster node cannot be deleted")
	ErrSeedNotFound         = errors.New("vmslot: slot seed not found")
)

// ClusterNode describes a local or remote agentless-SSH hypervisor host.
type ClusterNode struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DriverKind string `json:"driverKind"` // "local" | "ssh"
	SSHAddr    string `json:"sshAddr"`
	SSHUser    string `json:"sshUser"`
	SSHKeyPEM  string `json:"sshKeyPem,omitempty"`
	HasSSHKey  bool   `json:"hasSSHKey"`
	// SSHHostKey is the pinned server host key ("<type> <base64>"): admin-supplied or recorded
	// on first connect. Empty means the next connection pins whatever the server presents.
	SSHHostKey            string            `json:"sshHostKey,omitempty"`
	SSHHostKeyFingerprint string            `json:"sshHostKeyFingerprint,omitempty"`
	Arch                  string            `json:"arch"`
	KVMCapable            bool              `json:"kvmCapable"`
	DockerCapable         bool              `json:"dockerCapable"`
	Status                string            `json:"status"`
	MaxSlots              int               `json:"maxSlots"`
	Labels                map[string]string `json:"labels,omitempty"`
	CreatedAt             time.Time         `json:"createdAtIso"`
	UpdatedAt             time.Time         `json:"updatedAtIso"`
}

// SlotSeed holds sanitized environment, settings, auth JSON, and bootstrap scripts synced into a VM slot.
type SlotSeed struct {
	SlotID                 string         `json:"slotId"`
	RuntimeProfile         RuntimeProfile `json:"runtimeProfile"`
	SettingsJSONRaw        string         `json:"settingsJsonRaw"`
	CustomSettingRaw       string         `json:"customSettingRaw"`
	AuthJSONRaw            string         `json:"authJsonRaw,omitempty"`
	RejectClientSettings   bool           `json:"rejectClientSettings"`
	RejectClientIdentity   bool           `json:"rejectClientIdentity"`
	TelemetryMode          TelemetryMode  `json:"telemetryMode"`
	TelemetryDaemonRunning bool           `json:"telemetryDaemonRunning"`
	ProxyEnvRaw            string         `json:"proxyEnvRaw,omitempty"`
	BootstrapScriptRaw     string         `json:"bootstrapScriptRaw,omitempty"`
	SyncedAtUnixMs         int64          `json:"syncedAtUnixMs"`
}

// MigrationJob records one KVM slot cluster migration or memory resize event.
type MigrationJob struct {
	ID              string     `json:"id"`
	SlotID          string     `json:"slotId"`
	SourceNodeID    string     `json:"sourceNodeId"`
	TargetNodeID    string     `json:"targetNodeId"`
	TargetMemoryMiB uint32     `json:"targetMemoryMiB"`
	Status          string     `json:"status"`
	ErrorMessage    string     `json:"errorMessage,omitempty"`
	CreatedAt       time.Time  `json:"createdAtIso"`
	CompletedAt     *time.Time `json:"completedAtIso,omitempty"`
}

// TerminalAuditEntry captures diagnostic terminal invocations executed on a slot.
type TerminalAuditEntry struct {
	ID             int64     `json:"id"`
	SlotID         string    `json:"slotId"`
	Actor          string    `json:"actor"`
	CommandPreview string    `json:"commandPreview"`
	ExitCode       int       `json:"exitCode"`
	CreatedAt      time.Time `json:"createdAtIso"`
}

// VmStore persists cluster hosts, VM slots, hardware personas, encrypted seeds, and audit trails.
type VmStore interface {
	Init(ctx context.Context) error
	ListClusterNodes(ctx context.Context) ([]ClusterNode, error)
	GetClusterNode(ctx context.Context, nodeID string) (ClusterNode, error)
	UpsertClusterNode(ctx context.Context, node ClusterNode) error
	// PinClusterNodeHostKey stores hostKey only if the node has none yet and returns the key
	// that is pinned afterwards (the earlier one when another caller won the race).
	PinClusterNodeHostKey(ctx context.Context, nodeID, hostKey string) (string, error)
	DeleteClusterNode(ctx context.Context, nodeID string) error
	ListSlots(ctx context.Context) ([]Slot, error)
	UpsertSlot(ctx context.Context, slot Slot) error
	DeleteSlot(ctx context.Context, slotID string) error
	GetSeed(ctx context.Context, slotID string) (SlotSeed, error)
	UpsertSeed(ctx context.Context, seed SlotSeed, updatedBy string) error
	ListMigrations(ctx context.Context) ([]MigrationJob, error)
	RecordMigration(ctx context.Context, job MigrationJob) error
	RecordTerminalAudit(ctx context.Context, entry TerminalAuditEntry) error
	ListTerminalAudit(ctx context.Context, slotID string, limit int) ([]TerminalAuditEntry, error)
	Close() error
}

// MemoryVmStore is a thread-safe in-memory VmStore for standalone single-binary and unit tests.
type MemoryVmStore struct {
	mu         sync.RWMutex
	nodes      map[string]ClusterNode
	slots      map[string]Slot
	seeds      map[string]SlotSeed
	migrations []MigrationJob
	audits     []TerminalAuditEntry
	nextAudit  int64
}

func NewMemoryVmStore() *MemoryVmStore {
	return &MemoryVmStore{
		nodes: make(map[string]ClusterNode),
		slots: make(map[string]Slot),
		seeds: make(map[string]SlotSeed),
	}
}

func (m *MemoryVmStore) Init(context.Context) error { return nil }
func (m *MemoryVmStore) Close() error               { return nil }

func (m *MemoryVmStore) ListClusterNodes(context.Context) ([]ClusterNode, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]ClusterNode, 0, len(m.nodes))
	for _, n := range m.nodes {
		out = append(out, cloneClusterNode(n))
	}
	slices.SortFunc(out, func(a, b ClusterNode) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (m *MemoryVmStore) GetClusterNode(_ context.Context, nodeID string) (ClusterNode, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n, ok := m.nodes[nodeID]
	if !ok {
		return ClusterNode{}, ErrClusterNodeNotFound
	}
	return cloneClusterNode(n), nil
}

func (m *MemoryVmStore) UpsertClusterNode(_ context.Context, node ClusterNode) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	if node.CreatedAt.IsZero() {
		if existing, ok := m.nodes[node.ID]; ok {
			node.CreatedAt = existing.CreatedAt
		} else {
			node.CreatedAt = now
		}
	}
	node.UpdatedAt = now
	if node.SSHKeyPEM != "" {
		node.HasSSHKey = true
	}
	node.SSHHostKeyFingerprint = SSHHostKeyFingerprint(node.SSHHostKey)
	m.nodes[node.ID] = cloneClusterNode(node)
	return nil
}

func (m *MemoryVmStore) PinClusterNodeHostKey(_ context.Context, nodeID, hostKey string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	node, ok := m.nodes[nodeID]
	if !ok {
		return "", ErrClusterNodeNotFound
	}
	if node.SSHHostKey == "" {
		node.SSHHostKey = hostKey
		node.SSHHostKeyFingerprint = SSHHostKeyFingerprint(hostKey)
		node.UpdatedAt = time.Now().UTC()
		m.nodes[nodeID] = node
	}
	return node.SSHHostKey, nil
}

func (m *MemoryVmStore) DeleteClusterNode(_ context.Context, nodeID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.nodes[nodeID]; !ok {
		return ErrClusterNodeNotFound
	}
	delete(m.nodes, nodeID)
	return nil
}

func (m *MemoryVmStore) ListSlots(context.Context) ([]Slot, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Slot, 0, len(m.slots))
	for _, s := range m.slots {
		out = append(out, cloneSlot(s))
	}
	slices.SortFunc(out, func(a, b Slot) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (m *MemoryVmStore) UpsertSlot(_ context.Context, slot Slot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.slots[slot.ID] = cloneSlot(slot)
	return nil
}

func (m *MemoryVmStore) DeleteSlot(_ context.Context, slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.slots[slotID]; !ok {
		return ErrSlotNotFound
	}
	delete(m.slots, slotID)
	delete(m.seeds, slotID)
	return nil
}

func (m *MemoryVmStore) GetSeed(_ context.Context, slotID string) (SlotSeed, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.seeds[slotID]
	if !ok {
		return SlotSeed{}, ErrSeedNotFound
	}
	return s, nil
}

func (m *MemoryVmStore) UpsertSeed(_ context.Context, seed SlotSeed, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if seed.SyncedAtUnixMs == 0 {
		seed.SyncedAtUnixMs = time.Now().UTC().UnixMilli()
	}
	m.seeds[seed.SlotID] = seed
	return nil
}

func (m *MemoryVmStore) ListMigrations(context.Context) ([]MigrationJob, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]MigrationJob, len(m.migrations))
	copy(out, m.migrations)
	return out, nil
}

func (m *MemoryVmStore) RecordMigration(_ context.Context, job MigrationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.migrations = append([]MigrationJob{job}, m.migrations...)
	if len(m.migrations) > 100 {
		m.migrations = m.migrations[:100]
	}
	return nil
}

func (m *MemoryVmStore) RecordTerminalAudit(_ context.Context, entry TerminalAuditEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextAudit++
	entry.ID = m.nextAudit
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}
	m.audits = append(m.audits, entry)
	if len(m.audits) > 200 {
		m.audits = m.audits[len(m.audits)-200:]
	}
	return nil
}

func (m *MemoryVmStore) ListTerminalAudit(_ context.Context, slotID string, limit int) ([]TerminalAuditEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 {
		limit = 20
	}
	out := make([]TerminalAuditEntry, 0, limit)
	for i := len(m.audits) - 1; i >= 0 && len(out) < limit; i-- {
		if m.audits[i].SlotID == slotID {
			out = append(out, m.audits[i])
		}
	}
	return out, nil
}

// PostgresVmStore persists net.cluster_nodes, net.vm_slots, net.vm_hardware_personas, net.vm_slot_seeds, and audits in PostgreSQL.
type PostgresVmStore struct {
	db    *sql.DB
	vault *vmVaultCipher
}

func NewPostgresVmStore(dsn, vaultSecret string) (*PostgresVmStore, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("vmslot: empty PostgreSQL DSN")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("vmslot: open postgres: %w", err)
	}
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(15 * time.Minute)
	return &PostgresVmStore{
		db:    db,
		vault: newVmVaultCipher(vaultSecret),
	}, nil
}

func (p *PostgresVmStore) Close() error {
	if p.db != nil {
		return p.db.Close()
	}
	return nil
}

func (p *PostgresVmStore) Init(ctx context.Context) error {
	if err := p.db.PingContext(ctx); err != nil {
		return fmt.Errorf("vmslot: postgres ping failed: %w", err)
	}
	ddl := `
CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE IF NOT EXISTS net.cluster_nodes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    ssh_addr        TEXT NOT NULL,
    arch            TEXT NOT NULL DEFAULT 'amd64',
    kvm_capable     BOOLEAN NOT NULL DEFAULT FALSE,
    docker_capable  BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'online',
    driver_kind     TEXT NOT NULL DEFAULT 'local',
    ssh_user        TEXT NOT NULL DEFAULT 'root',
    ssh_key_enc     BYTEA,
    ssh_host_key    TEXT NOT NULL DEFAULT '',
    max_slots       INTEGER NOT NULL DEFAULT 16,
    labels          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE net.cluster_nodes
    ADD COLUMN IF NOT EXISTS driver_kind TEXT NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS ssh_user TEXT NOT NULL DEFAULT 'root',
    ADD COLUMN IF NOT EXISTS ssh_key_enc BYTEA,
    ADD COLUMN IF NOT EXISTS ssh_host_key TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS max_slots INTEGER NOT NULL DEFAULT 16,
    ADD COLUMN IF NOT EXISTS labels JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS net.vm_slots (
    id                TEXT PRIMARY KEY,
    cluster_node_id   TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    account_id        TEXT NOT NULL UNIQUE,
    clash_node_id     TEXT NOT NULL UNIQUE REFERENCES net.clash_nodes(id) ON DELETE RESTRICT,
    runtime_profile   TEXT NOT NULL DEFAULT 'claude_code',
    hypervisor_kind   TEXT NOT NULL,
    vsock_cid         INTEGER UNIQUE,
    guest_uds_path    TEXT,
    max_subagents     INTEGER NOT NULL DEFAULT 20,
    telemetry_mode    TEXT NOT NULL DEFAULT 'isolated',
    cleanse_mode      TEXT NOT NULL DEFAULT 'zero',
    memory_mib        INTEGER NOT NULL DEFAULT 2048,
    state             TEXT NOT NULL DEFAULT 'provisioning',
    exit_ip           INET,
    root_dir          TEXT NOT NULL DEFAULT '',
    guest_pid         INTEGER NOT NULL DEFAULT 0,
    daemon_version    TEXT NOT NULL DEFAULT '',
    active_subagents  INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE net.vm_slots
    ADD COLUMN IF NOT EXISTS runtime_profile TEXT NOT NULL DEFAULT 'claude_code',
    ADD COLUMN IF NOT EXISTS exit_ip INET,
    ADD COLUMN IF NOT EXISTS root_dir TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS guest_pid INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daemon_version TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS active_subagents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS net.vm_hardware_personas (
    slot_id          TEXT PRIMARY KEY REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    guest_machine_id TEXT NOT NULL UNIQUE,
    mac_address      TEXT NOT NULL UNIQUE,
    smbios_uuid      TEXT NOT NULL UNIQUE,
    smbios_serial    TEXT NOT NULL,
    cpu_model        TEXT NOT NULL,
    cpu_cores        INTEGER NOT NULL DEFAULT 4,
    timezone         TEXT NOT NULL DEFAULT 'UTC',
    doh_url          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.vm_slot_seeds (
    slot_id                TEXT PRIMARY KEY REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    settings_json_enc      BYTEA NOT NULL,
    custom_setting_enc     BYTEA NOT NULL,
    auth_json_enc          BYTEA,
    proxy_env_enc          BYTEA NOT NULL,
    bootstrap_script_enc   BYTEA NOT NULL,
    reject_client_settings BOOLEAN NOT NULL DEFAULT TRUE,
    reject_client_identity BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by             TEXT NOT NULL DEFAULT 'system',
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE net.vm_slot_seeds
    ADD COLUMN IF NOT EXISTS auth_json_enc BYTEA;

CREATE TABLE IF NOT EXISTS net.vm_migration_jobs (
    id                TEXT PRIMARY KEY,
    slot_id           TEXT NOT NULL REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    source_node_id    TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    target_node_id    TEXT NOT NULL REFERENCES net.cluster_nodes(id) ON DELETE RESTRICT,
    target_memory_mib INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS net.vm_terminal_audit (
    id              BIGSERIAL PRIMARY KEY,
    slot_id         TEXT NOT NULL REFERENCES net.vm_slots(id) ON DELETE CASCADE,
    actor           TEXT NOT NULL DEFAULT 'admin',
    command_preview TEXT NOT NULL DEFAULT '',
    exit_code       INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`
	if _, err := p.db.ExecContext(ctx, ddl); err != nil {
		return fmt.Errorf("vmslot: init postgres schema: %w", err)
	}
	return nil
}

func (p *PostgresVmStore) ListClusterNodes(ctx context.Context) ([]ClusterNode, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, name, driver_kind, ssh_addr, ssh_user, ssh_key_enc, ssh_host_key,
		       arch, kvm_capable, docker_capable, status, max_slots, labels,
		       created_at, updated_at
		FROM net.cluster_nodes
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ClusterNode
	for rows.Next() {
		var (
			n         ClusterNode
			keyEnc    []byte
			labelsRaw []byte
		)
		if err := rows.Scan(
			&n.ID, &n.Name, &n.DriverKind, &n.SSHAddr, &n.SSHUser, &keyEnc, &n.SSHHostKey,
			&n.Arch, &n.KVMCapable, &n.DockerCapable, &n.Status, &n.MaxSlots, &labelsRaw,
			&n.CreatedAt, &n.UpdatedAt,
		); err != nil {
			return nil, err
		}
		n.SSHHostKeyFingerprint = SSHHostKeyFingerprint(n.SSHHostKey)
		if len(keyEnc) > 0 {
			n.HasSSHKey = true
			if plain, decErr := p.vault.decrypt(keyEnc); decErr == nil {
				n.SSHKeyPEM = string(plain)
			}
		}
		if len(labelsRaw) > 0 {
			_ = json.Unmarshal(labelsRaw, &n.Labels)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (p *PostgresVmStore) GetClusterNode(ctx context.Context, nodeID string) (ClusterNode, error) {
	nodes, err := p.ListClusterNodes(ctx)
	if err != nil {
		return ClusterNode{}, err
	}
	for _, n := range nodes {
		if n.ID == nodeID {
			return n, nil
		}
	}
	return ClusterNode{}, ErrClusterNodeNotFound
}

func (p *PostgresVmStore) UpsertClusterNode(ctx context.Context, node ClusterNode) error {
	var keyEnc []byte
	if node.SSHKeyPEM != "" {
		enc, err := p.vault.encrypt([]byte(node.SSHKeyPEM))
		if err != nil {
			return err
		}
		keyEnc = enc
	}
	labelsJSON := "{}"
	if len(node.Labels) > 0 {
		b, err := json.Marshal(node.Labels)
		if err != nil {
			return err
		}
		labelsJSON = string(b)
	}
	if node.MaxSlots <= 0 {
		node.MaxSlots = 16
	}
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO net.cluster_nodes (
			id, name, driver_kind, ssh_addr, ssh_user, ssh_key_enc, ssh_host_key,
			arch, kvm_capable, docker_capable, status, max_slots, labels, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $13, $7, $8, $9, $10, $11, $12::jsonb, NOW())
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			driver_kind = EXCLUDED.driver_kind,
			ssh_addr = EXCLUDED.ssh_addr,
			ssh_user = EXCLUDED.ssh_user,
			ssh_key_enc = COALESCE(EXCLUDED.ssh_key_enc, net.cluster_nodes.ssh_key_enc),
			ssh_host_key = EXCLUDED.ssh_host_key,
			arch = EXCLUDED.arch,
			kvm_capable = EXCLUDED.kvm_capable,
			docker_capable = EXCLUDED.docker_capable,
			status = EXCLUDED.status,
			max_slots = EXCLUDED.max_slots,
			labels = EXCLUDED.labels,
			updated_at = NOW()
	`,
		node.ID, node.Name, node.DriverKind, node.SSHAddr, node.SSHUser, keyEnc,
		node.Arch, node.KVMCapable, node.DockerCapable, node.Status, node.MaxSlots, labelsJSON,
		node.SSHHostKey,
	)
	return err
}

func (p *PostgresVmStore) PinClusterNodeHostKey(ctx context.Context, nodeID, hostKey string) (string, error) {
	if _, err := p.db.ExecContext(ctx, `
		UPDATE net.cluster_nodes
		SET ssh_host_key = $2, updated_at = NOW()
		WHERE id = $1 AND ssh_host_key = ''
	`, nodeID, hostKey); err != nil {
		return "", err
	}
	var pinned string
	err := p.db.QueryRowContext(ctx, `SELECT ssh_host_key FROM net.cluster_nodes WHERE id = $1`, nodeID).Scan(&pinned)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrClusterNodeNotFound
	}
	return pinned, err
}

func (p *PostgresVmStore) DeleteClusterNode(ctx context.Context, nodeID string) error {
	res, err := p.db.ExecContext(ctx, `DELETE FROM net.cluster_nodes WHERE id = $1`, nodeID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrClusterNodeNotFound
	}
	return nil
}

func (p *PostgresVmStore) ListSlots(ctx context.Context) ([]Slot, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT s.id, s.cluster_node_id, s.account_id, s.clash_node_id,
		       COALESCE(host(s.exit_ip), ''), COALESCE(s.runtime_profile, 'claude_code'),
		       s.hypervisor_kind, s.state,
		       COALESCE(s.vsock_cid, 0), COALESCE(s.guest_uds_path, ''),
		       s.active_subagents, s.max_subagents, s.telemetry_mode, s.cleanse_mode,
		       s.memory_mib, s.root_dir, s.guest_pid, s.daemon_version,
		       s.last_heartbeat_at, s.created_at, s.updated_at,
		       p.guest_machine_id, p.mac_address, p.smbios_uuid, p.smbios_serial,
		       p.cpu_model, p.cpu_cores, p.timezone, COALESCE(p.doh_url, '')
		FROM net.vm_slots s
		JOIN net.vm_hardware_personas p ON p.slot_id = s.id
		ORDER BY s.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Slot
	for rows.Next() {
		var (
			s              Slot
			rp, hv, st, tm string
			vsock          int
			hb             sql.NullTime
		)
		if err := rows.Scan(
			&s.ID, &s.ClusterNodeID, &s.AccountID, &s.ClashNodeID,
			&s.ExitIP, &rp, &hv, &st, &vsock, &s.GuestUDSPath,
			&s.ActiveSubagents, &s.MaxSubagents, &tm, &s.CleanseMode,
			&s.MemoryMiB, &s.RootDir, &s.GuestPID, &s.DaemonVersion,
			&hb, &s.CreatedAt, &s.UpdatedAt,
			&s.Persona.GuestMachineID, &s.Persona.MACAddress, &s.Persona.SMBIOSUUID, &s.Persona.SMBIOSSerial,
			&s.Persona.CPUModel, &s.Persona.CPUCores, &s.Persona.Timezone, &s.Persona.DoHURL,
		); err != nil {
			return nil, err
		}
		s.RuntimeProfile = RuntimeProfile(rp)
		s.Hypervisor = HypervisorKind(hv)
		s.State = SlotState(st)
		s.Telemetry = TelemetryMode(tm)
		s.VsockCID = uint32(max(0, vsock))
		if hb.Valid {
			t := hb.Time.UTC()
			s.LastHeartbeat = &t
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PostgresVmStore) UpsertSlot(ctx context.Context, s Slot) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var vsockArg any
	if s.VsockCID > 0 {
		vsockArg = int(s.VsockCID)
	}
	var hbArg any
	if s.LastHeartbeat != nil {
		hbArg = *s.LastHeartbeat
	}
	rpStr := string(s.RuntimeProfile)
	if rpStr == "" {
		rpStr = string(RuntimeClaudeCode)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO net.vm_slots (
			id, cluster_node_id, account_id, clash_node_id, exit_ip, runtime_profile, hypervisor_kind,
			vsock_cid, guest_uds_path, active_subagents, max_subagents,
			telemetry_mode, cleanse_mode, memory_mib, state,
			root_dir, guest_pid, daemon_version, last_heartbeat_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, $11,
			$12, $13, $14, $15, $16, $17, $18, $19, NOW()
		)
		ON CONFLICT (id) DO UPDATE SET
			cluster_node_id = EXCLUDED.cluster_node_id,
			exit_ip = EXCLUDED.exit_ip,
			runtime_profile = EXCLUDED.runtime_profile,
			hypervisor_kind = EXCLUDED.hypervisor_kind,
			vsock_cid = EXCLUDED.vsock_cid,
			guest_uds_path = EXCLUDED.guest_uds_path,
			active_subagents = EXCLUDED.active_subagents,
			max_subagents = EXCLUDED.max_subagents,
			telemetry_mode = EXCLUDED.telemetry_mode,
			cleanse_mode = EXCLUDED.cleanse_mode,
			memory_mib = EXCLUDED.memory_mib,
			state = EXCLUDED.state,
			root_dir = EXCLUDED.root_dir,
			guest_pid = EXCLUDED.guest_pid,
			daemon_version = EXCLUDED.daemon_version,
			last_heartbeat_at = EXCLUDED.last_heartbeat_at,
			updated_at = NOW()
	`,
		s.ID, s.ClusterNodeID, s.AccountID, s.ClashNodeID, nullInet(s.ExitIP), rpStr, string(s.Hypervisor),
		vsockArg, s.GuestUDSPath, s.ActiveSubagents, s.MaxSubagents,
		string(s.Telemetry), s.CleanseMode, s.MemoryMiB, string(s.State),
		s.RootDir, s.GuestPID, s.DaemonVersion, hbArg,
	); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO net.vm_hardware_personas (
			slot_id, guest_machine_id, mac_address, smbios_uuid, smbios_serial,
			cpu_model, cpu_cores, timezone, doh_url
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''))
		ON CONFLICT (slot_id) DO NOTHING
	`,
		s.ID, s.Persona.GuestMachineID, s.Persona.MACAddress, s.Persona.SMBIOSUUID, s.Persona.SMBIOSSerial,
		s.Persona.CPUModel, s.Persona.CPUCores, s.Persona.Timezone, s.Persona.DoHURL,
	); err != nil {
		return err
	}

	return tx.Commit()
}

func (p *PostgresVmStore) DeleteSlot(ctx context.Context, slotID string) error {
	res, err := p.db.ExecContext(ctx, `DELETE FROM net.vm_slots WHERE id = $1`, slotID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrSlotNotFound
	}
	return nil
}

func (p *PostgresVmStore) GetSeed(ctx context.Context, slotID string) (SlotSeed, error) {
	var (
		out                    SlotSeed
		settingsEnc, customEnc []byte
		authEnc                []byte
		proxyEnc, bootstrapEnc []byte
		rp, tm                 string
		updatedAt              time.Time
	)
	err := p.db.QueryRowContext(ctx, `
		SELECT sd.slot_id, sd.settings_json_enc, sd.custom_setting_enc,
		       sd.auth_json_enc, sd.proxy_env_enc, sd.bootstrap_script_enc,
		       sd.reject_client_settings, sd.reject_client_identity,
		       COALESCE(sl.runtime_profile, 'claude_code'), sl.telemetry_mode, sd.updated_at
		FROM net.vm_slot_seeds sd
		JOIN net.vm_slots sl ON sl.id = sd.slot_id
		WHERE sd.slot_id = $1
	`, slotID).Scan(
		&out.SlotID, &settingsEnc, &customEnc, &authEnc, &proxyEnc, &bootstrapEnc,
		&out.RejectClientSettings, &out.RejectClientIdentity, &rp, &tm, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return SlotSeed{}, ErrSeedNotFound
	}
	if err != nil {
		return SlotSeed{}, err
	}
	out.RuntimeProfile = RuntimeProfile(rp)
	out.TelemetryMode = TelemetryMode(tm)
	out.TelemetryDaemonRunning = out.TelemetryMode == TelemetryIsolated
	out.SyncedAtUnixMs = updatedAt.UTC().UnixMilli()
	if plain, decErr := p.vault.decrypt(settingsEnc); decErr == nil {
		out.SettingsJSONRaw = string(plain)
	}
	if plain, decErr := p.vault.decrypt(customEnc); decErr == nil {
		out.CustomSettingRaw = string(plain)
	}
	if len(authEnc) > 0 {
		if plain, decErr := p.vault.decrypt(authEnc); decErr == nil {
			out.AuthJSONRaw = string(plain)
		}
	}
	if plain, decErr := p.vault.decrypt(proxyEnc); decErr == nil {
		out.ProxyEnvRaw = string(plain)
	}
	if plain, decErr := p.vault.decrypt(bootstrapEnc); decErr == nil {
		out.BootstrapScriptRaw = string(plain)
	}
	return out, nil
}

func (p *PostgresVmStore) UpsertSeed(ctx context.Context, seed SlotSeed, updatedBy string) error {
	settingsEnc, err := p.vault.encrypt([]byte(seed.SettingsJSONRaw))
	if err != nil {
		return err
	}
	customEnc, err := p.vault.encrypt([]byte(seed.CustomSettingRaw))
	if err != nil {
		return err
	}
	var authEnc []byte
	if seed.AuthJSONRaw != "" {
		authEnc, err = p.vault.encrypt([]byte(seed.AuthJSONRaw))
		if err != nil {
			return err
		}
	}
	proxyEnc, err := p.vault.encrypt([]byte(seed.ProxyEnvRaw))
	if err != nil {
		return err
	}
	bootstrapEnc, err := p.vault.encrypt([]byte(seed.BootstrapScriptRaw))
	if err != nil {
		return err
	}
	if strings.TrimSpace(updatedBy) == "" {
		updatedBy = "system"
	}
	_, err = p.db.ExecContext(ctx, `
		INSERT INTO net.vm_slot_seeds (
			slot_id, settings_json_enc, custom_setting_enc, auth_json_enc, proxy_env_enc, bootstrap_script_enc,
			reject_client_settings, reject_client_identity, updated_by, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
		ON CONFLICT (slot_id) DO UPDATE SET
			settings_json_enc = EXCLUDED.settings_json_enc,
			custom_setting_enc = EXCLUDED.custom_setting_enc,
			auth_json_enc = COALESCE(EXCLUDED.auth_json_enc, net.vm_slot_seeds.auth_json_enc),
			proxy_env_enc = EXCLUDED.proxy_env_enc,
			bootstrap_script_enc = EXCLUDED.bootstrap_script_enc,
			reject_client_settings = EXCLUDED.reject_client_settings,
			reject_client_identity = EXCLUDED.reject_client_identity,
			updated_by = EXCLUDED.updated_by,
			updated_at = NOW()
	`,
		seed.SlotID, settingsEnc, customEnc, authEnc, proxyEnc, bootstrapEnc,
		seed.RejectClientSettings, seed.RejectClientIdentity, updatedBy,
	)
	return err
}

func (p *PostgresVmStore) ListMigrations(ctx context.Context) ([]MigrationJob, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, slot_id, source_node_id, target_node_id, target_memory_mib,
		       status, COALESCE(error_message, ''), created_at, completed_at
		FROM net.vm_migration_jobs
		ORDER BY created_at DESC
		LIMIT 100
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MigrationJob
	for rows.Next() {
		var (
			j         MigrationJob
			completed sql.NullTime
		)
		if err := rows.Scan(&j.ID, &j.SlotID, &j.SourceNodeID, &j.TargetNodeID, &j.TargetMemoryMiB, &j.Status, &j.ErrorMessage, &j.CreatedAt, &completed); err != nil {
			return nil, err
		}
		if completed.Valid {
			t := completed.Time.UTC()
			j.CompletedAt = &t
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (p *PostgresVmStore) RecordMigration(ctx context.Context, job MigrationJob) error {
	var completed any
	if job.CompletedAt != nil {
		completed = *job.CompletedAt
	}
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO net.vm_migration_jobs (
			id, slot_id, source_node_id, target_node_id, target_memory_mib,
			status, error_message, completed_at
		) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8)
		ON CONFLICT (id) DO UPDATE SET
			status = EXCLUDED.status,
			error_message = EXCLUDED.error_message,
			completed_at = EXCLUDED.completed_at
	`, job.ID, job.SlotID, job.SourceNodeID, job.TargetNodeID, job.TargetMemoryMiB, job.Status, job.ErrorMessage, completed)
	return err
}

func (p *PostgresVmStore) RecordTerminalAudit(ctx context.Context, entry TerminalAuditEntry) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO net.vm_terminal_audit (slot_id, actor, command_preview, exit_code)
		VALUES ($1, $2, $3, $4)
	`, entry.SlotID, entry.Actor, entry.CommandPreview, entry.ExitCode)
	return err
}

func (p *PostgresVmStore) ListTerminalAudit(ctx context.Context, slotID string, limit int) ([]TerminalAuditEntry, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, slot_id, actor, command_preview, exit_code, created_at
		FROM net.vm_terminal_audit
		WHERE slot_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, slotID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TerminalAuditEntry
	for rows.Next() {
		var e TerminalAuditEntry
		if err := rows.Scan(&e.ID, &e.SlotID, &e.Actor, &e.CommandPreview, &e.ExitCode, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func cloneClusterNode(n ClusterNode) ClusterNode {
	out := n
	if n.Labels != nil {
		out.Labels = make(map[string]string, len(n.Labels))
		for k, v := range n.Labels {
			out.Labels[k] = v
		}
	}
	return out
}

func nullInet(ip string) sql.NullString {
	trimmed := strings.TrimSpace(ip)
	if trimmed == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: trimmed, Valid: true}
}

type vmVaultCipher struct {
	key [32]byte
}

func newVmVaultCipher(secret string) *vmVaultCipher {
	if strings.TrimSpace(secret) == "" {
		secret = "slipgate-ephemeral-dev-vault-key-do-not-use-in-prod"
	}
	return &vmVaultCipher{key: sha256.Sum256([]byte(secret))}
}

func (v *vmVaultCipher) encrypt(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(v.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, nil), nil
}

func (v *vmVaultCipher) decrypt(sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(v.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(sealed) < ns {
		return nil, errors.New("vmslot: sealed blob too short")
	}
	return gcm.Open(nil, sealed[:ns], sealed[ns:], nil)
}
