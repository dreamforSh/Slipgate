package vmslot

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

type HypervisorKind string

const (
	HypervisorKVM    HypervisorKind = "kvm_qemu"
	HypervisorDocker HypervisorKind = "docker_hardened"
	HypervisorMacOS  HypervisorKind = "macos_native"
)

type SlotState string

const (
	StateProvisioning SlotState = "provisioning"
	StateReady        SlotState = "ready"
	StateCooldown5h   SlotState = "cooldown_5h"
	StateCooldown7d   SlotState = "cooldown_7d"
	StateDraining     SlotState = "draining"
	StateStopped      SlotState = "stopped"
	StateAuthExpired  SlotState = "auth_expired"
	StateMigrating    SlotState = "migrating"
)

type TelemetryMode string

const (
	TelemetryEnabled  TelemetryMode = "enabled"
	TelemetryIsolated TelemetryMode = "isolated"
	TelemetryDisabled TelemetryMode = "disabled"
)

var (
	ErrSlotNotFound           = errors.New("vmslot: slot not found")
	ErrInvalidHardwarePersona = errors.New("vmslot: invalid hardware persona")
	ErrImmutableMachineID     = errors.New("vmslot: guest_machine_id is immutable after slot creation")
	ErrSharedSlotEgress       = errors.New("vmslot: 1-slot-1-egress violation (clash node or exit IP already bound)")
	ErrSlotNotReady           = errors.New("vmslot: slot not in ready state")
	ErrSubagentCapacityFull   = errors.New("vmslot: slot subagent concurrency limit reached")
	ErrSlotNotDrained         = errors.New("vmslot: slot has active subagent sessions and must drain before migration")
	ErrMigrationUnsupported   = errors.New("vmslot: live/cold cluster migration requires kvm_qemu hypervisor")
	ErrSlotEgressUnavailable  = errors.New("vmslot: bound Clash exit node is missing or unhealthy")
)

// HardwarePersona describes the immutable physical fingerprint injected into a VM/container slot.
type HardwarePersona struct {
	GuestMachineID string `json:"guestMachineId"`
	MACAddress     string `json:"macAddress"`
	SMBIOSUUID     string `json:"smbiosUuid"`
	SMBIOSSerial   string `json:"smbiosSerial"`
	CPUModel       string `json:"cpuModel"`
	CPUCores       uint32 `json:"cpuCores"`
	Timezone       string `json:"timezone"`
	DoHURL         string `json:"dohUrl"`
}

// Slot represents a running or stopped full-emulation VM/container account slot.
type Slot struct {
	ID              string          `json:"slotId"`
	ClusterNodeID   string          `json:"clusterNodeId"`
	AccountID       string          `json:"accountId"`
	ClashNodeID     string          `json:"clashNodeId"`
	ExitIP          string          `json:"exitIp"`
	Hypervisor      HypervisorKind  `json:"hypervisorKind"`
	State           SlotState       `json:"state"`
	VsockCID        uint32          `json:"vsockCid,omitempty"`
	GuestUDSPath    string          `json:"guestUdsPath,omitempty"`
	ActiveSubagents uint32          `json:"activeSubagents"`
	MaxSubagents    uint32          `json:"maxSubagents"`
	Window5hUsedBps uint32          `json:"window5hUsedBps"`
	Window7dUsedBps uint32          `json:"window7dUsedBps"`
	Telemetry       TelemetryMode   `json:"telemetryMode"`
	CleanseMode     string          `json:"cleanseMode"`
	MemoryMiB       uint32          `json:"memoryMiB"`
	RootDir         string          `json:"rootDir,omitempty"`
	GuestPID        int             `json:"guestPid,omitempty"`
	DaemonVersion   string          `json:"daemonVersion,omitempty"`
	LastHeartbeat   *time.Time      `json:"lastHeartbeatIso,omitempty"`
	CreatedAt       time.Time       `json:"createdAtIso,omitempty"`
	UpdatedAt       time.Time       `json:"updatedAtIso,omitempty"`
	Persona         HardwarePersona `json:"persona"`
}

// ValidateMachineID checks that id is 32 lowercase hex chars and not all zeros.
func ValidateMachineID(id string) error {
	if len(id) != 32 {
		return fmt.Errorf("%w: guest_machine_id must be 32 hex chars, got %d", ErrInvalidHardwarePersona, len(id))
	}
	allZero := true
	for i := 0; i < len(id); i++ {
		ch := id[i]
		isDigit := ch >= '0' && ch <= '9'
		isHexLower := ch >= 'a' && ch <= 'f'
		if !isDigit && !isHexLower {
			return fmt.Errorf("%w: guest_machine_id must be lowercase hex", ErrInvalidHardwarePersona)
		}
		if ch != '0' {
			allZero = false
		}
	}
	if allZero {
		return fmt.Errorf("%w: guest_machine_id cannot be all zeros", ErrInvalidHardwarePersona)
	}
	return nil
}

