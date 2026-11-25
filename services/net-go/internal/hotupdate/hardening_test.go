package hotupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
)

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// pendingUpdateBoot leaves a hot dir as the restarted process of an update 0.1.0 -> 0.2.0 finds
// it: active.json on the new release and a restart marker whose plan rolls back to the baseline.
func pendingUpdateBoot(t *testing.T) (hotDir, installExe, newEdge string) {
	t.Helper()
	hotDir = t.TempDir()
	installExe = writeFakeEdge(t, filepath.Join(t.TempDir(), "install"), "installed")
	newEdge = writeFakeEdge(t, filepath.Join(hotDir, "releases", "v2"), "v2")
	if err := saveActiveRelease(hotDir, &ActiveRelease{Version: "0.2.0", Commit: "bbbbbbb2222", EdgeBin: newEdge, InstallExe: installExe, UpdatedAt: "t1"}); err != nil {
		t.Fatalf("save active: %v", err)
	}
	if err := saveRestartMarker(hotDir, &RestartMarker{
		ID:          "rst-old",
		Reason:      RestartReasonUpdate,
		Target:      newEdge,
		FromVersion: "0.1.0",
		ToVersion:   "0.2.0",
		RequestedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Rollback:    &RollbackPlan{Baseline: true, EdgeBin: installExe, Version: "0.1.0", Commit: "aaaaaaa1111"},
	}); err != nil {
		t.Fatalf("save marker: %v", err)
	}
	return hotDir, installExe, newEdge
}

func newBootManager(hotDir, edge string, onRestart func(string)) *Manager {
	return NewManager(Options{
		Config:             config.Config{Mode: "release", DevSyncMode: "release", HotUpdateDir: hotDir},
		Version:            "0.2.0",
		InitialCommit:      "bbbbbbb2222",
		EdgeExecutablePath: edge,
		RestartDelay:       time.Hour, // keep scheduled restarts from firing during the test
		ValidateEdgeBin:    func(context.Context, string) error { return nil },
		OnEdgeRestart:      onRestart,
		Logger:             quietLogger(),
	})
}

// A restart scheduled while the previous boot is still waiting for its health check must
// survive that check: no rollback over it, and its marker is not deleted.
func TestCompleteBootSkipsRollbackWhenNewRestartScheduled(t *testing.T) {
	t.Parallel()

	hotDir, _, newEdge := pendingUpdateBoot(t)
	mgr := newBootManager(hotDir, newEdge, func(string) {})
	if _, err := mgr.TriggerRestart(context.Background(), true); err != nil {
		t.Fatalf("TriggerRestart: %v", err)
	}
	newMarker, ok := LoadRestartMarker(hotDir)
	if !ok || newMarker.ID == "rst-old" || newMarker.Reason != RestartReasonManual {
		t.Fatalf("expected the manual restart's marker, got ok=%v %+v", ok, newMarker)
	}

	mgr.CompleteBoot(context.Background(), false)

	if active, ok := LoadActiveRelease(hotDir); !ok || active.Version != "0.2.0" {
		t.Fatalf("the boot guard must not roll back over a newer restart, active=%+v ok=%v", active, ok)
	}
	if still, ok := LoadRestartMarker(hotDir); !ok || still.ID != newMarker.ID {
		t.Fatalf("the newer restart's marker must survive, got ok=%v %+v", ok, still)
	}
	last := mgr.Status().LastRestart
	if last == nil || last.ID != "rst-old" || last.Outcome != RestartOutcomeDegraded || last.Message == nil {
		t.Fatalf("expected a degraded report for the old restart, got %+v", last)
	}
}

