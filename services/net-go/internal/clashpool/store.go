package clashpool

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
	ErrSubscriptionNotFound = errors.New("clashpool: subscription not found")
	ErrProfileNotFound      = errors.New("clashpool: TLS profile not found")
)

// Subscription describes a configured Clash proxy source (URL or inline YAML/URI payload).
type Subscription struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	SourceKind     string     `json:"sourceKind"` // "url" | "inline"
	SourceURL      string     `json:"sourceUrl,omitempty"`
	UserAgent      string     `json:"userAgent"`
	ExcludeRegex   string     `json:"excludeRegex"`
	Enabled        bool       `json:"enabled"`
	LastSyncAt     *time.Time `json:"lastSyncAt"`
	LastSyncStatus string     `json:"lastSyncStatus"`
	LastNodeCount  int        `json:"lastNodeCount"`
	CreatedAt      time.Time  `json:"createdAt"`
}

// NetStore persists net.* schema entities exclusively owned by slipgate-net (Go).
type NetStore interface {
	Init(ctx context.Context) error
	ListSubscriptions(ctx context.Context) ([]Subscription, error)
	GetSubscription(ctx context.Context, subID string) (Subscription, error)
	UpsertSubscription(ctx context.Context, sub Subscription) error
	DeleteSubscription(ctx context.Context, subID string) error
	ListNodes(ctx context.Context) ([]Node, error)
	UpsertNodes(ctx context.Context, nodes []Node) error
	UpdateNodeRuntime(ctx context.Context, n Node) error
	ListTLSProfiles(ctx context.Context) ([]TLSProfile, error)
	UpsertTLSProfile(ctx context.Context, p TLSProfile) error
	DeleteTLSProfile(ctx context.Context, profileID string) error
	ListBindings(ctx context.Context) ([]AccountBindingRecord, error)
	UpsertBinding(ctx context.Context, b AccountBindingRecord) error
	DeleteBinding(ctx context.Context, accountID string) error
	AddDailyTraffic(ctx context.Context, nodeID string, statDate time.Time, upDelta, downDelta int64) error
	Close() error
}

// -----------------------------------------------------------------------------
// Encrypted Vault Helpers (AES-256-GCM matching net.* BYTEA columns)
// -----------------------------------------------------------------------------

type vaultCipher struct {
	aead cipher.AEAD
}

func newVaultCipher(secret string) (*vaultCipher, error) {
	if strings.TrimSpace(secret) == "" {
		secret = "slipgate-dev-vault-secret-change-in-prod"
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &vaultCipher{aead: aead}, nil
}

func (v *vaultCipher) encrypt(plain []byte) ([]byte, error) {
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return v.aead.Seal(nonce, nonce, plain, nil), nil
}

func (v *vaultCipher) decrypt(blob []byte) ([]byte, error) {
	ns := v.aead.NonceSize()
	if len(blob) < ns {
		return nil, errors.New("clashpool: ciphertext shorter than nonce")
	}
	return v.aead.Open(nil, blob[:ns], blob[ns:], nil)
}

// -----------------------------------------------------------------------------
// In-Memory Store (tests & standalone dev/container without Postgres)
// -----------------------------------------------------------------------------

type MemoryNetStore struct {
	mu       sync.RWMutex
	subs     map[string]Subscription
	nodes    map[string]Node
	profiles map[string]TLSProfile
	bindings map[string]AccountBindingRecord
	traffic  map[string][2]int64
}

func NewMemoryNetStore() *MemoryNetStore {
	return &MemoryNetStore{
		subs:     make(map[string]Subscription),
		nodes:    make(map[string]Node),
		profiles: make(map[string]TLSProfile),
		bindings: make(map[string]AccountBindingRecord),
		traffic:  make(map[string][2]int64),
	}
}

func (m *MemoryNetStore) Init(context.Context) error { return nil }
func (m *MemoryNetStore) Close() error              { return nil }

func (m *MemoryNetStore) ListSubscriptions(context.Context) ([]Subscription, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Subscription, 0, len(m.subs))
	for _, s := range m.subs {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b Subscription) int {
		return strings.Compare(a.CreatedAt.Format(time.RFC3339Nano), b.CreatedAt.Format(time.RFC3339Nano))
	})
	return out, nil
}

