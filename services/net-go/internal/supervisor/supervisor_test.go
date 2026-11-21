package supervisor

import (
	"context"
	"io"
	"log"
	"os"
	"testing"
	"time"
)

// TestHelperProcess runs inside a subprocess when GO_WANT_HELPER_PROCESS=1.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	time.Sleep(10 * time.Second)
	os.Exit(0)
}

func TestSupervisorStartAndGracefulStop(t *testing.T) {
	t.Parallel()

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable failed: %v", err)
	}

	sup := New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	specs := []ChildSpec{
		{
			Name:   "core",
			Binary: exe,
			Args:   []string{"-test.run=TestHelperProcess"},
			Env:    []string{"GO_WANT_HELPER_PROCESS=1"},
		},
		{
			Name:   "bff",
			Binary: exe,
			Args:   []string{"-test.run=TestHelperProcess"},
			Env:    []string{"GO_WANT_HELPER_PROCESS=1"},
		},
	}

	if err := sup.StartAll(ctx, specs); err != nil {
		t.Fatalf("StartAll failed: %v", err)
	}

	snaps := sup.Snapshots()
	if len(snaps) != 2 || snaps[0].Status != StatusRunning || snaps[1].Status != StatusRunning {
		t.Fatalf("expected both children running, got %+v", snaps)
	}

	cancel()
	if err := sup.Stop(2 * time.Second); err != nil {
		t.Fatalf("Stop failed: %v", err)
	}

	snapsAfter := sup.Snapshots()
	for _, snap := range snapsAfter {
		if snap.Status == StatusRunning {
			t.Fatalf("expected child %s to be stopped after Stop(), got %+v", snap.Name, snap)
		}
	}
}

func TestSupervisorDegradedMissingBinary(t *testing.T) {
	t.Parallel()

	sup := New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := sup.StartAll(ctx, []ChildSpec{
		{
			Name:          "missing-core",
			Binary:        "definitely-not-a-real-slipgate-binary-xyz",
			AllowDegraded: true,
		},
	})
	if err != nil {
		t.Fatalf("expected degraded startup to succeed, got %v", err)
	}

	snaps := sup.Snapshots()
	if len(snaps) != 1 || snaps[0].Status != StatusDegraded {
		t.Fatalf("expected degraded child snapshot, got %+v", snaps)
	}
}