// ValidatePersona checks required hardware fingerprint invariants.
func ValidatePersona(p HardwarePersona) error {
	if err := ValidateMachineID(p.GuestMachineID); err != nil {
		return err
	}
	if strings.TrimSpace(p.MACAddress) == "" {
		return fmt.Errorf("%w: mac_address is required", ErrInvalidHardwarePersona)
	}
	if strings.TrimSpace(p.SMBIOSUUID) == "" {
		return fmt.Errorf("%w: smbios_uuid is required", ErrInvalidHardwarePersona)
	}
	return nil
}

// Manager coordinates VM slot lifecycle, 1-slot-1-egress exclusivity, subagent seats, and KVM migrations.
type Manager struct {
	mu          sync.RWMutex
	pool        *clashpool.Manager
	slots       map[string]Slot
	usedNodes   map[string]string // clashNodeID -> slotID
	usedExitIPs map[string]string // exitIP -> slotID
}

// NewManager constructs a VM slot coordinator backed by a Clash exit pool.
func NewManager(pool *clashpool.Manager) *Manager {
	return &Manager{
		pool:        pool,
		slots:       make(map[string]Slot),
		usedNodes:   make(map[string]string),
		usedExitIPs: make(map[string]string),
	}
}

// ProvisionSlot registers or updates a VM slot while enforcing hardware immutability and 1-slot-1-egress.
func (m *Manager) ProvisionSlot(spec Slot) (Slot, error) {
	spec.ID = strings.TrimSpace(spec.ID)
	spec.ClusterNodeID = strings.TrimSpace(spec.ClusterNodeID)
	spec.AccountID = strings.TrimSpace(spec.AccountID)
	spec.ClashNodeID = strings.TrimSpace(spec.ClashNodeID)

	if spec.ID == "" || spec.AccountID == "" {
		return Slot{}, fmt.Errorf("%w: slot id and accountId are required", ErrInvalidHardwarePersona)
	}
	if spec.ClusterNodeID == "" {
		spec.ClusterNodeID = "local-node"
	}
	if err := ValidatePersona(spec.Persona); err != nil {
		return Slot{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, exists := m.slots[spec.ID]; exists {
		if existing.Persona.GuestMachineID != spec.Persona.GuestMachineID {
			return Slot{}, ErrImmutableMachineID
		}
		if spec.ClashNodeID == "" {
			spec.ClashNodeID = existing.ClashNodeID
		}
		if spec.CreatedAt.IsZero() {
			spec.CreatedAt = existing.CreatedAt
		}
	}

	if spec.ClashNodeID == "" {
		return Slot{}, fmt.Errorf("%w: clashNodeId is required", ErrSlotEgressUnavailable)
	}
	if m.pool != nil {
		node, ok := m.pool.GetNode(spec.ClashNodeID)
		if !ok || !node.Enabled || node.Health != clashpool.HealthHealthy || node.DriftUnconfirmed || strings.TrimSpace(node.ExitIP) == "" {
			return Slot{}, fmt.Errorf("%w: clash node %q is unavailable", ErrSlotEgressUnavailable, spec.ClashNodeID)
		}
		spec.ExitIP = node.ExitIP
	}

	if owner, taken := m.usedNodes[spec.ClashNodeID]; taken && owner != spec.ID {
		return Slot{}, ErrSharedSlotEgress
	}
	if spec.ExitIP != "" {
		if owner, taken := m.usedExitIPs[spec.ExitIP]; taken && owner != spec.ID {
			return Slot{}, ErrSharedSlotEgress
		}
	}

	if spec.MaxSubagents == 0 {
		spec.MaxSubagents = 20
	}
	if spec.MemoryMiB < 512 {
		spec.MemoryMiB = 2048
	}
	if spec.Telemetry == "" {
		spec.Telemetry = TelemetryIsolated
	}
	if spec.CleanseMode == "" {
		spec.CleanseMode = "zero"
	}
	if spec.Hypervisor == "" {
		spec.Hypervisor = HypervisorDocker
	}
	if spec.State == "" {
		spec.State = StateReady
	}
	now := time.Now().UTC()
	if spec.CreatedAt.IsZero() {
		spec.CreatedAt = now
	}
	spec.UpdatedAt = now

	if old, ok := m.slots[spec.ID]; ok {
		if old.ClashNodeID != "" && old.ClashNodeID != spec.ClashNodeID {
			delete(m.usedNodes, old.ClashNodeID)
		}
		if old.ExitIP != "" && old.ExitIP != spec.ExitIP {
			delete(m.usedExitIPs, old.ExitIP)
		}
	}

	m.slots[spec.ID] = cloneSlot(spec)
	m.usedNodes[spec.ClashNodeID] = spec.ID
	if spec.ExitIP != "" {
		m.usedExitIPs[spec.ExitIP] = spec.ID
	}
	return cloneSlot(spec), nil
}

// UpsertRestoredSlot loads a persisted slot during startup without blocking on initial Clash probes.
func (m *Manager) UpsertRestoredSlot(s Slot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.slots[s.ID] = cloneSlot(s)
	if s.ClashNodeID != "" {
		m.usedNodes[s.ClashNodeID] = s.ID
	}
	if s.ExitIP != "" {
		m.usedExitIPs[s.ExitIP] = s.ID
	}
}

// GetSlot returns a copy of a registered VM slot by ID.
func (m *Manager) GetSlot(slotID string) (Slot, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.slots[slotID]
	if !ok {
		return Slot{}, false
	}
	return cloneSlot(s), true
}

// GetSlotByAccount returns the first slot bound to accountID, if any.
func (m *Manager) GetSlotByAccount(accountID string) (Slot, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.slots {
		if s.AccountID == accountID {
			return cloneSlot(s), true
		}
	}
	return Slot{}, false
}

// SetState updates lifecycle state on an existing slot.
func (m *Manager) SetState(slotID string, state SlotState) (Slot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	s.State = state
	if state == StateStopped {
		s.GuestPID = 0
	}
	s.UpdatedAt = time.Now().UTC()
	m.slots[slotID] = s
	return cloneSlot(s), nil
}

// SetTelemetry updates telemetry and cleanse policies on an existing slot.
func (m *Manager) SetTelemetry(slotID string, mode TelemetryMode, cleanseMode string) (Slot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	if mode != "" {
		s.Telemetry = mode
	}
	if cleanseMode != "" {
		s.CleanseMode = cleanseMode
	}
	s.UpdatedAt = time.Now().UTC()
	m.slots[slotID] = s
	return cloneSlot(s), nil
}

// UpdateGuestRuntime updates materialized workspace path, socket/TCP endpoint, guest PID, and heartbeat timestamp.
func (m *Manager) UpdateGuestRuntime(slotID, rootDir, udsPath, daemonVer string, pid int, heartbeat *time.Time) (Slot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	if rootDir != "" {
		s.RootDir = rootDir
	}
	if udsPath != "" {
		s.GuestUDSPath = udsPath
	}
	if daemonVer != "" {
		s.DaemonVersion = daemonVer
	}
	s.GuestPID = pid
	if heartbeat != nil {
		hb := heartbeat.UTC()
		s.LastHeartbeat = &hb
	}
	s.UpdatedAt = time.Now().UTC()
	m.slots[slotID] = s
	return cloneSlot(s), nil
}

// DeleteSlot removes a slot from the manager and frees its 1-slot-1-egress reservations.
func (m *Manager) DeleteSlot(slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return ErrSlotNotFound
	}
	if s.ClashNodeID != "" && m.usedNodes[s.ClashNodeID] == slotID {
		delete(m.usedNodes, s.ClashNodeID)
	}
	if s.ExitIP != "" && m.usedExitIPs[s.ExitIP] == slotID {
		delete(m.usedExitIPs, s.ExitIP)
	}
	delete(m.slots, slotID)
	return nil
}

// AcquireSubagentSeat reserves one concurrent subagent execution slot inside a Ready VM.
func (m *Manager) AcquireSubagentSeat(slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return ErrSlotNotFound
	}
	if s.State != StateReady {
		return ErrSlotNotReady
	}
	if s.ActiveSubagents >= s.MaxSubagents {
		return ErrSubagentCapacityFull
	}
	s.ActiveSubagents++
	s.UpdatedAt = time.Now().UTC()
	m.slots[slotID] = s
	return nil
}

