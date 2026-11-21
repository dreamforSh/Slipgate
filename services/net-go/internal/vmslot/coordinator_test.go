package vmslot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

func TestCoordinatorLifecycleFailClosedSeedTerminalAndMigration(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	pool := clashpool.NewManager(20000, 24999, 1)
	_, err := pool.SyncNodes("sub-1", []clashpool.Node{
		{
			ID:            "node-exit-1",
			Name:          "Tokyo-Edge-1",
			ProxySlotID:   "ps-1",
			ListenerPort:  20111,
			SocksUsername: "u1",
			SocksPassword: "p1",
			ExitIP:        "203.0.113.10",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
		{
			ID:            "node-exit-2",
			Name:          "Singapore-Edge-2",
			ProxySlotID:   "ps-2",
			ListenerPort:  20112,
			SocksUsername: "u2",
			SocksPassword: "p2",
			ExitIP:        "198.51.100.20",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	if err := pool.BindAccount("acc-1", "node-exit-1", false); err != nil {
		t.Fatalf("BindAccount acc-1 failed: %v", err)
	}

	coord := NewCoordinator(CoordinatorOptions{
		Manager:   NewManager(pool),
		ClashPool: pool,
		Store:     NewMemoryVmStore(),
		VMDataDir: t.TempDir(),
	})
	if err := coord.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap failed: %v", err)
	}

	overview, err := coord.Overview(ctx)
	if err != nil {
		t.Fatalf("Overview failed: %v", err)
	}
	if len(overview.Nodes) != 1 || overview.Nodes[0].ID != LocalNodeID {
		t.Fatalf("expected bootstrapped local-node, got %+v", overview.Nodes)
	}

	// 1. Fail closed when account has no healthy Clash exit binding.
	if _, err := coord.ProvisionSlot(ctx, ProvisionSlotInput{
		ID:        "vm-unbound",
		AccountID: "acc-unbound",
	}); !errors.Is(err, ErrSlotEgressUnavailable) {
		t.Fatalf("expected ErrSlotEgressUnavailable for unbound account, got %v", err)
	}

	// 2. Register target KVM node for migration test.
	if _, err := coord.RegisterClusterNode(ctx, RegisterClusterNodeInput{
		ID:            "node-remote-kvm",
		Name:          "Tokyo-KVM-2",
		DriverKind:    "local",
		SSHAddr:       "127.0.0.1:2222",
		KVMCapable:    true,
		DockerCapable: true,
	}); err != nil {
		t.Fatalf("RegisterClusterNode failed: %v", err)
	}

	// 3. Provision slot using bound Clash exit.
	slot, err := coord.ProvisionSlot(ctx, ProvisionSlotInput{
		ID:             "vm-slot-1",
		ClusterNodeID:  LocalNodeID,
		AccountID:      "acc-1",
		HypervisorKind: HypervisorKVM,
	})
	if err != nil {
		t.Fatalf("ProvisionSlot failed: %v", err)
	}
	if slot.ExitIP != "203.0.113.10" || slot.State != StateReady || slot.MaxSubagents != 20 {
		t.Fatalf("unexpected provisioned slot: %+v", slot)
	}
	machineIDFile, err := os.ReadFile(filepath.Join(slot.RootDir, "etc", "machine-id"))
	if err != nil {
		t.Fatalf("read etc/machine-id: %v", err)
	}
	if strings.TrimSpace(string(machineIDFile)) != slot.Persona.GuestMachineID {
		t.Fatalf("etc/machine-id mismatch: file=%q persona=%q", string(machineIDFile), slot.Persona.GuestMachineID)
	}

	// 4. Reject second slot trying to reuse the same Clash node / exit IP.
	if _, err := coord.ProvisionSlot(ctx, ProvisionSlotInput{
		ID:          "vm-slot-dup",
		AccountID:   "acc-2",
		ClashNodeID: "node-exit-1",
	}); !errors.Is(err, ErrSharedSlotEgress) {
		t.Fatalf("expected ErrSharedSlotEgress, got %v", err)
	}

	// 5. Seed update + telemetry switch.
	updatedSettings := `{"cleanupPeriodDays":14,"includeCoAuthoredBy":false}`
	seed, err := coord.UpdateSeed(ctx, slot.ID, UpdateSeedInput{SettingsJSONRaw: &updatedSettings}, "ci-admin")
	if err != nil || !strings.Contains(seed.SettingsJSONRaw, `"cleanupPeriodDays":14`) {
		t.Fatalf("UpdateSeed failed: seed=%+v err=%v", seed, err)
	}
	slot, err = coord.UpdateTelemetry(ctx, slot.ID, TelemetryDisabled, "official")
	if err != nil || slot.Telemetry != TelemetryDisabled || slot.CleanseMode != "official" {
		t.Fatalf("UpdateTelemetry failed: slot=%+v err=%v", slot, err)
	}

	// 6. Terminal ticket single-use + jailed command execution & traversal rejection.
	ticket, err := coord.IssueTerminalTicket(slot.ID, "ci-admin")
	if err != nil || !strings.HasPrefix(ticket.WSPath, "/ws/admin/vms/terminal/") {
		t.Fatalf("IssueTerminalTicket failed: %+v err=%v", ticket, err)
	}
	consumed, err := coord.ConsumeTerminalTicket(ticket.Ticket)
	if err != nil || consumed.SlotID != slot.ID {
		t.Fatalf("ConsumeTerminalTicket failed: %v", err)
	}
	if _, err := coord.ConsumeTerminalTicket(ticket.Ticket); !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("expected single-use ticket replay rejection, got %v", err)
	}

	resMID, err := coord.ExecSlotCommand(ctx, slot.ID, "ci-admin", "machine-id")
	if err != nil || strings.TrimSpace(resMID.Stdout) != slot.Persona.GuestMachineID {
		t.Fatalf("machine-id command mismatch: res=%+v err=%v", resMID, err)
	}
	resTrav, _ := coord.ExecSlotCommand(ctx, slot.ID, "ci-admin", "cat ../../etc/passwd")
	if resTrav.ExitCode == 0 {
		t.Fatalf("expected traversal outside slot root to fail, got %+v", resTrav)
	}

	// 7. KVM migration works once drained and blocks if active subagent seat is held.
	if err := coord.mgr.AcquireSubagentSeat(slot.ID); err != nil {
		t.Fatalf("AcquireSubagentSeat failed: %v", err)
	}
	if _, _, err := coord.MigrateOrResizeSlot(ctx, slot.ID, "node-remote-kvm", 4096); !errors.Is(err, ErrSlotNotDrained) {
		t.Fatalf("expected ErrSlotNotDrained during migration, got %v", err)
	}
	_ = coord.mgr.ReleaseSubagentSeat(slot.ID)
	migrated, job, err := coord.MigrateOrResizeSlot(ctx, slot.ID, "node-remote-kvm", 4096)
	if err != nil || migrated.ClusterNodeID != "node-remote-kvm" || migrated.MemoryMiB != 4096 || job.Status != "completed" {
		t.Fatalf("MigrateOrResizeSlot failed: migrated=%+v job=%+v err=%v", migrated, job, err)
	}

	// 8. Stop + Destroy cleans up read-only etc/machine-id safely (Windows included).
	if _, err := coord.StopSlot(ctx, slot.ID); err != nil {
		t.Fatalf("StopSlot failed: %v", err)
	}
	if err := coord.DeleteSlot(ctx, slot.ID); err != nil {
		t.Fatalf("DeleteSlot failed: %v", err)
	}
	if _, statErr := os.Stat(slot.RootDir); !os.IsNotExist(statErr) {
		t.Fatalf("expected slot directory %q to be deleted cleanly, statErr=%v", slot.RootDir, statErr)
	}

	// 9. Provision Antigravity and Codex CLI VM slots and verify materialized runtime workspaces & cleanup.
	pool.UnbindAccount("acc-1")
	if err := pool.BindAccount("acc-ag", "node-exit-1", false); err != nil {
		t.Fatalf("BindAccount acc-ag failed: %v", err)
	}
	if err := pool.BindAccount("acc-codex", "node-exit-2", false); err != nil {
		t.Fatalf("BindAccount acc-codex failed: %v", err)
	}

	agSlot, err := coord.ProvisionSlot(ctx, ProvisionSlotInput{
		ID:             "vm-antigravity-1",
		AccountID:      "acc-ag",
		RuntimeProfile: RuntimeAntigravity,
	})
	if err != nil {
		t.Fatalf("ProvisionSlot Antigravity failed: %v", err)
	}
	if agSlot.RuntimeProfile != RuntimeAntigravity {
		t.Fatalf("expected runtimeProfile=antigravity, got %q", agSlot.RuntimeProfile)
	}
	agMachineBytes, err := os.ReadFile(filepath.Join(agSlot.RootDir, "home", "runner", ".antigravity", "machineid"))
	if err != nil || strings.TrimSpace(string(agMachineBytes)) != agSlot.Persona.GuestMachineID {
		t.Fatalf("antigravity machineid mismatch: %q err=%v", string(agMachineBytes), err)
	}
	agRes, err := coord.ExecSlotCommand(ctx, agSlot.ID, "ci-admin", "runtime")
	if err != nil || !strings.Contains(agRes.Stdout, "cloudcode-pa.googleapis.com") {
		t.Fatalf("unexpected antigravity runtime inspection: %+v err=%v", agRes, err)
	}

	codexSlot, err := coord.ProvisionSlot(ctx, ProvisionSlotInput{
		ID:             "vm-codex-1",
		AccountID:      "acc-codex",
		RuntimeProfile: RuntimeCodexCLI,
	})
	if err != nil {
		t.Fatalf("ProvisionSlot Codex failed: %v", err)
	}
	codexRes, err := coord.ExecSlotCommand(ctx, codexSlot.ID, "ci-admin", "runtime")
	if err != nil || !strings.Contains(codexRes.Stdout, "gpt-5-codex") || !strings.Contains(codexRes.Stdout, `exporter = "none"`) {
		t.Fatalf("unexpected codex runtime inspection: %+v err=%v", codexRes, err)
	}

	if err := coord.DeleteSlot(ctx, agSlot.ID); err != nil {
		t.Fatalf("DeleteSlot Antigravity (read-only machineid) failed: %v", err)
	}
	if err := coord.DeleteSlot(ctx, codexSlot.ID); err != nil {
		t.Fatalf("DeleteSlot Codex failed: %v", err)
	}
}
