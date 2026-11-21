package vmslot

import (
	"errors"
	"fmt"
	"strings"
	"sync"

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
)

// HardwarePersona describes the physical fingerprint injected into a VM/container slot.
type HardwarePersona struct {
	GuestMachineID string
	MACAddress     string
	SMBIOSUUID     string
	SMBIOSSerial   string
	CPUModel       string
	CPUCores       uint32
	Timezone       string
	DoHURL         string
}

// Slot represents a running or stopped full-emulation VM/container account slot.
type Slot struct {
	ID              string
	ClusterNodeID   string
	AccountID       string
	ClashNodeID     string
	ExitIP          string
	Hypervisor      HypervisorKind
	State           SlotState
	VsockCID        uint32
	GuestUDSPath    string
	ActiveSubagents uint32
	MaxSubagents    uint32
	Telemetry       TelemetryMode
	MemoryMiB       uint32
	Persona         HardwarePersona
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
	mu    sync.RWMutex
	pool  *clashpool.Manager
	slots map[string]*Slot
}

// NewManager constructs a VM slot coordinator backed by a Clash exit pool.
func NewManager(pool *clashpool.Manager) *Manager {
	return &Manager{
		pool:  pool,
		slots: make(map[string]*Slot),
	}
}

// ProvisionSlot registers or updates a VM slot while enforcing hardware immutability and 1-slot-1-egress.
func (m *Manager) ProvisionSlot(spec Slot) (Slot, error) {
	if err := ValidatePersona(spec.Persona); err != nil {
		return Slot{}, err
	}
	if strings.TrimSpace(spec.ID) == "" || strings.TrimSpace(spec.AccountID) == "" {
		return Slot{}, errors.New("vmslot: slot id and account id are required")
	}
	if m.pool == nil {
		return Slot{}, clashpool.ErrExitCircuitOpen
	}

	clashNode, ok := m.pool.GetNode(spec.ClashNodeID)
	if !ok {
		return Slot{}, clashpool.ErrNodeNotFound
	}
	if !clashNode.Enabled || clashNode.Health != clashpool.HealthHealthy || clashNode.DriftUnconfirmed || clashNode.ExitIP == "" {
		return Slot{}, fmt.Errorf("%w: clash node %s is not healthy/probed", clashpool.ErrExitCircuitOpen, spec.ClashNodeID)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, exists := m.slots[spec.ID]; exists {
		if existing.Persona.GuestMachineID != spec.Persona.GuestMachineID {
			return Slot{}, ErrImmutableMachineID
		}
	}

	for id, existing := range m.slots {
		if id == spec.ID {
			continue
		}
		if existing.ClashNodeID == spec.ClashNodeID || existing.ExitIP == clashNode.ExitIP {
			return Slot{}, fmt.Errorf("%w: node=%s exit_ip=%s already assigned to slot=%s", ErrSharedSlotEgress, spec.ClashNodeID, clashNode.ExitIP, id)
		}
	}

	copySlot := spec
	copySlot.ExitIP = clashNode.ExitIP
	if copySlot.MaxSubagents == 0 {
		copySlot.MaxSubagents = 20
	}
	if copySlot.MemoryMiB == 0 {
		copySlot.MemoryMiB = 2048
	}
	if copySlot.Telemetry == "" {
		copySlot.Telemetry = TelemetryIsolated
	}
	if copySlot.State == "" {
		copySlot.State = StateReady
	}
	m.slots[spec.ID] = &copySlot
	return copySlot, nil
}

// AcquireSubagentSeat reserves one concurrent subagent execution slot inside a Ready VM.
func (m *Manager) AcquireSubagentSeat(slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	slot, ok := m.slots[slotID]
	if !ok {
		return ErrSlotNotFound
	}
	if slot.State != StateReady {
		return fmt.Errorf("%w: state=%s", ErrSlotNotReady, slot.State)
	}
	if slot.ActiveSubagents >= slot.MaxSubagents {
		return fmt.Errorf("%w: %d/%d", ErrSubagentCapacityFull, slot.ActiveSubagents, slot.MaxSubagents)
	}
	slot.ActiveSubagents++
	return nil
}

// ReleaseSubagentSeat frees one subagent execution slot.
func (m *Manager) ReleaseSubagentSeat(slotID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	slot, ok := m.slots[slotID]
	if !ok {
		return ErrSlotNotFound
	}
	if slot.ActiveSubagents > 0 {
		slot.ActiveSubagents--
	}
	return nil
}

// MigrateOrResizeSlot moves a drained KVM slot to another cluster node or resizes RAM without altering AccountID or GuestMachineID.
func (m *Manager) MigrateOrResizeSlot(slotID, targetClusterNodeID string, targetMemoryMiB uint32) (Slot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	slot, ok := m.slots[slotID]
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	if slot.Hypervisor != HypervisorKVM {
		return Slot{}, ErrMigrationUnsupported
	}
	if slot.ActiveSubagents > 0 {
		return Slot{}, fmt.Errorf("%w: active_subagents=%d", ErrSlotNotDrained, slot.ActiveSubagents)
	}
	if strings.TrimSpace(targetClusterNodeID) != "" {
		slot.ClusterNodeID = targetClusterNodeID
	}
	if targetMemoryMiB >= 512 {
		slot.MemoryMiB = targetMemoryMiB
	}
	return *slot, nil
}

// Snapshot returns copies of all registered VM slots.
func (m *Manager) Snapshot() []Slot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Slot, 0, len(m.slots))
	for _, s := range m.slots {
		out = append(out, *s)
	}
	return out
}
