package clashpool

import (
	"errors"
	"fmt"
	"maps"
	"sync"
	"time"
)

// HealthStatus reflects the availability of a managed Clash exit listener.
type HealthStatus string

const (
	HealthUnknown     HealthStatus = "unknown"
	HealthHealthy     HealthStatus = "healthy"
	HealthDegraded    HealthStatus = "degraded"
	HealthCircuitOpen HealthStatus = "circuit_open"
)

var (
	ErrNodeNotFound         = errors.New("clashpool: exit node not found")
	ErrExitCircuitOpen      = errors.New("clashpool: exit circuit open (fail-closed, direct egress forbidden)")
	ErrExitCapacityExceeded = errors.New("clashpool: exit IP account capacity reached")
	ErrDropGuardTriggered   = errors.New("clashpool: subscription node drop exceeded safety threshold")
)

// Node describes one materialized Clash listener allocated for isolated account egress.
type Node struct {
	ID               string
	SubscriptionID   string
	Name             string
	ProxySlotID      string
	ListenerPort     int
	SocksUsername    string
	SocksPassword    string
	ProxyType        string
	Server           string
	ServerPort       int
	RawConfig        map[string]any
	ExitIP           string
	LatencyMS        uint32
	Health           HealthStatus
	ConsecutiveFails int
	ConsecutivePass  int
	DriftUnconfirmed bool
	Enabled          bool
	LastProbedAt     *time.Time
	LastError        string
}

// TLSProfile defines uTLS ClientHello and HTTP/2 fingerprint traits attached to an upstream account or pool binding.
type TLSProfile struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	ClientHelloPreset string   `json:"clientHelloPreset"`
	JA3Fingerprint    string   `json:"ja3Fingerprint"`
	JA4Fingerprint    string   `json:"ja4Fingerprint"`
	ALPNProtocols     []string `json:"alpnProtocols"`
	UserAgentTemplate string   `json:"userAgentTemplate"`
	BuiltIn           bool     `json:"builtIn"`
}

// SupportsHTTP2 reports whether the profile permits negotiating HTTP/2 ALPN.
func (p TLSProfile) SupportsHTTP2() bool {
	for _, proto := range p.ALPNProtocols {
		if proto == "h2" || proto == "H2" {
			return true
		}
	}
	return false
}

// AccountBindingRecord represents a resolved account -> Clash node (+ optional uTLS profile) mapping.
type AccountBindingRecord struct {
	AccountID        string `json:"accountId"`
	NodeID           string `json:"nodeId"`
	UTLSProfileID    string `json:"utlsProfileId"`
	IsShadowFollower bool   `json:"isShadowFollower"`
	BoundExitIP      string `json:"boundExitIp"`
}

// DialTarget contains the local SOCKS5 listener parameters used to reach upstream via mihomo.
type DialTarget struct {
	NodeID        string
	ProxySlotID   string
	SOCKSAddr     string
	SocksUsername string
	SocksPassword string
	ExitIP        string
}

// SyncReport summarizes a Clash subscription synchronization pass.
type SyncReport struct {
	SubscriptionID     string
	PreviousCount      int
	CurrentCount       int
	SkippedByDropGuard bool
}

type accountBinding struct {
	NodeID           string
	UTLSProfileID    string
	IsShadowFollower bool
	BoundExitIP      string
}

// Manager enforces 1-account-1-exit-IP isolation, subscription drop-guarding, and fail-closed routing.
type Manager struct {
	mu                 sync.RWMutex
	portMin            int
	portMax            int
	maxAccountsPerExit int
	dropGuardThreshold float64
	nodes              map[string]*Node
	bindings           map[string]accountBinding
}

// NewManager initializes a Clash exit pool coordinator.
func NewManager(portMin, portMax, maxAccountsPerExit int) *Manager {
	if maxAccountsPerExit <= 0 {
		maxAccountsPerExit = 1
	}
	return &Manager{
		portMin:            portMin,
		portMax:            portMax,
		maxAccountsPerExit: maxAccountsPerExit,
		dropGuardThreshold: 0.50,
		nodes:              make(map[string]*Node),
		bindings:           make(map[string]accountBinding),
	}
}