func (m *MemoryNetStore) GetSubscription(_ context.Context, subID string) (Subscription, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.subs[subID]
	if !ok {
		return Subscription{}, ErrSubscriptionNotFound
	}
	return s, nil
}

func (m *MemoryNetStore) UpsertSubscription(_ context.Context, sub Subscription) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.subs[sub.ID]; ok {
		if sub.CreatedAt.IsZero() {
			sub.CreatedAt = existing.CreatedAt
		}
	}
	if sub.CreatedAt.IsZero() {
		sub.CreatedAt = time.Now().UTC()
	}
	m.subs[sub.ID] = sub
	return nil
}

func (m *MemoryNetStore) DeleteSubscription(_ context.Context, subID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.subs[subID]; !ok {
		return ErrSubscriptionNotFound
	}
	delete(m.subs, subID)
	removedNodes := make(map[string]struct{})
	for id, n := range m.nodes {
		if n.SubscriptionID == subID {
			removedNodes[id] = struct{}{}
			delete(m.nodes, id)
		}
	}
	for accID, b := range m.bindings {
		if _, gone := removedNodes[b.NodeID]; gone {
			delete(m.bindings, accID)
		}
	}
	return nil
}

func (m *MemoryNetStore) ListNodes(context.Context) ([]Node, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Node, 0, len(m.nodes))
	for _, n := range m.nodes {
		out = append(out, cloneNode(n))
	}
	slices.SortFunc(out, func(a, b Node) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (m *MemoryNetStore) UpsertNodes(_ context.Context, nodes []Node) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, n := range nodes {
		m.nodes[n.ID] = cloneNode(n)
	}
	return nil
}

func (m *MemoryNetStore) UpdateNodeRuntime(_ context.Context, n Node) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.nodes[n.ID]
	if !ok {
		return ErrNodeNotFound
	}
	existing.ExitIP = n.ExitIP
	existing.LatencyMS = n.LatencyMS
	existing.Health = n.Health
	existing.ConsecutiveFails = n.ConsecutiveFails
	existing.ConsecutivePass = n.ConsecutivePass
	existing.DriftUnconfirmed = n.DriftUnconfirmed
	existing.Enabled = n.Enabled
	existing.LastError = n.LastError
	if n.LastProbedAt != nil {
		t := *n.LastProbedAt
		existing.LastProbedAt = &t
	}
	m.nodes[n.ID] = existing
	return nil
}

func (m *MemoryNetStore) ListTLSProfiles(context.Context) ([]TLSProfile, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]TLSProfile, 0, len(m.profiles))
	for _, p := range m.profiles {
		out = append(out, p.Clone())
	}
	slices.SortFunc(out, func(a, b TLSProfile) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (m *MemoryNetStore) UpsertTLSProfile(_ context.Context, p TLSProfile) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.profiles[p.ID] = p.Clone()
	return nil
}

func (m *MemoryNetStore) DeleteTLSProfile(_ context.Context, profileID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.profiles[profileID]; !ok {
		return ErrProfileNotFound
	}
	delete(m.profiles, profileID)
	return nil
}

func (m *MemoryNetStore) ListBindings(context.Context) ([]AccountBindingRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]AccountBindingRecord, 0, len(m.bindings))
	for _, b := range m.bindings {
		out = append(out, b)
	}
	return out, nil
}

func (m *MemoryNetStore) UpsertBinding(_ context.Context, b AccountBindingRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bindings[b.AccountID] = b
	return nil
}

func (m *MemoryNetStore) DeleteBinding(_ context.Context, accountID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.bindings, accountID)
	return nil
}

func (m *MemoryNetStore) AddDailyTraffic(_ context.Context, nodeID string, statDate time.Time, upDelta, downDelta int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := nodeID + "|" + statDate.UTC().Format("2006-01-02")
	cur := m.traffic[key]
	cur[0] += upDelta
	cur[1] += downDelta
	m.traffic[key] = cur
	return nil
}

// -----------------------------------------------------------------------------
// PostgreSQL Store (Single-Writer net.* Schema)
// -----------------------------------------------------------------------------

type PostgresNetStore struct {
	db    *sql.DB
	vault *vaultCipher
}

