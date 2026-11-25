package vmslot

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

// TestMain lets the test binary double as slipgate-guestd: started with GO_WANT_GUESTD_HELPER=1
// it answers IPC pings on SLIPGATE_GUEST_ADDR, except for slots whose id starts with "vm-bad",
// which exit at once (a daemon that never comes up).
func TestMain(m *testing.M) {
	if os.Getenv("GO_WANT_GUESTD_HELPER") == "1" {
		runFakeGuestd()
		return
	}
	os.Exit(m.Run())
}

func runFakeGuestd() {
	if strings.HasPrefix(os.Getenv("SLIPGATE_SLOT_ID"), "vm-bad") {
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", os.Getenv("SLIPGATE_GUEST_ADDR"))
	if err != nil {
		os.Exit(3)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			os.Exit(0)
		}
		go func(c net.Conn) {
			defer c.Close()
			if _, err := dpbridge.ReadFrame(c); err != nil {
				return
			}
			_ = dpbridge.WriteFrame(c, dpbridge.Frame{Type: dpbridge.FramePong, Flags: dpbridge.FlagEndStream, Payload: []byte("pong")})
		}(conn)
	}
}

// After a restart the previous edge has stopped every local guest daemon; Bootstrap must start
// them again for slots that were serving, and fail closed for a slot whose daemon stays down.
func TestBootstrapRestartsLocalGuestdForServingSlots(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	t.Setenv("GO_WANT_GUESTD_HELPER", "1")
	t.Setenv("SLIPGATE_GUEST_TOKEN", "")

	ctx := context.Background()
	store := NewMemoryVmStore()
	if err := store.Init(ctx); err != nil {
		t.Fatalf("store init: %v", err)
	}
	previous := []Slot{
		{ID: "vm-ready", ClusterNodeID: LocalNodeID, AccountID: "acc-ready", State: StateReady, GuestPID: 4242, GuestUDSPath: "tcp://127.0.0.1:1", DaemonVersion: "slipgate-guestd/0.2.0"},
		{ID: "vm-bad-1", ClusterNodeID: LocalNodeID, AccountID: "acc-bad", State: StateReady, GuestPID: 4343, GuestUDSPath: "tcp://127.0.0.1:2"},
		{ID: "vm-stopped", ClusterNodeID: LocalNodeID, AccountID: "acc-stopped", State: StateStopped},
		{ID: "vm-remote", ClusterNodeID: "node-remote", AccountID: "acc-remote", State: StateReady, GuestUDSPath: "ssh://10.0.0.5"},
	}
	for _, s := range previous {
		if err := store.UpsertSlot(ctx, s); err != nil {
			t.Fatalf("seed slot %s: %v", s.ID, err)
		}
	}

	vmDir := t.TempDir()
	for _, s := range previous {
		// Slot directories persist across restarts (they hold the immutable machine-id).
		if err := os.MkdirAll(filepath.Join(vmDir, "slots", s.ID), 0o755); err != nil {
			t.Fatalf("mkdir slot dir: %v", err)
		}
	}
	coord := NewCoordinator(CoordinatorOptions{Store: store, VMDataDir: vmDir, GuestdBin: exe})
	defer coord.Shutdown()
	if err := coord.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	slots := map[string]Slot{}
	for _, s := range coord.ListSlots() {
		slots[s.ID] = s
	}
	ready := slots["vm-ready"]
	if ready.State != StateReady || ready.GuestPID <= 0 || ready.GuestPID == 4242 || !strings.HasPrefix(ready.GuestUDSPath, "tcp://127.0.0.1:") {
		t.Fatalf("expected the ready slot's daemon to be running again, got %+v", ready)
	}
	if err := dpbridge.PingAuth(ctx, ready.GuestUDSPath, ""); err != nil {
		t.Fatalf("restarted daemon does not answer on %s: %v", ready.GuestUDSPath, err)
	}
	if bad := slots["vm-bad-1"]; bad.State != StateStopped || bad.GuestPID != 0 || strings.HasPrefix(bad.GuestUDSPath, "tcp://") {
		t.Fatalf("a slot whose daemon does not come back must fail closed (stopped, no endpoint), got %+v", bad)
	}
	if stopped := slots["vm-stopped"]; stopped.State != StateStopped || stopped.GuestPID != 0 {
		t.Fatalf("a stopped slot must stay stopped, got %+v", stopped)
	}
	if remote := slots["vm-remote"]; remote.GuestUDSPath != "ssh://10.0.0.5" {
		t.Fatalf("remote slots are not the local driver's, got %+v", remote)
	}
	persisted, err := store.ListSlots(ctx)
	if err != nil {
		t.Fatalf("list persisted slots: %v", err)
	}
	for _, s := range persisted {
		if s.ID == "vm-ready" && s.GuestPID != ready.GuestPID {
			t.Fatalf("the new daemon must be persisted, store has %+v", s)
		}
		if s.ID == "vm-bad-1" && s.State != StateStopped {
			t.Fatalf("the failed slot must be persisted as stopped, store has %+v", s)
		}
	}
}

func TestLocalDriverGuestdBinSwap(t *testing.T) {
	t.Parallel()

	d := NewLocalSlotDriver(t.TempDir(), "")
	if d.GuestdAvailable() {
		t.Fatalf("no guestd configured yet")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	d.SetGuestdBin(" " + exe + " ")
	if !d.GuestdAvailable() || d.GuestdBin() != exe {
		t.Fatalf("expected the swapped guestd binary to be used, got %q", d.GuestdBin())
	}
}
