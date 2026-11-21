package vmslot

import (
	"errors"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

func setupClashPool(t *testing.T) *clashpool.Manager {
	t.Helper()
	pool := clashpool.NewManager(20000, 24999, 1)
	_, err := pool.SyncNodes("sub-vm", []clashpool.Node{
		{
			ID:             "clash-1",
			SubscriptionID: "sub-vm",
			Name:           "Exit-1",
			ProxySlotID:    "slot-1",
			ListenerPort:   20101,
			ExitIP:         "203.0.113.101",
			Health:         clashpool.HealthHealthy,
			Enabled:        true,
		},
		{
			ID:             "clash-2",
			SubscriptionID: "sub-vm",
			Name:           "Exit-2-SameIP",
			ProxySlotID:    "slot-2",
			ListenerPort:   20102,
			ExitIP:         "203.0.113.101", // deliberately shares exit IP with clash-1
			Health:         clashpool.HealthHealthy,
			Enabled:        true,
		},
		{
			ID:             "clash-3",
			SubscriptionID: "sub-vm",
			Name:           "Exit-3",
			ProxySlotID:    "slot-3",
			ListenerPort:   20103,
			ExitIP:         "198.51.100.103",
			Health:         clashpool.HealthHealthy,
			Enabled:        true,
		},
	}, false)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	return pool
}

func validPersona(machineID, mac, uuid string) HardwarePersona {
	return HardwarePersona{
		GuestMachineID: machineID,
		MACAddress:     mac,
		SMBIOSUUID:     uuid,
		SMBIOSSerial:   "SG-SERIAL-01",
		CPUModel:       "AMD EPYC 9354",
		CPUCores:       4,
		Timezone:       "Asia/Tokyo",
	}
}

func TestOneSlotOneEgressAndImmutableMachineID(t *testing.T) {
	t.Parallel()

	mgr := NewManager(setupClashPool(t))
	_, err := mgr.ProvisionSlot(Slot{
		ID:            "vm-01",
		ClusterNodeID: "vps-tokyo-01",
		AccountID:     "acc-01",
		ClashNodeID:   "clash-1",
		Hypervisor:    HypervisorKVM,
		Persona:       validPersona("a1b2c3d4e5f60718293a4b5c6d7e8f90", "02:42:ac:11:00:02", "11111111-2222-3333-4444-555555555555"),
	})
	if err != nil {
		t.Fatalf("ProvisionSlot vm-01 failed: %v", err)
	}

	// Reject second slot using a different Clash listener that lands on the same Exit IP.
	_, err = mgr.ProvisionSlot(Slot{
		ID:            "vm-02",
		ClusterNodeID: "vps-tokyo-01",
		AccountID:     "acc-02",
		ClashNodeID:   "clash-2",
		Hypervisor:    HypervisorKVM,
		Persona:       validPersona("b1b2c3d4e5f60718293a4b5c6d7e8f91", "02:42:ac:11:00:03", "21111111-2222-3333-4444-555555555555"),
	})
	if !errors.Is(err, ErrSharedSlotEgress) {
		t.Fatalf("expected ErrSharedSlotEgress, got %v", err)
	}

	// Reject all-zero machine-id.
	_, err = mgr.ProvisionSlot(Slot{
		ID:            "vm-bad",
		ClusterNodeID: "vps-tokyo-01",
		AccountID:     "acc-03",
		ClashNodeID:   "clash-3",
		Hypervisor:    HypervisorKVM,
		Persona:       validPersona("00000000000000000000000000000000", "02:42:ac:11:00:04", "31111111-2222-3333-4444-555555555555"),
	})
	if !errors.Is(err, ErrInvalidHardwarePersona) {
		t.Fatalf("expected ErrInvalidHardwarePersona on all-zero machine_id, got %v", err)
	}

	// Reject mutating guest_machine_id on existing slot.
	_, err = mgr.ProvisionSlot(Slot{
		ID:            "vm-01",
		ClusterNodeID: "vps-tokyo-01",
		AccountID:     "acc-01",
		ClashNodeID:   "clash-1",
		Hypervisor:    HypervisorKVM,
		Persona:       validPersona("ffffffffffffffffffffffffffffffff", "02:42:ac:11:00:02", "11111111-2222-3333-4444-555555555555"),
	})
	if !errors.Is(err, ErrImmutableMachineID) {
		t.Fatalf("expected ErrImmutableMachineID, got %v", err)
	}
}

func TestSubagentSeatsAndKvmMigrationDrainGuard(t *testing.T) {
	t.Parallel()

	mgr := NewManager(setupClashPool(t))
	_, err := mgr.ProvisionSlot(Slot{
		ID:            "vm-01",
		ClusterNodeID: "vps-tokyo-01",
		AccountID:     "acc-01",
		ClashNodeID:   "clash-1",
		Hypervisor:    HypervisorKVM,
		Persona:       validPersona("a1b2c3d4e5f60718293a4b5c6d7e8f90", "02:42:ac:11:00:02", "11111111-2222-3333-4444-555555555555"),
	})
	if err != nil {
		t.Fatalf("ProvisionSlot failed: %v", err)
	}

	// Default max concurrency is 20 subagent seats.
	for i := 0; i < 20; i++ {
		if err := mgr.AcquireSubagentSeat("vm-01"); err != nil {
			t.Fatalf("AcquireSubagentSeat %d failed: %v", i, err)
		}
	}
	if err := mgr.AcquireSubagentSeat("vm-01"); !errors.Is(err, ErrSubagentCapacityFull) {
		t.Fatalf("expected ErrSubagentCapacityFull on 21st seat, got %v", err)
	}

	// Migration must block while active subagents remain.
	if _, err := mgr.MigrateOrResizeSlot("vm-01", "vps-sg-02", 4096); !errors.Is(err, ErrSlotNotDrained) {
		t.Fatalf("expected ErrSlotNotDrained, got %v", err)
	}

	for i := 0; i < 20; i++ {
		if err := mgr.ReleaseSubagentSeat("vm-01"); err != nil {
			t.Fatalf("ReleaseSubagentSeat failed: %v", err)
		}
	}

	migrated, err := mgr.MigrateOrResizeSlot("vm-01", "vps-sg-02", 4096)
	if err != nil {
		t.Fatalf("MigrateOrResizeSlot failed after drain: %v", err)
	}
	if migrated.ClusterNodeID != "vps-sg-02" || migrated.MemoryMiB != 4096 || migrated.AccountID != "acc-01" {
		t.Fatalf("unexpected migrated slot state: %+v", migrated)
	}
}