func TestCompleteBootKeepsNewerMarkerWhenHealthy(t *testing.T) {
	t.Parallel()

	hotDir, _, newEdge := pendingUpdateBoot(t)
	mgr := newBootManager(hotDir, newEdge, func(string) {})
	if _, err := mgr.TriggerRestart(context.Background(), true); err != nil {
		t.Fatalf("TriggerRestart: %v", err)
	}
	mgr.CompleteBoot(context.Background(), true)
	if marker, ok := LoadRestartMarker(hotDir); !ok || marker.ID == "rst-old" {
		t.Fatalf("settling the old restart must not delete the new marker, got ok=%v %+v", ok, marker)
	}
	if last := mgr.Status().LastRestart; last == nil || last.Outcome != RestartOutcomeSucceeded {
		t.Fatalf("expected the old restart to be reported as succeeded, got %+v", last)
	}
}

// An update applied (without restart) after this boot must not be overwritten by the boot
// guard's rollback plan.
func TestCompleteBootSkipsRollbackWhenActiveReleaseChanged(t *testing.T) {
	t.Parallel()

	hotDir, _, newEdge := pendingUpdateBoot(t)
	restarted := make(chan string, 1)
	mgr := newBootManager(hotDir, newEdge, func(target string) { restarted <- target })
	if err := saveActiveRelease(hotDir, &ActiveRelease{Version: "0.3.0", Commit: "ccccccc3333", EdgeBin: newEdge, UpdatedAt: "t2"}); err != nil {
		t.Fatalf("save active: %v", err)
	}
	mgr.CompleteBoot(context.Background(), false)
	if active, _ := LoadActiveRelease(hotDir); active == nil || active.Version != "0.3.0" {
		t.Fatalf("the operator's newer release must stay active, got %+v", active)
	}
	if mgr.Status().RestartScheduled {
		t.Fatalf("no automatic rollback restart expected")
	}
}

func TestMarkRestartInterrupted(t *testing.T) {
	t.Parallel()

	t.Run("manual restart marker is dropped", func(t *testing.T) {
		t.Parallel()
		hotDir := t.TempDir()
		edge := writeFakeEdge(t, filepath.Join(hotDir, "bin"), "edge")
		mgr := newBootManager(hotDir, edge, func(string) {})
		if _, err := mgr.TriggerRestart(context.Background(), true); err != nil {
			t.Fatalf("TriggerRestart: %v", err)
		}
		mgr.MarkRestartInterrupted()
		if _, ok := LoadRestartMarker(hotDir); ok {
			t.Fatalf("an aborted manual restart switched nothing; its marker must go")
		}
	})

	t.Run("update restart keeps the boot guard without charging an attempt", func(t *testing.T) {
		t.Parallel()
		hotDir := t.TempDir()
		edge := writeFakeEdge(t, filepath.Join(hotDir, "bin"), "edge")
		mgr := newBootManager(hotDir, edge, func(string) {})
		mgr.triggerEdgeRestart(restartRequest{
			Target:    edge,
			Reason:    RestartReasonUpdate,
			ToVersion: "0.3.0",
			Rollback:  &RollbackPlan{Baseline: true, EdgeBin: edge, Version: "0.2.0"},
		})
		mgr.MarkRestartInterrupted()
		marker, ok := LoadRestartMarker(hotDir)
		if !ok || !marker.Interrupted || marker.Rollback == nil {
			t.Fatalf("expected the update marker kept and flagged interrupted, got ok=%v %+v", ok, marker)
		}
		// The cold boot that follows is the new release's first start, not a failure.
		if d := PrepareBoot(hotDir, true, quietLogger()); d.Marker == nil || d.Marker.ColdBoots != 0 || d.Marker.Interrupted {
			t.Fatalf("first cold boot after an interrupted restart must not count, got %+v", d.Marker)
		}
		if d := PrepareBoot(hotDir, true, quietLogger()); d.Marker.ColdBoots != 1 || d.RolledBack {
			t.Fatalf("later cold boots count as usual, got %+v", d.Marker)
		}
	})
}