func NewPostgresNetStore(databaseURL, vaultSecret string) (*PostgresNetStore, error) {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("clashpool: open postgres: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(15 * time.Minute)

	vault, err := newVaultCipher(vaultSecret)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &PostgresNetStore{db: db, vault: vault}, nil
}

func (p *PostgresNetStore) Close() error {
	if p.db != nil {
		return p.db.Close()
	}
	return nil
}

func (p *PostgresNetStore) Init(ctx context.Context) error {
	if err := p.db.PingContext(ctx); err != nil {
		return fmt.Errorf("clashpool: postgres ping failed: %w", err)
	}
	ddl := `
CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE IF NOT EXISTS net.clash_subscriptions (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    source_url_enc      BYTEA NOT NULL,
    source_kind         TEXT NOT NULL DEFAULT 'url',
    user_agent          TEXT NOT NULL DEFAULT 'clash.meta',
    exclude_regex       TEXT NOT NULL DEFAULT '剩余流量|到期时间|官网',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    last_sync_at        TIMESTAMPTZ,
    last_sync_status    TEXT NOT NULL DEFAULT 'pending',
    last_node_count     INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE net.clash_subscriptions
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'url';

CREATE TABLE IF NOT EXISTS net.clash_nodes (
    id                  TEXT PRIMARY KEY,
    subscription_id     TEXT NOT NULL REFERENCES net.clash_subscriptions(id) ON DELETE CASCADE,
    node_name           TEXT NOT NULL,
    proxy_slot_id       TEXT NOT NULL UNIQUE,
    listener_port       INTEGER NOT NULL UNIQUE,
    socks_username      TEXT NOT NULL,
    socks_password_enc  BYTEA NOT NULL,
    raw_config_enc      BYTEA NOT NULL,
    proxy_type          TEXT NOT NULL DEFAULT '',
    server              TEXT NOT NULL DEFAULT '',
    server_port         INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE net.clash_nodes
    ADD COLUMN IF NOT EXISTS proxy_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS server TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS server_port INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS net.tls_profiles (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE,
    description          TEXT NOT NULL DEFAULT '',
    client_hello_preset  TEXT NOT NULL DEFAULT 'chrome_auto',
    ja3_fingerprint      TEXT,
    ja4_fingerprint      TEXT,
    alpn_protocols       JSONB NOT NULL DEFAULT '["h2","http/1.1"]'::jsonb,
    h2_settings          JSONB NOT NULL DEFAULT '{}'::jsonb,
    user_agent_template  TEXT,
    enable_grease        BOOLEAN NOT NULL DEFAULT FALSE,
    cipher_suites        JSONB NOT NULL DEFAULT '[]'::jsonb,
    curves               JSONB NOT NULL DEFAULT '[]'::jsonb,
    point_formats        JSONB NOT NULL DEFAULT '[]'::jsonb,
    signature_algorithms JSONB NOT NULL DEFAULT '[]'::jsonb,
    supported_versions   JSONB NOT NULL DEFAULT '[]'::jsonb,
    key_share_groups     JSONB NOT NULL DEFAULT '[]'::jsonb,
    psk_modes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    extensions           JSONB NOT NULL DEFAULT '[]'::jsonb,
    os_hint              TEXT NOT NULL DEFAULT '',
    built_in             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE net.tls_profiles
    ADD COLUMN IF NOT EXISTS client_hello_preset TEXT NOT NULL DEFAULT 'chrome_auto',
    ADD COLUMN IF NOT EXISTS built_in BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS enable_grease BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS cipher_suites JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS curves JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS point_formats JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS signature_algorithms JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS supported_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS key_share_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS psk_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS extensions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS os_hint TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS net.proxy_bindings (
    account_id          TEXT PRIMARY KEY,
    node_id             TEXT NOT NULL REFERENCES net.clash_nodes(id) ON DELETE RESTRICT,
    utls_profile_id     TEXT REFERENCES net.tls_profiles(id) ON DELETE SET NULL,
    is_shadow_follower  BOOLEAN NOT NULL DEFAULT FALSE,
    bound_exit_ip       INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS net.node_traffic_daily (
    node_id             TEXT NOT NULL REFERENCES net.clash_nodes(id) ON DELETE CASCADE,
    stat_date           DATE NOT NULL,
    upload_bytes        BIGINT NOT NULL DEFAULT 0,
    download_bytes      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, stat_date)
);`
	if _, err := p.db.ExecContext(ctx, ddl); err != nil {
		return fmt.Errorf("clashpool: init net schema: %w", err)
	}
	return nil
}

func (p *PostgresNetStore) ListSubscriptions(ctx context.Context) ([]Subscription, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, name, source_url_enc, source_kind, user_agent, exclude_regex, enabled,
		       last_sync_at, last_sync_status, last_node_count, created_at
		FROM net.clash_subscriptions
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Subscription
	for rows.Next() {
		var (
			s          Subscription
			encSource  []byte
			lastSyncAt sql.NullTime
		)
		if err := rows.Scan(
			&s.ID, &s.Name, &encSource, &s.SourceKind, &s.UserAgent, &s.ExcludeRegex, &s.Enabled,
			&lastSyncAt, &s.LastSyncStatus, &s.LastNodeCount, &s.CreatedAt,
		); err != nil {
			return nil, err
		}
		if lastSyncAt.Valid {
			t := lastSyncAt.Time.UTC()
			s.LastSyncAt = &t
		}
		if plain, decErr := p.vault.decrypt(encSource); decErr == nil {
			s.SourceURL = string(plain)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PostgresNetStore) GetSubscription(ctx context.Context, subID string) (Subscription, error) {
	var (
		s          Subscription
		encSource  []byte
		lastSyncAt sql.NullTime
	)
	err := p.db.QueryRowContext(ctx, `
		SELECT id, name, source_url_enc, source_kind, user_agent, exclude_regex, enabled,
		       last_sync_at, last_sync_status, last_node_count, created_at
		FROM net.clash_subscriptions WHERE id = $1
	`, subID).Scan(
		&s.ID, &s.Name, &encSource, &s.SourceKind, &s.UserAgent, &s.ExcludeRegex, &s.Enabled,
		&lastSyncAt, &s.LastSyncStatus, &s.LastNodeCount, &s.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Subscription{}, ErrSubscriptionNotFound
	}
	if err != nil {
		return Subscription{}, err
	}
	if lastSyncAt.Valid {
		t := lastSyncAt.Time.UTC()
		s.LastSyncAt = &t
	}
	if plain, decErr := p.vault.decrypt(encSource); decErr == nil {
		s.SourceURL = string(plain)
	}
	return s, nil
}

func (p *PostgresNetStore) UpsertSubscription(ctx context.Context, sub Subscription) error {
	encSource, err := p.vault.encrypt([]byte(sub.SourceURL))
	if err != nil {
		return err
	}
	sourceKind := sub.SourceKind
	if sourceKind == "" {
		sourceKind = "url"
	}
	var lastSync any
	if sub.LastSyncAt != nil {
		lastSync = *sub.LastSyncAt
	}
	_, err = p.db.ExecContext(ctx, `
		INSERT INTO net.clash_subscriptions (
			id, name, source_url_enc, source_kind, user_agent, exclude_regex, enabled,
			last_sync_at, last_sync_status, last_node_count, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			source_url_enc = EXCLUDED.source_url_enc,
			source_kind = EXCLUDED.source_kind,
			user_agent = EXCLUDED.user_agent,
			exclude_regex = EXCLUDED.exclude_regex,
			enabled = EXCLUDED.enabled,
			last_sync_at = EXCLUDED.last_sync_at,
			last_sync_status = EXCLUDED.last_sync_status,
			last_node_count = EXCLUDED.last_node_count,
			updated_at = NOW()
	`, sub.ID, sub.Name, encSource, sourceKind, sub.UserAgent, sub.ExcludeRegex, sub.Enabled, lastSync, sub.LastSyncStatus, sub.LastNodeCount)
	return err
}

func (p *PostgresNetStore) DeleteSubscription(ctx context.Context, subID string) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		DELETE FROM net.proxy_bindings
		WHERE node_id IN (SELECT id FROM net.clash_nodes WHERE subscription_id = $1)
	`, subID); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM net.clash_subscriptions WHERE id = $1`, subID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrSubscriptionNotFound
	}
	return tx.Commit()
}

func (p *PostgresNetStore) ListNodes(ctx context.Context) ([]Node, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, subscription_id, node_name, proxy_slot_id, listener_port,
		       socks_username, socks_password_enc, raw_config_enc,
		       proxy_type, server, server_port,
		       COALESCE(host(exit_ip), ''), COALESCE(latency_ms, 0), health_status,
		       consecutive_fails, consecutive_passes, drift_unconfirmed, enabled, last_probed_at
		FROM net.clash_nodes
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Node
	for rows.Next() {
		var (
			n            Node
			passEnc      []byte
			rawCfgEnc    []byte
			latency      int
			healthStr    string
			lastProbedAt sql.NullTime
		)
		if err := rows.Scan(
			&n.ID, &n.SubscriptionID, &n.Name, &n.ProxySlotID, &n.ListenerPort,
			&n.SocksUsername, &passEnc, &rawCfgEnc,
			&n.ProxyType, &n.Server, &n.ServerPort,
			&n.ExitIP, &latency, &healthStr,
			&n.ConsecutiveFails, &n.ConsecutivePass, &n.DriftUnconfirmed, &n.Enabled, &lastProbedAt,
		); err != nil {
			return nil, err
		}
		n.LatencyMS = uint32(max(0, latency))
		n.Health = HealthStatus(healthStr)
		if lastProbedAt.Valid {
			t := lastProbedAt.Time.UTC()
			n.LastProbedAt = &t
		}
		if passPlain, decErr := p.vault.decrypt(passEnc); decErr == nil {
			n.SocksPassword = string(passPlain)
		}
		if cfgPlain, decErr := p.vault.decrypt(rawCfgEnc); decErr == nil && len(cfgPlain) > 0 {
			_ = json.Unmarshal(cfgPlain, &n.RawConfig)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (p *PostgresNetStore) UpsertNodes(ctx context.Context, nodes []Node) error {
	if len(nodes) == 0 {
		return nil
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO net.clash_nodes (
			id, subscription_id, node_name, proxy_slot_id, listener_port,
			socks_username, socks_password_enc, raw_config_enc,
			proxy_type, server, server_port,
			exit_ip, latency_ms, health_status, consecutive_fails, consecutive_passes,
			drift_unconfirmed, enabled, last_probed_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
		ON CONFLICT (id) DO UPDATE SET
			node_name = EXCLUDED.node_name,
			proxy_slot_id = EXCLUDED.proxy_slot_id,
			listener_port = EXCLUDED.listener_port,
			socks_username = EXCLUDED.socks_username,
			socks_password_enc = EXCLUDED.socks_password_enc,
			raw_config_enc = EXCLUDED.raw_config_enc,
			proxy_type = EXCLUDED.proxy_type,
			server = EXCLUDED.server,
			server_port = EXCLUDED.server_port,
			exit_ip = EXCLUDED.exit_ip,
			latency_ms = EXCLUDED.latency_ms,
			health_status = EXCLUDED.health_status,
			consecutive_fails = EXCLUDED.consecutive_fails,
			consecutive_passes = EXCLUDED.consecutive_passes,
			drift_unconfirmed = EXCLUDED.drift_unconfirmed,
			enabled = EXCLUDED.enabled,
			last_probed_at = EXCLUDED.last_probed_at,
			updated_at = NOW()
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, n := range nodes {
		passEnc, encErr := p.vault.encrypt([]byte(n.SocksPassword))
		if encErr != nil {
			return encErr
		}
		rawJSON, _ := json.Marshal(n.RawConfig)
		cfgEnc, encErr := p.vault.encrypt(rawJSON)
		if encErr != nil {
			return encErr
		}
		var probed any
		if n.LastProbedAt != nil {
			probed = *n.LastProbedAt
		}
		if _, err := stmt.ExecContext(
			ctx,
			n.ID, n.SubscriptionID, n.Name, n.ProxySlotID, n.ListenerPort,
			n.SocksUsername, passEnc, cfgEnc,
			n.ProxyType, n.Server, n.ServerPort,
			nullInet(n.ExitIP), int(n.LatencyMS), string(n.Health), n.ConsecutiveFails, n.ConsecutivePass,
			n.DriftUnconfirmed, n.Enabled, probed,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *PostgresNetStore) UpdateNodeRuntime(ctx context.Context, n Node) error {
	var probed any
	if n.LastProbedAt != nil {
		probed = *n.LastProbedAt
	}
	_, err := p.db.ExecContext(ctx, `
		UPDATE net.clash_nodes SET
			exit_ip = $2,
			latency_ms = $3,
			health_status = $4,
			consecutive_fails = $5,
			consecutive_passes = $6,
			drift_unconfirmed = $7,
			enabled = $8,
			last_probed_at = $9,
			updated_at = NOW()
		WHERE id = $1
	`, n.ID, nullInet(n.ExitIP), int(n.LatencyMS), string(n.Health), n.ConsecutiveFails, n.ConsecutivePass, n.DriftUnconfirmed, n.Enabled, probed)
	return err
}

func (p *PostgresNetStore) ListTLSProfiles(ctx context.Context) ([]TLSProfile, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT id, name, description, client_hello_preset,
		       COALESCE(ja3_fingerprint, ''), COALESCE(ja4_fingerprint, ''),
		       alpn_protocols, COALESCE(user_agent_template, ''),
		       enable_grease, cipher_suites, curves, point_formats,
		       signature_algorithms, supported_versions, key_share_groups,
		       psk_modes, extensions, os_hint, built_in
		FROM net.tls_profiles
		ORDER BY built_in DESC, id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TLSProfile
	for rows.Next() {
		var (
			tp             TLSProfile
			alpnJSON       []byte
			ciphersJSON    []byte
			curvesJSON     []byte
			pointJSON      []byte
			sigAlgsJSON    []byte
			versionsJSON   []byte
			keyShareJSON   []byte
			pskJSON        []byte
			extensionsJSON []byte
		)
		if err := rows.Scan(
			&tp.ID, &tp.Name, &tp.Description, &tp.ClientHelloPreset,
			&tp.JA3Fingerprint, &tp.JA4Fingerprint,
			&alpnJSON, &tp.UserAgentTemplate,
			&tp.EnableGREASE, &ciphersJSON, &curvesJSON, &pointJSON,
			&sigAlgsJSON, &versionsJSON, &keyShareJSON,
			&pskJSON, &extensionsJSON, &tp.OSHint, &tp.BuiltIn,
		); err != nil {
			return nil, err
		}
		decodeJSONSlice(alpnJSON, &tp.ALPNProtocols)
		decodeJSONSlice(ciphersJSON, &tp.CipherSuites)
		decodeJSONSlice(curvesJSON, &tp.Curves)
		decodeJSONSlice(pointJSON, &tp.PointFormats)
		decodeJSONSlice(sigAlgsJSON, &tp.SignatureAlgorithms)
		decodeJSONSlice(versionsJSON, &tp.SupportedVersions)
		decodeJSONSlice(keyShareJSON, &tp.KeyShareGroups)
		decodeJSONSlice(pskJSON, &tp.PSKModes)
		decodeJSONSlice(extensionsJSON, &tp.Extensions)
		out = append(out, tp)
	}
	return out, rows.Err()
}

func (p *PostgresNetStore) UpsertTLSProfile(ctx context.Context, tp TLSProfile) error {
	alpnJSON, err := marshalJSONArray(tp.ALPNProtocols)
	if err != nil {
		return err
	}
	ciphersJSON, err := marshalJSONArray(tp.CipherSuites)
	if err != nil {
		return err
	}
	curvesJSON, err := marshalJSONArray(tp.Curves)
	if err != nil {
		return err
	}
	pointJSON, err := marshalJSONArray(tp.PointFormats)
	if err != nil {
		return err
	}
	sigAlgsJSON, err := marshalJSONArray(tp.SignatureAlgorithms)
	if err != nil {
		return err
	}
	versionsJSON, err := marshalJSONArray(tp.SupportedVersions)
	if err != nil {
		return err
	}
	keyShareJSON, err := marshalJSONArray(tp.KeyShareGroups)
	if err != nil {
		return err
	}
	pskJSON, err := marshalJSONArray(tp.PSKModes)
	if err != nil {
		return err
	}
	extensionsJSON, err := marshalJSONArray(tp.Extensions)
	if err != nil {
		return err
	}
	preset := strings.TrimSpace(tp.ClientHelloPreset)
	if preset == "" {
		if tp.HasCustomWireSpec() {
			preset = "custom_wire"
		} else {
			preset = "chrome_auto"
		}
	}
	_, err = p.db.ExecContext(ctx, `
		INSERT INTO net.tls_profiles (
			id, name, description, client_hello_preset, ja3_fingerprint, ja4_fingerprint,
			alpn_protocols, user_agent_template, enable_grease, cipher_suites, curves,
			point_formats, signature_algorithms, supported_versions, key_share_groups,
			psk_modes, extensions, os_hint, built_in, updated_at
		) VALUES (
			$1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''),
			$7::jsonb, NULLIF($8, ''), $9, $10::jsonb, $11::jsonb,
			$12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
			$16::jsonb, $17::jsonb, $18, $19, NOW()
		)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			description = EXCLUDED.description,
			client_hello_preset = EXCLUDED.client_hello_preset,
			ja3_fingerprint = EXCLUDED.ja3_fingerprint,
			ja4_fingerprint = EXCLUDED.ja4_fingerprint,
			alpn_protocols = EXCLUDED.alpn_protocols,
			user_agent_template = EXCLUDED.user_agent_template,
			enable_grease = EXCLUDED.enable_grease,
			cipher_suites = EXCLUDED.cipher_suites,
			curves = EXCLUDED.curves,
			point_formats = EXCLUDED.point_formats,
			signature_algorithms = EXCLUDED.signature_algorithms,
			supported_versions = EXCLUDED.supported_versions,
			key_share_groups = EXCLUDED.key_share_groups,
			psk_modes = EXCLUDED.psk_modes,
			extensions = EXCLUDED.extensions,
			os_hint = EXCLUDED.os_hint,
			updated_at = NOW()
	`,
		tp.ID, tp.Name, tp.Description, preset, tp.JA3Fingerprint, tp.JA4Fingerprint,
		alpnJSON, tp.UserAgentTemplate, tp.EnableGREASE, ciphersJSON, curvesJSON,
		pointJSON, sigAlgsJSON, versionsJSON, keyShareJSON,
		pskJSON, extensionsJSON, tp.OSHint, tp.BuiltIn,
	)
	return err
}

func marshalJSONArray[T any](items []T) (string, error) {
	if len(items) == 0 {
		return "[]", nil
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func decodeJSONSlice[T any](raw []byte, dst *[]T) {
	if len(raw) == 0 {
		return
	}
	_ = json.Unmarshal(raw, dst)
}

func (p *PostgresNetStore) DeleteTLSProfile(ctx context.Context, profileID string) error {
	res, err := p.db.ExecContext(ctx, `DELETE FROM net.tls_profiles WHERE id = $1 AND built_in = FALSE`, profileID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrProfileNotFound
	}
	return nil
}

func (p *PostgresNetStore) ListBindings(ctx context.Context) ([]AccountBindingRecord, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT account_id, node_id, COALESCE(utls_profile_id, ''), is_shadow_follower, COALESCE(host(bound_exit_ip), '')
		FROM net.proxy_bindings
		ORDER BY account_id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AccountBindingRecord
	for rows.Next() {
		var b AccountBindingRecord
		if err := rows.Scan(&b.AccountID, &b.NodeID, &b.UTLSProfileID, &b.IsShadowFollower, &b.BoundExitIP); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (p *PostgresNetStore) UpsertBinding(ctx context.Context, b AccountBindingRecord) error {
	var profileArg any
	if strings.TrimSpace(b.UTLSProfileID) != "" {
		profileArg = strings.TrimSpace(b.UTLSProfileID)
	}
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO net.proxy_bindings (account_id, node_id, utls_profile_id, is_shadow_follower, bound_exit_ip, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (account_id) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			utls_profile_id = EXCLUDED.utls_profile_id,
			is_shadow_follower = EXCLUDED.is_shadow_follower,
			bound_exit_ip = EXCLUDED.bound_exit_ip,
			updated_at = NOW()
	`, b.AccountID, b.NodeID, profileArg, b.IsShadowFollower, nullInet(b.BoundExitIP))
	return err
}

func (p *PostgresNetStore) DeleteBinding(ctx context.Context, accountID string) error {
	_, err := p.db.ExecContext(ctx, `DELETE FROM net.proxy_bindings WHERE account_id = $1`, accountID)
	return err
}

func (p *PostgresNetStore) AddDailyTraffic(ctx context.Context, nodeID string, statDate time.Time, upDelta, downDelta int64) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO net.node_traffic_daily (node_id, stat_date, upload_bytes, download_bytes)
		VALUES ($1, $2::date, $3, $4)
		ON CONFLICT (node_id, stat_date) DO UPDATE SET
			upload_bytes = net.node_traffic_daily.upload_bytes + EXCLUDED.upload_bytes,
			download_bytes = net.node_traffic_daily.download_bytes + EXCLUDED.download_bytes
	`, nodeID, statDate.UTC().Format("2006-01-02"), upDelta, downDelta)
	return err
}

func nullInet(s string) sql.NullString {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return sql.NullString{Valid: false}
	}
	return sql.NullString{String: trimmed, Valid: true}
}