// SyncNodes reconciles nodes for a subscription while preventing sudden empty/partial airport drops.
func (m *Manager) SyncNodes(subscriptionID string, incoming []Node, force bool) (SyncReport, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	prevCount := 0
	for _, n := range m.nodes {
		if n.SubscriptionID == subscriptionID {
			prevCount++
		}
	}

	report := SyncReport{
		SubscriptionID: subscriptionID,
		PreviousCount:  prevCount,
		CurrentCount:   len(incoming),
	}

	if !force && prevCount > 0 {
		if len(incoming) == 0 {
			report.SkippedByDropGuard = true
			return report, ErrDropGuardTriggered
		}
		dropRatio := float64(prevCount-len(incoming)) / float64(prevCount)
		if dropRatio > m.dropGuardThreshold {
			report.SkippedByDropGuard = true
			return report, fmt.Errorf("%w: dropped %.0f%% (%d -> %d)", ErrDropGuardTriggered, dropRatio*100, prevCount, len(incoming))
		}
	}

	incomingIDs := make(map[string]struct{}, len(incoming))
	for _, n := range incoming {
		if n.ListenerPort < m.portMin || n.ListenerPort > m.portMax {
			return report, fmt.Errorf("clashpool: listener port %d outside [%d,%d]", n.ListenerPort, m.portMin, m.portMax)
		}
		nodeCopy := cloneNode(n)
		nodeCopy.SubscriptionID = subscriptionID
		if existing, ok := m.nodes[n.ID]; ok {
			if nodeCopy.ExitIP == "" {
				nodeCopy.ExitIP = existing.ExitIP
			}
			if nodeCopy.LatencyMS == 0 {
				nodeCopy.LatencyMS = existing.LatencyMS
			}
			if nodeCopy.Health == "" {
				nodeCopy.Health = existing.Health
			}
			if nodeCopy.LastProbedAt == nil && existing.LastProbedAt != nil {
				t := *existing.LastProbedAt
				nodeCopy.LastProbedAt = &t
			}
			nodeCopy.DriftUnconfirmed = existing.DriftUnconfirmed
			nodeCopy.ConsecutiveFails = existing.ConsecutiveFails
			nodeCopy.ConsecutivePass = existing.ConsecutivePass
		}
		if nodeCopy.Health == "" {
			nodeCopy.Health = HealthUnknown
		}
		m.nodes[n.ID] = &nodeCopy
		incomingIDs[n.ID] = struct{}{}
	}

	// Nodes absent from the latest subscription turn into circuit-open placeholders until unbound.
	for id, existing := range m.nodes {
		if existing.SubscriptionID == subscriptionID {
			if _, stillPresent := incomingIDs[id]; !stillPresent {
				existing.Enabled = false
				existing.Health = HealthCircuitOpen
			}
		}
	}

	return report, nil
}

// BindAccount attaches an upstream account to a Clash exit node, enforcing per-ExitIP capacity.
func (m *Manager) BindAccount(accountID, nodeID string, isShadowFollower bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	node, ok := m.nodes[nodeID]
	if !ok {
		return ErrNodeNotFound
	}
	if !node.Enabled || node.ExitIP == "" || node.Health != HealthHealthy || node.DriftUnconfirmed {
		return fmt.Errorf("%w: node %s cannot accept new bindings", ErrExitCircuitOpen, nodeID)
	}

	if !isShadowFollower {
		occupied := 0
		for boundAccID, binding := range m.bindings {
			if boundAccID == accountID || binding.IsShadowFollower {
				continue
			}
			boundNode, exists := m.nodes[binding.NodeID]
			if exists && boundNode.ExitIP == node.ExitIP {
				occupied++
			}
		}
		if occupied >= m.maxAccountsPerExit {
			return fmt.Errorf("%w: exit_ip=%s (%d/%d)", ErrExitCapacityExceeded, node.ExitIP, occupied, m.maxAccountsPerExit)
		}
	}

	m.bindings[accountID] = accountBinding{
		NodeID:           nodeID,
		IsShadowFollower: isShadowFollower,
	}
	return nil
}