func TestReconcileExternalUpgrade(t *testing.T) {
	t.Parallel()

	type fixture struct {
		hotDir, install, bundleEdge string
	}
	setup := func(t *testing.T, baseCommit string) fixture {
		t.Helper()
		f := fixture{hotDir: t.TempDir()}
		f.install = writeFakeEdge(t, filepath.Join(t.TempDir(), "install"), "install-v1")
		f.bundleEdge = writeFakeEdge(t, filepath.Join(f.hotDir, "releases", "r2"), "bundle-r2")
		if err := saveActiveRelease(f.hotDir, &ActiveRelease{
			Version: "0.2.0", Commit: "2222222aaaa", BaseVersion: "0.1.0", BaseCommit: baseCommit,
			InstallExe: f.install, InstallFingerprint: ExecutableFingerprint(f.install), EdgeBin: f.bundleEdge,
		}); err != nil {
			t.Fatalf("save active: %v", err)
		}
		if err := saveRestartMarker(f.hotDir, &RestartMarker{ID: "rst-x", Reason: RestartReasonUpdate}); err != nil {
			t.Fatalf("save marker: %v", err)
		}
		writeFakeEdge(t, filepath.Join(f.hotDir, "baseline"), "baseline-copy")
		raw, _ := json.Marshal(persistedHistory{Baseline: &baselineSnapshot{Version: "0.1.0", Commit: baseCommit}, Entries: []HistoryEntry{{ID: "rel-1"}}})
		if err := os.WriteFile(filepath.Join(f.hotDir, "history.json"), raw, 0o600); err != nil {
			t.Fatalf("write history: %v", err)
		}
		return f
	}
	assertCleared := func(t *testing.T, f fixture, cleared bool) {
		t.Helper()
		_, hasActive := LoadActiveRelease(f.hotDir)
		_, hasMarker := LoadRestartMarker(f.hotDir)
		_, baselineErr := os.Stat(filepath.Join(f.hotDir, "baseline"))
		var ph persistedHistory
		raw, _ := os.ReadFile(filepath.Join(f.hotDir, "history.json"))
		_ = json.Unmarshal(raw, &ph)
		if cleared {
			if hasActive || hasMarker || baselineErr == nil || ph.Baseline != nil || len(ph.Entries) != 1 {
				t.Fatalf("expected overlay, marker and baseline cleared (history kept): active=%v marker=%v baselineDir=%v history=%+v", hasActive, hasMarker, baselineErr == nil, ph)
			}
			return
		}
		if !hasActive || !hasMarker || baselineErr != nil || ph.Baseline == nil {
			t.Fatalf("expected the overlay untouched: active=%v marker=%v baselineDir=%v baseline=%v", hasActive, hasMarker, baselineErr == nil, ph.Baseline)
		}
	}

	t.Run("same dev install keeps the overlay", func(t *testing.T) {
		t.Parallel()
		f := setup(t, "dev")
		if ReconcileExternalUpgrade(f.hotDir, "0.1.0", "dev", f.install, quietLogger()) {
			t.Fatalf("an unchanged install is not an upgrade")
		}
		assertCleared(t, f, false)
	})
	t.Run("the release's own edge is never treated as an upgrade", func(t *testing.T) {
		t.Parallel()
		f := setup(t, "1111111bbbb")
		if ReconcileExternalUpgrade(f.hotDir, "0.2.0", "2222222aaaa", f.bundleEdge, quietLogger()) {
			t.Fatalf("the handed-off bundle edge must not clear its own release")
		}
		assertCleared(t, f, false)
	})
	t.Run("rebuilt dev image is detected by the binary fingerprint", func(t *testing.T) {
		t.Parallel()
		f := setup(t, "dev")
		if err := os.WriteFile(f.install, []byte("install-v1-rebuilt-with-changes"), 0o755); err != nil {
			t.Fatalf("rewrite install: %v", err)
		}
		if !ReconcileExternalUpgrade(f.hotDir, "0.1.0", "dev", f.install, quietLogger()) {
			t.Fatalf("a replaced install binary is an external upgrade even with commit=dev")
		}
		assertCleared(t, f, true)
	})
	t.Run("new installed version", func(t *testing.T) {
		t.Parallel()
		f := setup(t, "dev")
		if !ReconcileExternalUpgrade(f.hotDir, "0.3.0", "dev", f.install, quietLogger()) {
			t.Fatalf("a different installed version is an external upgrade")
		}
		assertCleared(t, f, true)
	})
	t.Run("install caught up with the hot-applied release", func(t *testing.T) {
		t.Parallel()
		f := setup(t, "1111111bbbb")
		if !ReconcileExternalUpgrade(f.hotDir, "0.1.0", "2222222aaaa", f.install, quietLogger()) {
			t.Fatalf("an install now shipping the hot-applied commit makes the overlay redundant")
		}
		assertCleared(t, f, true)
	})
}

