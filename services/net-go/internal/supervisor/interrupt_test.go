package supervisor

import (
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"testing"
	"time"
)

// TestGracefulHelperProcess exits cleanly on an interrupt, leaving a marker file behind, so the
// test can tell a graceful stop from a kill.
func TestGracefulHelperProcess(t *testing.T) {
	marker := os.Getenv("GO_WANT_GRACEFUL_HELPER")
	if marker == "" {
		return
	}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	select {
	case <-sigCh:
		_ = os.WriteFile(marker, []byte("graceful"), 0o600)
	case <-time.After(30 * time.Second):
	}
	os.Exit(0)
}

func TestStopInterruptsChildGracefully(t *testing.T) {
	t.Parallel()
	if !canInterruptChildren() {
		t.Skip("no console to deliver CTRL_BREAK through; children are killed instead")
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	marker := filepath.Join(t.TempDir(), "stopped")
	sup := New(log.New(io.Discard, "", 0))
	if err := sup.StartAll(context.Background(), []ChildSpec{{
		Name:   "bff",
		Binary: exe,
		Args:   []string{"-test.run=TestGracefulHelperProcess"},
		Env:    []string{"GO_WANT_GRACEFUL_HELPER=" + marker},
	}}); err != nil {
		t.Fatalf("StartAll: %v", err)
	}
	time.Sleep(300 * time.Millisecond) // let the helper install its signal handler
	if err := sup.Stop(5 * time.Second); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "graceful" {
		t.Fatalf("the child must be interrupted (and allowed to clean up), not killed: %v", err)
	}
}