// UnbindAccount removes an account's exit binding.
func (m *Manager) UnbindAccount(accountID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.bindings, accountID)
}

// ReportProbe updates node latency, health state, and detects unexpected exit IP drift.
func (m *Manager) ReportProbe(nodeID, observedExitIP string, latencyMS uint32, success bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	node, ok := m.nodes[nodeID]
	if !ok {
		return ErrNodeNotFound
	}

	if !success {
		now := time.Now().UTC()
		node.LastProbedAt = &now
		node.ConsecutivePass = 0
		node.ConsecutiveFails++
		if node.ConsecutiveFails >= 3 {
			node.Health = HealthCircuitOpen
		} else {
			node.Health = HealthDegraded
		}
		return nil
	}

	now := time.Now().UTC()
	node.LastProbedAt = &now
	node.LastError = ""
	node.LatencyMS = latencyMS
	node.ConsecutiveFails = 0
	node.ConsecutivePass++

	if observedExitIP != "" {
		if node.ExitIP != "" && node.ExitIP != observedExitIP {
			node.DriftUnconfirmed = true
			node.Health = HealthCircuitOpen
		}
		node.ExitIP = observedExitIP
	}

	if !node.DriftUnconfirmed && node.ConsecutivePass >= 1 && node.ExitIP != "" {
		node.Health = HealthHealthy
	}
	return nil
}

// ConfirmExitDrift clears the drift pause after administrator verification.
func (m *Manager) ConfirmExitDrift(nodeID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	node, ok := m.nodes[nodeID]
	if !ok {
		return ErrNodeNotFound
	}
	node.DriftUnconfirmed = false
	if node.Enabled && node.ExitIP != "" {
		node.Health = HealthHealthy
	}
	return nil
}

// ResolveDialTarget returns the local SOCKS5 listener for an account or fails closed.
func (m *Manager) ResolveDialTarget(accountID string) (DialTarget, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	binding, bound := m.bindings[accountID]
	if !bound {
		return DialTarget{}, fmt.Errorf("%w: account %s has no Clash exit binding", ErrExitCircuitOpen, accountID)
	}
	node, exists := m.nodes[binding.NodeID]
	if !exists {
		return DialTarget{}, fmt.Errorf("%w: bound node %s missing", ErrExitCircuitOpen, binding.NodeID)
	}
	if !node.Enabled || node.Health != HealthHealthy || node.DriftUnconfirmed || node.ExitIP == "" {
		return DialTarget{}, fmt.Errorf("%w: node=%s status=%s drift=%v", ErrExitCircuitOpen, node.ID, node.Health, node.DriftUnconfirmed)
	}

	return DialTarget{
		NodeID:        node.ID,
		ProxySlotID:   node.ProxySlotID,
		SOCKSAddr:     fmt.Sprintf("127.0.0.1:%d", node.ListenerPort),
		SocksUsername: node.SocksUsername,
		SocksPassword: node.SocksPassword,
		ExitIP:        node.ExitIP,
	}, nil
}

// Snapshot returns a copy of all known exit nodes.
func (m *Manager) Snapshot() []Node {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Node, 0, len(m.nodes))
	for _, n := range m.nodes {
		out = append(out, cloneNode(*n))
	}
	return out
}

// GetNode returns a copy of a single Clash exit node by ID.
func (m *Manager) GetNode(nodeID string) (Node, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	n, ok := m.nodes[nodeID]
	if !ok {
		return Node{}, false
	}
	return cloneNode(*n), true
}

// UpsertNode inserts or replaces a single hydrated node without drop-guard checks (used on startup restore).
func (m *Manager) UpsertNode(n Node) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := cloneNode(n)
	if c.Health == "" {
		c.Health = HealthUnknown
	}
	m.nodes[c.ID] = &c
}

// SetNodeEnabled toggles whether a Clash node is eligible for traffic and new account bindings.
func (m *Manager) SetNodeEnabled(nodeID string, enabled bool) (Node, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.nodes[nodeID]
	if !ok {
		return Node{}, ErrNodeNotFound
	}
	n.Enabled = enabled
	return cloneNode(*n), nil
}

