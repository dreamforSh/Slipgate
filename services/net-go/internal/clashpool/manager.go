package clashpool

import (
	"errors"
	"fmt"
	"sync"
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
	ExitIP           string
	LatencyMS        uint32
	Health           HealthStatus
	ConsecutiveFails int
	ConsecutivePass  int
	DriftUnconfirmed bool
	Enabled          bool
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
	IsShadowFollower bool
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
		nodeCopy := n
		nodeCopy.SubscriptionID = subscriptionID
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
		node.ConsecutivePass = 0
		node.ConsecutiveFails++
		if node.ConsecutiveFails >= 3 {
			node.Health = HealthCircuitOpen
		} else {
			node.Health = HealthDegraded
		}
		return nil
	}

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

// GetNode returns a copy of a single Clash exit node by ID.
func (m *Manager) GetNode(nodeID string) (Node, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	n, ok := m.nodes[nodeID]
	if !ok {
		return Node{}, false
	}
	return *n, true
}

// Snapshot returns a copy of all known exit nodes.
func (m *Manager) Snapshot() []Node {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Node, 0, len(m.nodes))
	for _, n := range m.nodes {
		out = append(out, *n)
	}
	return out
}
