package vmslot

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

// Graceful slipgate-guestd supervision: blue/green replacement, draining in-flight exchanges
// before a daemon is stopped, keeping the running daemon when its replacement fails, reaping,
// and rolling every serving slot onto a new binary. The test binary doubles as guestd (TestMain).

func fakeGuestdDriver(t *testing.T) (*LocalSlotDriver, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	t.Setenv("GO_WANT_GUESTD_HELPER", "1")
	t.Setenv("SLIPGATE_GUEST_TOKEN", "")
	d := NewLocalSlotDriver(t.TempDir(), exe)
	d.settle, d.drain, d.term = 20*time.Millisecond, 5*time.Second, 2*time.Second
	return d, exe
}

func startFakeSlot(t *testing.T, d *LocalSlotDriver, id string) Slot {
	t.Helper()
	root, err := d.slotRootDir(id)
	if err != nil {
		t.Fatalf("slot dir: %v", err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir slot dir: %v", err)
	}
	slot, err := d.StartSlot(context.Background(), ClusterNode{}, Slot{ID: id, ClusterNodeID: LocalNodeID, State: StateReady, RootDir: root})
	if err != nil {
		t.Fatalf("StartSlot(%s): %v", id, err)
	}
	t.Cleanup(func() { d.retireSlot(id) })
	return slot
}

func answers(endpoint string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return dpbridge.PingAuth(ctx, endpoint, "") == nil
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatalf("open %s: %v", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatalf("create %s: %v", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatalf("copy to %s: %v", dst, err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("close %s: %v", dst, err)
	}
}

// A restart publishes the new daemon first and stops the old one only after the exchange still
// in flight on it has finished.
func TestRestartSlotIsBlueGreenAndDrainsTheOldDaemon(t *testing.T) {
	d, _ := fakeGuestdDriver(t)
	first := startFakeSlot(t, d, "vm-bluegreen")
	if !answers(first.GuestUDSPath) {
		t.Fatalf("first daemon does not answer on %s", first.GuestUDSPath)
	}

	done := beginGuestCall(first.GuestUDSPath) // a turn handoff still talking to the old daemon
	published := make(chan Slot, 1)
	restarted := make(chan Slot, 1)
	go func() {
		next, err := d.RestartSlot(context.Background(), first, func(s Slot) error {
			published <- s
			return nil
		})
		if err != nil {
			t.Errorf("RestartSlot: %v", err)
		}
		restarted <- next
	}()

	next := <-published
	if next.GuestUDSPath == first.GuestUDSPath || next.GuestPID == first.GuestPID {
		t.Fatalf("expected a new daemon on a fresh endpoint, got %+v", next)
	}
	if !answers(next.GuestUDSPath) {
		t.Fatalf("new daemon must already answer when it is published")
	}
	time.Sleep(200 * time.Millisecond)
	if !answers(first.GuestUDSPath) {
		t.Fatalf("the old daemon was stopped while an exchange was still in flight on it")
	}
	select {
	case <-restarted:
		t.Fatalf("RestartSlot returned before the old daemon drained")
	default:
	}

	done()
	select {
	case <-restarted:
	case <-time.After(5 * time.Second):
		t.Fatalf("RestartSlot did not finish after the in-flight exchange ended")
	}
	if answers(first.GuestUDSPath) {
		t.Fatalf("the old daemon must be gone once it has drained")
	}
	if !answers(next.GuestUDSPath) {
		t.Fatalf("the new daemon must keep serving")
	}
}

// When the replacement cannot start, the running daemon keeps serving.
func TestRestartSlotKeepsTheRunningDaemonWhenTheReplacementFails(t *testing.T) {
	d, exe := fakeGuestdDriver(t)
	first := startFakeSlot(t, d, "vm-keep")

	broken := filepath.Join(t.TempDir(), "slipgate-guestd-broken")
	if err := os.WriteFile(broken, []byte("not an executable"), 0o755); err != nil {
		t.Fatalf("write broken binary: %v", err)
	}
	d.SetGuestdBin(broken)
	published := false
	if _, err := d.RestartSlot(context.Background(), first, func(Slot) error { published = true; return nil }); err == nil {
		t.Fatalf("expected the broken replacement to fail")
	}
	if published {
		t.Fatalf("a replacement that never came up must not be published")
	}
	if !answers(first.GuestUDSPath) {
		t.Fatalf("the running daemon must keep serving when its replacement fails")
	}
	if bin, ok := d.runningBin(first.ID); !ok || bin != exe {
		t.Fatalf("the slot must still be supervised on the old binary, got %q %v", bin, ok)
	}
}

// Stopping waits for in-flight exchanges, then stops the daemon.
func TestStopSlotDrainsInFlightExchanges(t *testing.T) {
	d, _ := fakeGuestdDriver(t)
	slot := startFakeSlot(t, d, "vm-stop")

	done := beginGuestCall(slot.GuestUDSPath)
	stopped := make(chan struct{})
	go func() {
		_ = d.StopSlot(context.Background(), ClusterNode{}, slot)
		close(stopped)
	}()
	time.Sleep(200 * time.Millisecond)
	select {
	case <-stopped:
		t.Fatalf("StopSlot returned while an exchange was in flight")
	default:
	}
	if !answers(slot.GuestUDSPath) {
		t.Fatalf("the daemon was stopped under an in-flight exchange")
	}
	done()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatalf("StopSlot did not finish after the exchange ended")
	}
	if answers(slot.GuestUDSPath) {
		t.Fatalf("the daemon must be gone after StopSlot")
	}
	if _, ok := d.runningBin(slot.ID); ok {
		t.Fatalf("a stopped slot has no supervised daemon")
	}
}

// A daemon that dies on its own is reaped at once and no longer counts as running.
func TestCrashedDaemonIsReaped(t *testing.T) {
	d, _ := fakeGuestdDriver(t)
	slot := startFakeSlot(t, d, "vm-crash")
	d.mu.Lock()
	p := d.procs[slot.ID]
	d.mu.Unlock()
	if p == nil {
		t.Fatalf("slot has no supervised daemon")
	}
	_ = p.cmd.Process.Kill()
	waitUntil(t, "the crashed daemon to be reaped", func() bool { return !p.alive() })
	if _, ok := d.runningBin(slot.ID); ok {
		t.Fatalf("a crashed daemon must not count as running")
	}
}

// After a guestd hot update every serving local slot moves onto the new binary, blue/green, and
// the switch is persisted; a second roll has nothing left to do.
func TestRollLocalDaemonsMovesServingSlotsOntoTheNewBinary(t *testing.T) {
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
	vmDir := t.TempDir()
	for _, s := range []Slot{
		{ID: "vm-roll-a", ClusterNodeID: LocalNodeID, AccountID: "acc-a", State: StateReady},
		{ID: "vm-roll-b", ClusterNodeID: LocalNodeID, AccountID: "acc-b", State: StateCooldown5h},
		{ID: "vm-roll-off", ClusterNodeID: LocalNodeID, AccountID: "acc-off", State: StateStopped},
	} {
		if err := store.UpsertSlot(ctx, s); err != nil {
			t.Fatalf("seed slot %s: %v", s.ID, err)
		}
		if err := os.MkdirAll(filepath.Join(vmDir, "slots", s.ID), 0o755); err != nil {
			t.Fatalf("mkdir slot dir: %v", err)
		}
	}
	coord := NewCoordinator(CoordinatorOptions{Store: store, VMDataDir: vmDir, GuestdBin: exe})
	coord.localDrv.settle, coord.localDrv.drain, coord.localDrv.term = 20*time.Millisecond, 5*time.Second, 2*time.Second
	defer coord.Shutdown()
	if err := coord.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	before := map[string]Slot{}
	for _, s := range coord.ListSlots() {
		before[s.ID] = s
	}

	newBin := filepath.Join(t.TempDir(), filepath.Base(exe))
	copyFile(t, exe, newBin)
	coord.localDrv.SetGuestdBin(newBin) // what SetGuestdBin does before it starts the roll
	restarted, failed := coord.RollLocalDaemons(ctx)
	if restarted != 2 || failed != 0 {
		t.Fatalf("expected both serving slots to roll, got restarted=%d failed=%d", restarted, failed)
	}
	persisted, err := store.ListSlots(ctx)
	if err != nil {
		t.Fatalf("list persisted slots: %v", err)
	}
	stored := map[string]Slot{}
	for _, s := range persisted {
		stored[s.ID] = s
	}
	for _, id := range []string{"vm-roll-a", "vm-roll-b"} {
		now, _ := coord.mgr.GetSlot(id)
		old := before[id]
		if now.GuestUDSPath == old.GuestUDSPath || now.GuestPID == old.GuestPID || !strings.HasPrefix(now.GuestUDSPath, "tcp://") {
			t.Fatalf("%s: expected a new daemon, before %+v after %+v", id, old, now)
		}
		if now.State != old.State {
			t.Fatalf("%s: a roll must not change the slot state (%s -> %s)", id, old.State, now.State)
		}
		if bin, ok := coord.localDrv.runningBin(id); !ok || bin != newBin {
			t.Fatalf("%s: expected the daemon to run the new binary, got %q %v", id, bin, ok)
		}
		if !answers(now.GuestUDSPath) || answers(old.GuestUDSPath) {
			t.Fatalf("%s: the new daemon must serve and the old one be gone", id)
		}
		if stored[id].GuestPID != now.GuestPID {
			t.Fatalf("%s: the new daemon must be persisted, store has %+v", id, stored[id])
		}
	}
	if off, _ := coord.mgr.GetSlot("vm-roll-off"); off.GuestPID != 0 {
		t.Fatalf("a stopped slot must not be started by a roll, got %+v", off)
	}
	if again, failedAgain := coord.RollLocalDaemons(ctx); again != 0 || failedAgain != 0 {
		t.Fatalf("a second roll on the same binary must be a no-op, got %d/%d", again, failedAgain)
	}
}