// ReleaseSubagentSeat frees one subagent execution slot.
func (m *Manager) ReleaseSubagentSeat(slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return ErrSlotNotFound
	}
	if s.ActiveSubagents > 0 {
		s.ActiveSubagents--
		s.UpdatedAt = time.Now().UTC()
		m.slots[slotID] = s
	}
	return nil
}

// MigrateOrResizeSlot moves a drained KVM slot to another cluster node or resizes RAM without altering AccountID or GuestMachineID.
func (m *Manager) MigrateOrResizeSlot(slotID, targetClusterNodeID string, targetMemoryMiB uint32) (Slot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[slotID]
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	if s.Hypervisor != HypervisorKVM {
		return Slot{}, ErrMigrationUnsupported
	}
	if s.ActiveSubagents > 0 {
		return Slot{}, ErrSlotNotDrained
	}
	if strings.TrimSpace(targetClusterNodeID) != "" {
		s.ClusterNodeID = strings.TrimSpace(targetClusterNodeID)
	}
	if targetMemoryMiB >= 512 {
		s.MemoryMiB = targetMemoryMiB
	}
	s.UpdatedAt = time.Now().UTC()
	m.slots[slotID] = s
	return cloneSlot(s), nil
}

// Snapshot returns copies of all registered VM slots sorted deterministically by ID.
func (m *Manager) Snapshot() []Slot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Slot, 0, len(m.slots))
	for _, s := range m.slots {
		out = append(out, cloneSlot(s))
	}
	slices.SortFunc(out, func(a, b Slot) int { return strings.Compare(a.ID, b.ID) })
	return out
}

func cloneSlot(s Slot) Slot {
	out := s
	if s.LastHeartbeat != nil {
		hb := *s.LastHeartbeat
		out.LastHeartbeat = &hb
	}
	return out
}
