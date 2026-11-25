package hotupdate

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
)

func writeFakeEdge(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, "slipgate"+exeExt())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(p, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func TestPrepareBootRollsBackAfterRepeatedColdBoots(t *testing.T) {
	t.Parallel()

	hotDir := t.TempDir()
	prevEdge := writeFakeEdge(t, filepath.Join(hotDir, "releases", "v1"), "v1")
	newEdge := writeFakeEdge(t, filepath.Join(hotDir, "releases", "v2"), "v2")
	prev := &ActiveRelease{Version: "0.1.0", Commit: "aaaaaaa1111", BaseCommit: "base0000001", EdgeBin: prevEdge, BundleDir: filepath.Dir(prevEdge)}
	if err := saveActiveRelease(hotDir, &ActiveRelease{Version: "0.2.0", Commit: "bbbbbbb2222", BaseCommit: "base0000001", EdgeBin: newEdge}); err != nil {
		t.Fatalf("save active: %v", err)
	}
	if err := saveRestartMarker(hotDir, &RestartMarker{
		ID:          "rst-1",
		Reason:      RestartReasonUpdate,
		Target:      newEdge,
		FromVersion: "0.1.0",
		ToVersion:   "0.2.0",
		ToCommit:    "bbbbbbb2222",
		RequestedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Rollback:    &RollbackPlan{Active: prev, EdgeBin: prevEdge, Version: "0.1.0", Commit: "aaaaaaa1111"},
	}); err != nil {
		t.Fatalf("save marker: %v", err)
	}
	quiet := log.New(io.Discard, "", 0)

	// The exec handoff into the new release is not a cold boot and never counts.
	if d := PrepareBoot(hotDir, false, quiet); d.RolledBack || d.Marker == nil || d.Marker.ColdBoots != 0 {
		t.Fatalf("handoff boot must not count, got %+v", d)
	}
	// First crash-restart: still giving the new release a chance.
	if d := PrepareBoot(hotDir, true, quiet); d.RolledBack || d.Marker.ColdBoots != 1 {
		t.Fatalf("first cold boot must not roll back yet, got %+v", d)
	}
	if active, _ := LoadActiveRelease(hotDir); active.Version != "0.2.0" {
		t.Fatalf("active.json must still point at the new release, got %+v", active)
	}
	// Second crash-restart: roll back to the previous release before the handoff.
	d := PrepareBoot(hotDir, true, quiet)
	if !d.RolledBack || !d.Marker.RolledBack || d.Marker.ColdBoots != 2 || !strings.Contains(d.Marker.Note, "0.1.0") {
		t.Fatalf("expected rollback on the second cold boot, got %+v", d.Marker)
	}
	active, ok := LoadActiveRelease(hotDir)
	if !ok || active.Version != "0.1.0" || active.EdgeBin != prevEdge || active.BaseCommit != "base0000001" {
		t.Fatalf("expected previous active release restored, got ok=%v %+v", ok, active)
	}
	// Further boots never roll back again.
	if d := PrepareBoot(hotDir, true, quiet); d.RolledBack {
		t.Fatalf("a rolled-back restart must not roll back twice")
	}

	// The rolled-back process reports the outcome and records the automatic rollback.
	mgr := NewManager(Options{
		Config:             config.Config{Mode: "dev", DevSyncMode: "release", HotUpdateDir: hotDir},
		Version:            "0.1.0",
		InitialCommit:      "aaaaaaa1111",
		EdgeExecutablePath: prevEdge,
		Logger:             quiet,
	})
	if !mgr.HasPendingBoot() {
		t.Fatalf("expected pending boot marker")
	}
	mgr.CompleteBoot(context.Background(), true)
	st := mgr.Status()
	if st.LastRestart == nil || st.LastRestart.Outcome != RestartOutcomeRolledBack || st.LastRestart.Message == nil {
		t.Fatalf("expected rolled_back last restart, got %+v", st.LastRestart)
	}
	if len(st.History) == 0 || st.History[0].Action != "rollback" || st.History[0].Error == nil || st.History[0].ToVersion != "0.1.0" {
		t.Fatalf("expected automatic rollback history entry, got %+v", st.History)
	}
	if _, still := LoadRestartMarker(hotDir); still {
		t.Fatalf("marker must be cleared once the outcome is recorded")
	}
	// The report survives a restart of its own.
	again := NewManager(Options{Config: config.Config{HotUpdateDir: hotDir}, Logger: quiet}).Status()
	if again.LastRestart == nil || again.LastRestart.ID != "rst-1" {
		t.Fatalf("expected persisted last restart, got %+v", again.LastRestart)
	}
}

func TestCompleteBootFailedReadinessRollsBackInProcess(t *testing.T) {
	t.Parallel()

	hotDir := t.TempDir()
	installExe := writeFakeEdge(t, filepath.Join(t.TempDir(), "install"), "installed")
	newEdge := writeFakeEdge(t, filepath.Join(hotDir, "releases", "v2"), "v2")
	if err := saveActiveRelease(hotDir, &ActiveRelease{Version: "0.2.0", Commit: "bbbbbbb2222", EdgeBin: newEdge, InstallExe: installExe}); err != nil {
		t.Fatalf("save active: %v", err)
	}
	if err := saveRestartMarker(hotDir, &RestartMarker{
		ID:          "rst-2",
		Reason:      RestartReasonUpdate,
		Target:      newEdge,
		FromVersion: "0.1.0",
		ToVersion:   "0.2.0",
		RequestedAt: time.Now().Add(-3 * time.Second).UTC().Format(time.RFC3339Nano),
		Rollback:    &RollbackPlan{Baseline: true, EdgeBin: installExe, Version: "0.1.0", Commit: "aaaaaaa1111"},
	}); err != nil {
		t.Fatalf("save marker: %v", err)
	}

	restartCh := make(chan string, 1)
	mgr := NewManager(Options{
		Config:             config.Config{Mode: "release", DevSyncMode: "release", HotUpdateDir: hotDir},
		Version:            "0.2.0",
		InitialCommit:      "bbbbbbb2222",
		EdgeExecutablePath: newEdge,
		RestartDelay:       10 * time.Millisecond,
		ValidateEdgeBin:    func(context.Context, string) error { return nil },
		OnEdgeRestart:      func(target string) { restartCh <- target },
		Logger:             log.New(io.Discard, "", 0),
	})
	mgr.CompleteBoot(context.Background(), false)

	select {
	case target := <-restartCh:
		if !SameExecutablePath(target, installExe) {
			t.Fatalf("expected rollback restart into the installed binary %s, got %s", installExe, target)
		}
	case <-time.After(time.Second):
		t.Fatalf("expected an automatic rollback restart")
	}
	if _, ok := LoadActiveRelease(hotDir); ok {
		t.Fatalf("baseline rollback must clear active.json")
	}
	st := mgr.Status()
	if st.LastRestart == nil || st.LastRestart.Outcome != RestartOutcomeRolledBack || st.LastRestart.DurationMs < 3000 {
		t.Fatalf("unexpected last restart %+v", st.LastRestart)
	}
	if !st.RestartScheduled || st.Version != "0.1.0" {
		t.Fatalf("expected a scheduled restart back to 0.1.0, got %+v", st)
	}
	marker, ok := LoadRestartMarker(hotDir)
	if !ok || marker.Reason != RestartReasonAutoRollback || marker.Rollback != nil {
		t.Fatalf("auto-rollback restart must carry no further rollback plan, got ok=%v %+v", ok, marker)
	}
}

func TestCompleteBootDegradedWithoutRollbackPlan(t *testing.T) {
	t.Parallel()

	hotDir := t.TempDir()
	if err := saveRestartMarker(hotDir, &RestartMarker{
		ID:          "rst-3",
		Reason:      RestartReasonManual,
		RequestedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("save marker: %v", err)
	}
	restartCh := make(chan string, 1)
	mgr := NewManager(Options{
		Config:        config.Config{HotUpdateDir: hotDir},
		OnEdgeRestart: func(target string) { restartCh <- target },
		Logger:        log.New(io.Discard, "", 0),
	})
	mgr.CompleteBoot(context.Background(), false)
	if st := mgr.Status(); st.LastRestart == nil || st.LastRestart.Outcome != RestartOutcomeDegraded {
		t.Fatalf("expected degraded outcome, got %+v", st.LastRestart)
	}
	select {
	case target := <-restartCh:
		t.Fatalf("a manual restart has nothing to roll back to, got restart %s", target)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestApplyCarriesInstallBaseAcrossConsecutiveUpdates(t *testing.T) {
	t.Parallel()

	hotDir := t.TempDir()
	runningEdge := writeFakeEdge(t, filepath.Join(hotDir, "releases", "x1"), "x1")
	// The process runs release x1, handed off from the installed binary of commit "image000001".
	if err := saveActiveRelease(hotDir, &ActiveRelease{
		Version:    "0.2.0",
		Commit:     "x1x1x1x1x1x1",
		BaseCommit: "image000001",
		InstallExe: "/usr/local/bin/slipgate",
		EdgeBin:    runningEdge,
		BundleDir:  filepath.Dir(runningEdge),
	}); err != nil {
		t.Fatalf("save active: %v", err)
	}
	bundle := filepath.Join(hotDir, "releases", "x2")
	if err := os.MkdirAll(filepath.Join(bundle, "webui"), 0o755); err != nil {
		t.Fatalf("mkdir bundle: %v", err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "webui", "index.html"), []byte("<html>x2</html>"), 0o644); err != nil {
		t.Fatalf("write webui: %v", err)
	}

	mgr := NewManager(Options{
		Config:             config.Config{Mode: "dev", DevSyncMode: "release", HotUpdateDir: hotDir, AutoRestartAfterUpdate: true},
		Version:            "0.2.0",
		InitialCommit:      "x1x1x1x1x1x1",
		EdgeExecutablePath: runningEdge,
		OnEdgeRestart:      func(string) { t.Errorf("a web-UI-only bundle must not restart the service") },
		Logger:             log.New(io.Discard, "", 0),
	})
	if _, err := mgr.applyExtractedBundle(context.Background(), applyBundleRequest{
		BundleRoot: bundle,
		NewCommit:  "x2x2x2x2x2x2",
		NewVersion: "0.3.0",
		Action:     "apply",
	}); err != nil {
		t.Fatalf("applyExtractedBundle: %v", err)
	}
	active, ok := LoadActiveRelease(hotDir)
	if !ok || active.Commit != "x2x2x2x2x2x2" || active.BaseCommit != "image000001" ||
		active.InstallExe != "/usr/local/bin/slipgate" || active.EdgeBin != runningEdge {
		t.Fatalf("expected install base, install exe and running edge carried forward, got %+v", active)
	}
	if st := mgr.Status(); st.RestartScheduled {
		t.Fatalf("web-UI-only bundle must be applied live, got %+v", st)
	}
	time.Sleep(20 * time.Millisecond)
}
