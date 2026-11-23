package supervisor

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"testing"
	"time"
)

// TestHelperPrintProcess prints one stdout and one stderr line, then exits (GO_WANT_PRINT_HELPER=1).
func TestHelperPrintProcess(t *testing.T) {
	if os.Getenv("GO_WANT_PRINT_HELPER") != "1" {
		return
	}
	fmt.Fprintln(os.Stdout, "info: core listening")
	fmt.Fprintln(os.Stderr, "error(ipc): frame too large")
	os.Exit(0)
}

func TestLineHookReceivesChildOutputAndLoggerStillEchoes(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable failed: %v", err)
	}
	var out bytes.Buffer
	var outMu sync.Mutex
	sup := New(log.New(writerFunc(func(p []byte) (int, error) {
		outMu.Lock()
		defer outMu.Unlock()
		return out.Write(p)
	}), "", 0))

	var mu sync.Mutex
	got := map[string]string{}
	sup.SetLineHook(func(child, line string) {
		mu.Lock()
		got[line] = child
		mu.Unlock()
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := sup.StartAll(ctx, []ChildSpec{{
		Name:   "core",
		Binary: exe,
		Args:   []string{"-test.run=TestHelperPrintProcess"},
		Env:    []string{"GO_WANT_PRINT_HELPER=1"},
	}}); err != nil {
		t.Fatalf("StartAll failed: %v", err)
	}
	defer func() { _ = sup.Stop(2 * time.Second) }()

	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got["info: core listening"] != "core" || got["error(ipc): frame too large"] != "core" {
		t.Fatalf("hook lines: %v", got)
	}
	outMu.Lock()
	defer outMu.Unlock()
	if !bytes.Contains(out.Bytes(), []byte("[core] error(ipc): frame too large")) {
		t.Fatalf("logger echo missing:\n%s", out.String())
	}
}

type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