// A plane reload that fails must leave active.json and the reported version untouched, and put
// the previous plane binaries back.
func TestApplyPlaneReloadFailurePreservesActiveRelease(t *testing.T) {
	t.Parallel()

	for _, async := range []bool{false, true} {
		async := async
		name := "sync"
		if async {
			name = "async"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			exePath, err := os.Executable()
			if err != nil {
				t.Fatalf("os.Executable: %v", err)
			}
			sup := supervisor.New(quietLogger())
			ctx, cancel := context.WithCancel(context.Background())
			defer func() {
				cancel()
				_ = sup.Stop(2 * time.Second)
			}()
			helper := []string{"-test.run=TestHelperProcess"}
			env := []string{"GO_WANT_HOTUPDATE_HELPER=1"}
			if err := sup.StartAll(ctx, []supervisor.ChildSpec{
				{Name: "core", Binary: exePath, Args: helper, Env: env},
				{Name: "bff", Binary: exePath, Args: helper, Env: env},
			}); err != nil {
				t.Fatalf("StartAll: %v", err)
			}

			hotDir := t.TempDir()
			bundle := filepath.Join(hotDir, "releases", "broken")
			if err := os.MkdirAll(bundle, 0o755); err != nil {
				t.Fatalf("mkdir bundle: %v", err)
			}
			// Not an executable: the new core can never start.
			if err := os.WriteFile(filepath.Join(bundle, "slipgate-core"+exeExt()), []byte("not a binary"), 0o755); err != nil {
				t.Fatalf("write core: %v", err)
			}
			mgr := NewManager(Options{
				Config:        config.Config{Mode: "dev", DevSyncMode: "release", HotUpdateDir: hotDir},
				Version:       "0.1.0",
				InitialCommit: "aaaaaaa1111",
				Supervisor:    sup,
				Logger:        quietLogger(),
			})
			_, applyErr := mgr.applyExtractedBundle(context.Background(), applyBundleRequest{
				BundleRoot:   bundle,
				NewCommit:    "bbbbbbb2222",
				NewVersion:   "0.2.0",
				Action:       "apply",
				AsyncRestart: async,
			})
			if async {
				if applyErr != nil {
					t.Fatalf("async apply reports failures later, got %v", applyErr)
				}
				if _, ok := LoadActiveRelease(hotDir); ok {
					t.Fatalf("active.json must not be written before the planes are up")
				}
				deadline := time.Now().Add(20 * time.Second)
				for mgr.Status().State == StateReloadingPlanes && time.Now().Before(deadline) {
					time.Sleep(50 * time.Millisecond)
				}
				st := mgr.Status()
				if st.State != StateError || st.LastError == nil {
					t.Fatalf("expected the failed reload to surface as an error, got state=%s", st.State)
				}
				if len(st.History) == 0 || st.History[0].Succeeded || st.History[0].Error == nil {
					t.Fatalf("expected a failed history entry, got %+v", st.History)
				}
			} else if applyErr == nil {
				t.Fatalf("expected the failed plane restart to be reported")
			}
			if _, ok := LoadActiveRelease(hotDir); ok {
				t.Fatalf("a release whose planes never started must not become active")
			}
			if v := mgr.Status().Version; v != "0.1.0" {
				t.Fatalf("version must stay 0.1.0, got %s", v)
			}
			if bin, _ := sup.ChildBinary("core"); !SameExecutablePath(bin, exePath) {
				t.Fatalf("the previous core binary must be restored, got %s", bin)
			}
		})
	}
}