// RemoveSubscriptionNodes removes all nodes belonging to subID (and unbinds any accounts pointing to them).
func (m *Manager) RemoveSubscriptionNodes(subID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var removed []string
	removedSet := make(map[string]struct{})
	for id, n := range m.nodes {
		if n.SubscriptionID == subID {
			removed = append(removed, id)
			removedSet[id] = struct{}{}
			delete(m.nodes, id)
		}
	}
	for accID, b := range m.bindings {
		if _, gone := removedSet[b.NodeID]; gone {
			delete(m.bindings, accID)
		}
	}
	return removed
}

// SetNodeProbeError updates LastProbedAt and LastError on nodeID.
func (m *Manager) SetNodeProbeError(nodeID string, probedAt time.Time, probeErr string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n, ok := m.nodes[nodeID]; ok {
		ts := probedAt
		n.LastProbedAt = &ts
		n.LastError = probeErr
	}
}

// BindAccountWithProfile attaches an upstream account to a Clash exit node with optional uTLS profile metadata.
func (m *Manager) BindAccountWithProfile(accountID, nodeID string, isShadowFollower bool, utlsProfileID string) error {
	if err := m.BindAccount(accountID, nodeID, isShadowFollower); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b := m.bindings[accountID]
	b.UTLSProfileID = utlsProfileID
	if n, ok := m.nodes[nodeID]; ok {
		b.BoundExitIP = n.ExitIP
	}
	m.bindings[accountID] = b
	return nil
}

// RestoreBinding loads a persisted binding during startup without requiring the node to have passed a fresh probe yet.
func (m *Manager) RestoreBinding(rec AccountBindingRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bindings[rec.AccountID] = accountBinding{
		NodeID:           rec.NodeID,
		UTLSProfileID:    rec.UTLSProfileID,
		IsShadowFollower: rec.IsShadowFollower,
		BoundExitIP:      rec.BoundExitIP,
	}
}

// ListBindings returns all account -> Clash exit bindings.
func (m *Manager) ListBindings() []AccountBindingRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]AccountBindingRecord, 0, len(m.bindings))
	for accID, b := range m.bindings {
		exitIP := b.BoundExitIP
		if n, ok := m.nodes[b.NodeID]; ok && n.ExitIP != "" {
			exitIP = n.ExitIP
		}
		out = append(out, AccountBindingRecord{
			AccountID:        accID,
			NodeID:           b.NodeID,
			UTLSProfileID:    b.UTLSProfileID,
			IsShadowFollower: b.IsShadowFollower,
			BoundExitIP:      exitIP,
		})
	}
	return out
}

// GetBinding returns the binding record for accountID if present.
func (m *Manager) GetBinding(accountID string) (AccountBindingRecord, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, ok := m.bindings[accountID]
	if !ok {
		return AccountBindingRecord{}, false
	}
	exitIP := b.BoundExitIP
	if n, exists := m.nodes[b.NodeID]; exists && n.ExitIP != "" {
		exitIP = n.ExitIP
	}
	return AccountBindingRecord{
		AccountID:        accountID,
		NodeID:           b.NodeID,
		UTLSProfileID:    b.UTLSProfileID,
		IsShadowFollower: b.IsShadowFollower,
		BoundExitIP:      exitIP,
	}, true
}

// AllocatedPorts returns the set of listener ports currently held by known nodes.
func (m *Manager) AllocatedPorts() map[int]struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	used := make(map[int]struct{}, len(m.nodes))
	for _, n := range m.nodes {
		used[n.ListenerPort] = struct{}{}
	}
	return used
}

// BoundCount returns how many accounts currently bind to nodeID.
func (m *Manager) BoundCount(nodeID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	count := 0
	for _, b := range m.bindings {
		if b.NodeID == nodeID {
			count++
		}
	}
	return count
}

func cloneNode(in Node) Node {
	out := in
	if in.RawConfig != nil {
		out.RawConfig = maps.Clone(in.RawConfig)
	}
	if in.LastProbedAt != nil {
		t := *in.LastProbedAt
		out.LastProbedAt = &t
	}
	return out
}