func TestExtractArchiveRejectsOversizedEntryAndTotalCap(t *testing.T) {
	t.Parallel()

	write := func(t *testing.T, name string, files map[string][]byte) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(p, buildMockArchive(t, name, files), 0o600); err != nil {
			t.Fatalf("write archive: %v", err)
		}
		return p
	}
	limits := extractLimits{perFile: 1024, total: 1500, entries: 3}
	cases := []struct {
		name    string
		archive string
		files   map[string][]byte
		wantErr bool
	}{
		{"fits", "a.tar.gz", map[string][]byte{"x/a": make([]byte, 700), "x/b": make([]byte, 700)}, false},
		{"entry over per-file limit (tar)", "b.tar.gz", map[string][]byte{"big": make([]byte, 2048)}, true},
		{"entry over per-file limit (zip)", "c.zip", map[string][]byte{"big": make([]byte, 2048)}, true},
		{"total over limit", "d.tar.gz", map[string][]byte{"a": make([]byte, 600), "b": make([]byte, 600), "c": make([]byte, 600)}, true},
		{"too many entries", "e.zip", map[string][]byte{"a": {1}, "b": {1}, "c": {1}, "d": {1}}, true},
	}
	for _, tc := range cases {
		err := extractArchiveWithLimits(write(t, tc.archive, tc.files), t.TempDir(), limits)
		if tc.wantErr && !errors.Is(err, ErrArchiveTooLarge) {
			t.Errorf("%s: expected ErrArchiveTooLarge, got %v", tc.name, err)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("%s: unexpected error %v", tc.name, err)
		}
	}
}

func TestUpdateConfigRejectsGitWhenUnavailable(t *testing.T) {
	t.Parallel()

	noCheckout := t.TempDir()
	mgr := NewManager(Options{
		Config: config.Config{Mode: "release", DevSyncMode: "release", GitRepoDir: noCheckout, HotUpdateDir: t.TempDir()},
		Logger: quietLogger(),
	})
	if mgr.Status().GitAvailable {
		t.Fatalf("a directory without .git is not a usable checkout")
	}
	git := "git"
	if _, err := mgr.UpdateConfig(ConfigPatch{Strategy: &git}); !errors.Is(err, ErrInvalidUpdateConfig) {
		t.Fatalf("expected the git strategy to be refused without a checkout, got %v", err)
	}
	release := "release"
	if _, err := mgr.UpdateConfig(ConfigPatch{Strategy: &release}); err != nil {
		t.Fatalf("release strategy must stay selectable: %v", err)
	}
}

// BUILD_META.json listed in SHA256SUMS.txt is only believed when it matches.
func TestBuildMetaIgnoredWhenChecksumMismatches(t *testing.T) {
	t.Parallel()

	assetName := PlatformAssetName("v0.5.0")
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "v0.5.0",
				TargetCommitish: "5555555aaaaa",
				Assets: []githubAsset{
					{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/BUILD_META.json"},
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{Version: "9.9.9-forged", Commit: "ffffffffffff"})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  BUILD_META.json\n", strings.Repeat("0", 64))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	mgr := NewManager(Options{
		Config:          config.Config{Mode: "release", DevSyncMode: "release", UpdateRepo: "dreamforSh/Slipgate", HotUpdateDir: t.TempDir()},
		Version:         "0.4.0",
		InitialCommit:   "4444444aaaaa",
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          quietLogger(),
	})
	st, err := mgr.Sync(context.Background(), true, false)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if st.RemoteVersion == nil || *st.RemoteVersion != "0.5.0" || st.RemoteCommit == nil || *st.RemoteCommit != "5555555aaaaa" {
		t.Fatalf("a BUILD_META.json failing its checksum must be ignored, got version=%v commit=%v", st.RemoteVersion, st.RemoteCommit)
	}
}
