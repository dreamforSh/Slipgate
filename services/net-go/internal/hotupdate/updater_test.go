package hotupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HOTUPDATE_HELPER") != "1" {
		return
	}
	time.Sleep(10 * time.Second)
	os.Exit(0)
}

func buildMockArchive(t *testing.T, assetName string, files map[string][]byte) []byte {
	t.Helper()

	var buf bytes.Buffer
	if strings.HasSuffix(assetName, ".zip") {
		zw := zip.NewWriter(&buf)
		for name, data := range files {
			w, err := zw.Create(name)
			if err != nil {
				t.Fatalf("zip create %s: %v", name, err)
			}
			if _, err := w.Write(data); err != nil {
				t.Fatalf("zip write %s: %v", name, err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zip close: %v", err)
		}
		return buf.Bytes()
	}

	gzw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gzw)
	for name, data := range files {
		hdr := &tar.Header{
			Name: name,
			Mode: 0o755,
			Size: int64(len(data)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("tar header %s: %v", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatalf("tar write %s: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gzw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func TestCheckOnlyAndChecksumMismatch(t *testing.T) {
	t.Parallel()

	assetName := PlatformAssetName("dev")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"webui/index.html": []byte("<html>new</html>"),
	})

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/tags/dev-latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "dev-latest",
				TargetCommitish: "1111111222222",
				Assets: []githubAsset{
					{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/BUILD_META.json"},
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{
				Version: "0.1.0-dev.abcdef1",
				Commit:  "abcdef1234567890",
			})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", strings.Repeat("0", 64), assetName)
		case "/dl/" + assetName:
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	mgr := NewManager(Options{
		Config: config.Config{
			Mode:         "dev",
			DevSyncMode:  "release",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			HotUpdateDir: t.TempDir(),
		},
		Version:         "0.1.0",
		InitialCommit:   "oldcommit12345",
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          log.New(io.Discard, "", 0),
	})

	// checkOnly detects remote commit without downloading
	status, err := mgr.Sync(context.Background(), true, false)
	if err != nil {
		t.Fatalf("checkOnly Sync failed: %v", err)
	}
	if !status.UpdateAvailable || status.RemoteCommit == nil || *status.RemoteCommit != "abcdef1234567890" {
		t.Fatalf("unexpected checkOnly status: %+v", status)
	}

	// Full sync rejects mismatched SHA256
	status, err = mgr.Sync(context.Background(), false, false)
	if !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("expected ErrChecksumMismatch, got err=%v status=%+v", err, status)
	}
	if err := validateDownloadURL("https://evil.example.com/payload.tar.gz", false); !errors.Is(err, ErrUntrustedDownloadHost) {
		t.Fatalf("expected ErrUntrustedDownloadHost, got %v", err)
	}

	releaseMgr := NewManager(Options{
		Config: config.Config{
			Mode:         "release",
			DevSyncMode:  "release",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			HotUpdateDir: t.TempDir(),
		},
		Version:         "0.1.0",
		InitialCommit:   "oldcommit12345",
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          log.New(io.Discard, "", 0),
	})
	if _, relErr := releaseMgr.Sync(context.Background(), false, false); relErr == nil {
		t.Fatalf("expected Sync(checkOnly=false) to be blocked in release mode")
	}
}

func TestSyncEndToEndHotRestartsSupervisorAndOverridesWebUI(t *testing.T) {
	t.Parallel()

	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exeBytes, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read test executable: %v", err)
	}

	sup := supervisor.New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		_ = sup.Stop(2 * time.Second)
	}()

	specs := []supervisor.ChildSpec{
		{
			Name:   "core",
			Binary: exePath,
			Args:   []string{"-test.run=TestHelperProcess"},
			Env:    []string{"GO_WANT_HOTUPDATE_HELPER=1"},
		},
		{
			Name:   "bff",
			Binary: exePath,
			Args:   []string{"-test.run=TestHelperProcess"},
			Env:    []string{"GO_WANT_HOTUPDATE_HELPER=1"},
		},
	}
	if err := sup.StartAll(ctx, specs); err != nil {
		t.Fatalf("StartAll: %v", err)
	}
	beforeSnaps := sup.Snapshots()

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	assetName := PlatformAssetName("dev")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"slipgate-dev/webui/index.html":    []byte("<html>synced-from-repo</html>"),
		"slipgate-dev/slipgate-core" + ext: exeBytes,
		"slipgate-dev/slipgate-bff" + ext:  exeBytes,
		"slipgate-dev/slipgate" + ext:      []byte("stub-edge"),
	})
	sum := sha256.Sum256(archiveBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/tags/dev-latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "dev-latest",
				TargetCommitish: "deadbeef12345678",
				Assets: []githubAsset{
					{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/BUILD_META.json"},
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{
				Version: "0.1.0-dev.deadbeef",
				Commit:  "deadbeef12345678",
			})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case "/dl/" + assetName:
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	var (
		overriddenDir   string
		planesRestarted int
	)
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:               "dev",
			DevSyncMode:        "release",
			DevSyncIntervalSec: 30,
			UpdateRepo:         "dreamforSh/Slipgate",
			UpdateBranch:       "main",
			HotUpdateDir:       t.TempDir(),
		},
		Version:         "0.1.0",
		InitialCommit:   "0000000111111111",
		Supervisor:      sup,
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          log.New(io.Discard, "", 0),
		OnWebUIDir: func(dir string) {
			overriddenDir = dir
		},
		OnPlanesRestarted: func(_ context.Context) {
			planesRestarted++
		},
	})

	status, err := mgr.Sync(context.Background(), false, false)
	if err != nil {
		t.Fatalf("full hot-update Sync failed: %v", err)
	}
	if planesRestarted != 1 {
		t.Fatalf("expected OnPlanesRestarted callback to fire once after RestartAll ([H-05]), got %d", planesRestarted)
	}
	if status.ActiveCommit != "deadbeef12345678" || !status.WebUIOverridden || !status.EdgeBinaryStaged || status.ReloadCount != 1 {
		t.Fatalf("unexpected updated status: %+v", status)
	}
	if overriddenDir == "" {
		t.Fatalf("expected OnWebUIDir callback")
	}
	htmlBytes, err := os.ReadFile(filepath.Join(overriddenDir, "index.html"))
	if err != nil || !strings.Contains(string(htmlBytes), "synced-from-repo") {
		t.Fatalf("unexpected overridden webui file: err=%v content=%q", err, string(htmlBytes))
	}

	afterSnaps := sup.Snapshots()
	if afterSnaps[0].PID == beforeSnaps[0].PID || afterSnaps[1].PID == beforeSnaps[1].PID {
		t.Fatalf("expected supervisor child PIDs to rotate after hot-update, before=%+v after=%+v", beforeSnaps, afterSnaps)
	}
}

func TestSafeJoinRejectsTraversal(t *testing.T) {
	t.Parallel()

	dest := t.TempDir()
	for _, bad := range []string{"../evil", "/etc/passwd", `..\..\windows\system32`, "sub/../../escape"} {
		if _, err := safeJoin(dest, bad); !errors.Is(err, ErrUnsafeArchivePath) {
			t.Fatalf("expected ErrUnsafeArchivePath for %q, got %v", bad, err)
		}
	}
}

func TestPrivateRepoReleaseAssetSyncViaAPIURL(t *testing.T) {
	t.Parallel()

	assetName := PlatformAssetName("dev")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"slipgate-dev/webui/index.html": []byte("<html>private-repo-ui</html>"),
	})
	sum := sha256.Sum256(archiveBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate GitHub private repo: browser_download_url returns 404; only APIURL + Bearer + octet-stream works.
		if strings.HasPrefix(r.URL.Path, "/browser-404/") {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer ghp_private_pat" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/tags/dev-latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "dev-latest",
				TargetCommitish: "998877665544",
				Assets: []githubAsset{
					{Name: "BUILD_META.json", APIURL: srvURL + "/assets/101", BrowserDownloadURL: srvURL + "/browser-404/meta"},
					{Name: "SHA256SUMS.txt", APIURL: srvURL + "/assets/102", BrowserDownloadURL: srvURL + "/browser-404/sums"},
					{Name: assetName, APIURL: srvURL + "/assets/103", BrowserDownloadURL: srvURL + "/browser-404/archive"},
				},
			})
		case "/assets/101":
			if r.Header.Get("Accept") != "application/octet-stream" {
				http.Error(w, "missing octet-stream accept", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(buildMeta{Version: "0.1.0-dev.9988776", Commit: "9988776655443322"})
		case "/assets/102":
			if r.Header.Get("Accept") != "application/octet-stream" {
				http.Error(w, "missing octet-stream accept", http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case "/assets/103":
			if r.Header.Get("Accept") != "application/octet-stream" {
				http.Error(w, "missing octet-stream accept", http.StatusBadRequest)
				return
			}
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	var webDir string
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:         "dev",
			DevSyncMode:  "release",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			GitHubToken:  "ghp_private_pat",
			HotUpdateDir: t.TempDir(),
		},
		Version:         "0.1.0",
		InitialCommit:   "000000000000",
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          log.New(io.Discard, "", 0),
		OnWebUIDir:      func(dir string) { webDir = dir },
	})

	st, err := mgr.Sync(context.Background(), false, false)
	if err != nil {
		t.Fatalf("private repo Sync failed: %v", err)
	}
	if st.ActiveCommit != "9988776655443322" || webDir == "" {
		t.Fatalf("unexpected private sync status: %+v webDir=%q", st, webDir)
	}
}

func TestCompareSemver(t *testing.T) {
	t.Parallel()

	cases := []struct {
		a    string
		b    string
		want int
	}{
		{"0.1.0", "0.2.0", -1},
		{"v0.1.0", "0.2.0", -1},
		{"0.2.0-dev", "0.2.0", -1},
		{"v1.10.0", "v1.2.0", 1},
		{"dev", "v0.1.0", -1},
		{"0.2.0", "v0.2.0", 0},
	}
	for _, tc := range cases {
		if got := compareSemver(tc.a, tc.b); got != tc.want {
			t.Errorf("compareSemver(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestStableChannelApplyCatalogHistoryAndRollback(t *testing.T) {
	t.Parallel()

	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exeBytes, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read test executable: %v", err)
	}

	sup := supervisor.New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		_ = sup.Stop(2 * time.Second)
	}()

	if err := sup.StartAll(ctx, []supervisor.ChildSpec{
		{Name: "core", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
		{Name: "bff", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
	}); err != nil {
		t.Fatalf("StartAll: %v", err)
	}

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}

	makeBundle := func(tag, version, commit, uiMarker string) (string, []byte, string) {
		asset := PlatformAssetName(tag)
		bytes := buildMockArchive(t, asset, map[string][]byte{
			"slipgate-" + tag + "/webui/index.html":        []byte("<html>" + uiMarker + "</html>"),
			"slipgate-" + tag + "/slipgate-core" + ext:     exeBytes,
			"slipgate-" + tag + "/slipgate-bff" + ext:      exeBytes,
			"slipgate-" + tag + "/slipgate-guestd" + ext:   []byte("guestd-" + version),
			"slipgate-" + tag + "/slipgate" + ext:          []byte("edge-" + version),
		})
		sum := sha256.Sum256(bytes)
		return asset, bytes, hex.EncodeToString(sum[:])
	}

	asset02, bytes02, sum02 := makeBundle("v0.2.0", "0.2.0", "22222222aaaa", "v020-ui")
	asset03, bytes03, sum03 := makeBundle("v0.3.0", "0.3.0", "33333333bbbb", "v030-ui")

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel02 := githubRelease{
			TagName:         "v0.2.0",
			Name:            "Slipgate v0.2.0",
			Body:            "## What's New\n- Dual channel updates",
			PublishedAt:     "2026-11-24T01:00:00Z",
			HTMLURL:         srvURL + "/releases/tag/v0.2.0",
			TargetCommitish: "22222222aaaa",
			Assets: []githubAsset{
				{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/v0.2.0/BUILD_META.json", Size: 64},
				{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/v0.2.0/SHA256SUMS.txt", Size: 128},
				{Name: asset02, BrowserDownloadURL: srvURL + "/dl/v0.2.0/" + asset02, Size: int64(len(bytes02))},
			},
		}
		rel03 := githubRelease{
			TagName:         "v0.3.0",
			Name:            "Slipgate v0.3.0",
			Body:            "## Hotfix\n- Faster streaming",
			PublishedAt:     "2026-11-24T02:00:00Z",
			HTMLURL:         srvURL + "/releases/tag/v0.3.0",
			TargetCommitish: "33333333bbbb",
			Assets: []githubAsset{
				{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/v0.3.0/BUILD_META.json", Size: 64},
				{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/v0.3.0/SHA256SUMS.txt", Size: 128},
				{Name: asset03, BrowserDownloadURL: srvURL + "/dl/v0.3.0/" + asset03, Size: int64(len(bytes03))},
			},
		}

		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/latest":
			_ = json.NewEncoder(w).Encode(rel02)
		case "/repos/dreamforSh/Slipgate/releases/tags/v0.2.0":
			_ = json.NewEncoder(w).Encode(rel02)
		case "/repos/dreamforSh/Slipgate/releases/tags/v0.3.0":
			_ = json.NewEncoder(w).Encode(rel03)
		case "/repos/dreamforSh/Slipgate/releases":
			_ = json.NewEncoder(w).Encode([]githubRelease{rel03, rel02})
		case "/dl/v0.2.0/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{Version: "0.2.0", Commit: "22222222aaaa"})
		case "/dl/v0.2.0/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sum02, asset02)
		case "/dl/v0.2.0/" + asset02:
			_, _ = w.Write(bytes02)
		case "/dl/v0.3.0/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{Version: "0.3.0", Commit: "33333333bbbb"})
		case "/dl/v0.3.0/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sum03, asset03)
		case "/dl/v0.3.0/" + asset03:
			_, _ = w.Write(bytes03)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	hotDir := t.TempDir()
	var webDir, guestdDir string
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:         "release",
			DevSyncMode:  "release",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			HotUpdateDir: hotDir,
		},
		Version:         "0.1.0",
		InitialCommit:   "111111110000",
		Supervisor:      sup,
		APIBaseURL:      srv.URL,
		AllowCustomHost: true,
		Logger:          log.New(io.Discard, "", 0),
		OnWebUIDir:      func(dir string) { webDir = dir },
		GetWebUIDir:     func() string { return webDir },
		OnGuestdBin:     func(path string) { guestdDir = path },
	})

	// 1. Check only against stable /releases/latest
	chk, err := mgr.Sync(context.Background(), true, false)
	if err != nil {
		t.Fatalf("stable checkOnly failed: %v", err)
	}
	if !chk.UpdateAvailable || chk.RemoteVersion == nil || *chk.RemoteVersion != "0.2.0" || chk.ReleaseNotes == nil {
		t.Fatalf("unexpected stable check status: %+v", chk)
	}

	// 2. Approved apply (release mode with AllowReleaseApply=true)
	st02, err := mgr.SyncWithOptions(context.Background(), SyncOptions{AllowReleaseApply: true})
	if err != nil {
		t.Fatalf("SyncWithOptions v0.2.0 failed: %v", err)
	}
	if st02.Version != "0.2.0" || !st02.GuestdUpdated || guestdDir == "" || !st02.CanRollback || st02.PreviousRelease == nil || st02.PreviousRelease.Version != "0.1.0" {
		t.Fatalf("unexpected status after v0.2.0 apply: %+v", st02)
	}

	// 3. ListReleases marks v0.2.0 current & caches results
	catalog, err := mgr.ListReleases(context.Background(), false)
	if err != nil {
		t.Fatalf("ListReleases failed: %v", err)
	}
	if len(catalog.Releases) != 2 || !catalog.Releases[1].Current || !catalog.Releases[0].Installable {
		t.Fatalf("unexpected release catalog: %+v", catalog)
	}

	// 4. Target specific release tag v0.3.0
	st03, err := mgr.SyncWithOptions(context.Background(), SyncOptions{
		TargetTag:         "v0.3.0",
		AllowReleaseApply: true,
	})
	if err != nil {
		t.Fatalf("SyncWithOptions v0.3.0 failed: %v", err)
	}
	if st03.Version != "0.3.0" || st03.PreviousRelease == nil || st03.PreviousRelease.Version != "0.2.0" {
		t.Fatalf("unexpected status after v0.3.0 apply: %+v", st03)
	}

	// 5. Rollback to previous release (v0.2.0), then baseline (0.1.0)
	rb02, err := mgr.Rollback(context.Background(), "", false)
	if err != nil {
		t.Fatalf("Rollback to v0.2.0 failed: %v", err)
	}
	if rb02.Version != "0.2.0" || len(rb02.History) < 3 || rb02.History[0].Action != "rollback" {
		t.Fatalf("unexpected status after rollback to v0.2.0: %+v", rb02)
	}

	rbBase, err := mgr.Rollback(context.Background(), "baseline", false)
	if err != nil {
		t.Fatalf("Rollback to baseline failed: %v", err)
	}
	if rbBase.Version != "0.1.0" || webDir != "" {
		t.Fatalf("unexpected status after baseline rollback: %+v webDir=%q", rbBase, webDir)
	}
}

func TestUpdateConfigPersistenceAndValidation(t *testing.T) {
	t.Parallel()

	hotDir := t.TempDir()
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:         "release",
			DevSyncMode:  "auto",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			HotUpdateDir: hotDir,
		},
		Version: "0.1.0",
		Logger:  log.New(io.Discard, "", 0),
	})

	badCh := "nightly"
	if _, err := mgr.UpdateConfig(ConfigPatch{Channel: &badCh}); !errors.Is(err, ErrInvalidUpdateConfig) {
		t.Fatalf("expected ErrInvalidUpdateConfig for channel=%q, got %v", badCh, err)
	}

	badInt := 10
	if _, err := mgr.UpdateConfig(ConfigPatch{IntervalSeconds: &badInt}); !errors.Is(err, ErrInvalidUpdateConfig) {
		t.Fatalf("expected ErrInvalidUpdateConfig for interval=10, got %v", err)
	}

	ch := ChannelDev
	auto := true
	interval := 180
	strat := "release"
	st, err := mgr.UpdateConfig(ConfigPatch{
		Channel:         &ch,
		AutoSyncEnabled: &auto,
		IntervalSeconds: &interval,
		Strategy:        &strat,
	})
	if err != nil {
		t.Fatalf("UpdateConfig failed: %v", err)
	}
	if st.Channel != ChannelDev || !st.AutoSyncEnabled || st.IntervalSeconds != 180 || st.Strategy != "release" {
		t.Fatalf("unexpected updated config snapshot: %+v", st)
	}

	// Fresh Manager loads persisted config.json cleanly
	reloaded := NewManager(Options{
		Config: config.Config{
			Mode:         "release",
			DevSyncMode:  "auto",
			UpdateRepo:   "dreamforSh/Slipgate",
			UpdateBranch: "main",
			HotUpdateDir: hotDir,
		},
		Version: "0.1.0",
		Logger:  log.New(io.Discard, "", 0),
	}).Status()
	if reloaded.Channel != ChannelDev || !reloaded.AutoSyncEnabled || reloaded.IntervalSeconds != 180 || reloaded.Strategy != "release" {
		t.Fatalf("reloaded config mismatch: %+v", reloaded)
	}

	if _, rbErr := mgr.Rollback(context.Background(), "", false); !errors.Is(rbErr, ErrRollbackUnavailable) {
		t.Fatalf("expected ErrRollbackUnavailable when no updates applied, got %v", rbErr)
	}
}

func TestAutoRestartAfterUpdateAndActiveReleasePersistence(t *testing.T) {
	t.Parallel()

	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exeBytes, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read test executable: %v", err)
	}

	sup := supervisor.New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		_ = sup.Stop(2 * time.Second)
	}()

	if err := sup.StartAll(ctx, []supervisor.ChildSpec{
		{Name: "core", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
		{Name: "bff", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
	}); err != nil {
		t.Fatalf("StartAll: %v", err)
	}
	beforeSnaps := sup.Snapshots()

	ext := exeExt()
	edgeExe := filepath.Join(t.TempDir(), "slipgate"+ext)
	if err := os.WriteFile(edgeExe, []byte("v1-edge"), 0o755); err != nil {
		t.Fatalf("write fake edge binary: %v", err)
	}

	assetName := PlatformAssetName("v0.2.0")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"slipgate-v0.2.0/webui/index.html":    []byte("<html>v020-auto-restart</html>"),
		"slipgate-v0.2.0/slipgate-core" + ext: exeBytes,
		"slipgate-v0.2.0/slipgate-bff" + ext:  exeBytes,
		"slipgate-v0.2.0/slipgate" + ext:      []byte("v2-edge-binary"),
	})
	sum := sha256.Sum256(archiveBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "v0.2.0",
				TargetCommitish: "deadbeef12345678",
				Assets: []githubAsset{
					{Name: "BUILD_META.json", BrowserDownloadURL: srvURL + "/dl/BUILD_META.json"},
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/BUILD_META.json":
			_ = json.NewEncoder(w).Encode(buildMeta{Version: "0.2.0", Commit: "deadbeef12345678"})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case "/dl/" + assetName:
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	hotDir := t.TempDir()
	restartCh := make(chan string, 2)
	validatedCh := make(chan string, 2)
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:                   "release",
			DevSyncMode:            "release",
			AutoRestartAfterUpdate: true,
			UpdateRepo:             "dreamforSh/Slipgate",
			UpdateBranch:           "main",
			HotUpdateDir:           hotDir,
		},
		Version:            "0.1.0",
		InitialCommit:      "111111110000",
		Supervisor:         sup,
		APIBaseURL:         srv.URL,
		AllowCustomHost:    true,
		Logger:             log.New(io.Discard, "", 0),
		EdgeExecutablePath: edgeExe,
		RestartDelay:       25 * time.Millisecond,
		ValidateEdgeBin: func(_ context.Context, binPath string) error {
			validatedCh <- binPath
			raw, readErr := os.ReadFile(binPath)
			if readErr != nil || string(raw) != "v2-edge-binary" {
				return fmt.Errorf("unexpected candidate content: %q err=%v", string(raw), readErr)
			}
			return nil
		},
		OnEdgeRestart: func(targetBinary string) {
			restartCh <- targetBinary
		},
	})

	st, err := mgr.SyncWithOptions(context.Background(), SyncOptions{
		AsyncRestart:      true,
		AllowReleaseApply: true,
	})
	if err != nil {
		t.Fatalf("SyncWithOptions failed: %v", err)
	}
	if st.State != StateRestarting || !st.RestartScheduled || st.BootID == "" {
		t.Fatalf("expected StateRestarting + RestartScheduled=true + BootID, got %+v", st)
	}
	if !st.AutoRestartAfterUpdate {
		t.Fatalf("expected AutoRestartAfterUpdate=true")
	}

	// Child planes must NOT be redundantly restarted when full edge restart is scheduled.
	midSnaps := sup.Snapshots()
	if midSnaps[0].PID != beforeSnaps[0].PID || midSnaps[1].PID != beforeSnaps[1].PID {
		t.Fatalf("expected supervisor child PIDs to stay untouched before edge restart, before=%+v after=%+v", beforeSnaps, midSnaps)
	}

	select {
	case <-validatedCh:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for ValidateEdgeBin")
	}
	select {
	case gotTarget := <-restartCh:
		if !SameExecutablePath(gotTarget, edgeExe) {
			t.Fatalf("expected OnEdgeRestart target %s, got %s", edgeExe, gotTarget)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for OnEdgeRestart callback")
	}

	// Swapped executable on disk now contains v2 binary.
	swappedRaw, err := os.ReadFile(edgeExe)
	if err != nil || string(swappedRaw) != "v2-edge-binary" {
		t.Fatalf("expected atomic swap onto %s, got %q err=%v", edgeExe, string(swappedRaw), err)
	}

	active, ok := LoadActiveRelease(hotDir)
	if !ok || active.Version != "0.2.0" || !SameExecutablePath(active.EdgeBin, edgeExe) {
		t.Fatalf("unexpected persisted active.json: ok=%v active=%+v", ok, active)
	}

	// Simulated restarted edge process loads active.json cleanly without pending edge restart.
	rebooted := NewManager(Options{
		Config: config.Config{
			Mode:                   "release",
			DevSyncMode:            "release",
			AutoRestartAfterUpdate: true,
			UpdateRepo:             "dreamforSh/Slipgate",
			UpdateBranch:           "main",
			HotUpdateDir:           hotDir,
		},
		Version:            "0.2.0",
		InitialCommit:      "deadbeef12345678",
		EdgeExecutablePath: edgeExe,
		Logger:             log.New(io.Discard, "", 0),
	}).Status()
	if rebooted.BootID == "" || rebooted.BootID == st.BootID {
		t.Fatalf("expected new unique BootID after restart, old=%q new=%q", st.BootID, rebooted.BootID)
	}
	if rebooted.Version != "0.2.0" || rebooted.EdgeBinaryStaged || !rebooted.CanRollback || rebooted.RestartScheduled {
		t.Fatalf("unexpected rebooted status from active.json: %+v", rebooted)
	}
}

func TestPreflightValidationFailureBlocksRestart(t *testing.T) {
	t.Parallel()

	ext := exeExt()
	edgeExe := filepath.Join(t.TempDir(), "slipgate"+ext)
	if err := os.WriteFile(edgeExe, []byte("v1-good"), 0o755); err != nil {
		t.Fatalf("write baseline binary: %v", err)
	}

	assetName := PlatformAssetName("dev")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"slipgate-dev/webui/index.html": []byte("<html>bad-ui</html>"),
		"slipgate-dev/slipgate" + ext:   []byte("corrupted-edge"),
	})
	sum := sha256.Sum256(archiveBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/tags/dev-latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "dev-latest",
				TargetCommitish: "badc0de12345",
				Assets: []githubAsset{
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case "/dl/" + assetName:
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	hotDir := t.TempDir()
	restartCh := make(chan string, 1)
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:                   "dev",
			DevSyncMode:            "release",
			AutoRestartAfterUpdate: true,
			UpdateRepo:             "dreamforSh/Slipgate",
			UpdateBranch:           "main",
			HotUpdateDir:           hotDir,
		},
		Version:            "0.1.0",
		InitialCommit:      "111111110000",
		APIBaseURL:         srv.URL,
		AllowCustomHost:    true,
		Logger:             log.New(io.Discard, "", 0),
		EdgeExecutablePath: edgeExe,
		RestartDelay:       10 * time.Millisecond,
		ValidateEdgeBin: func(_ context.Context, _ string) error {
			return errors.New("corrupt binary failed --version")
		},
		OnEdgeRestart: func(target string) {
			restartCh <- target
		},
	})

	st, err := mgr.Sync(context.Background(), false, true)
	if err == nil || !strings.Contains(err.Error(), "corrupt binary") {
		t.Fatalf("expected preflight validation error, got err=%v status=%+v", err, st)
	}
	if st.RestartScheduled || st.State != StateError {
		t.Fatalf("expected RestartScheduled=false and StateError, got %+v", st)
	}
	if _, hasActive := LoadActiveRelease(hotDir); hasActive {
		t.Fatalf("active.json must not be persisted when preflight validation fails")
	}
	onDisk, _ := os.ReadFile(edgeExe)
	if string(onDisk) != "v1-good" {
		t.Fatalf("expected original edge binary to remain untouched, got %q", string(onDisk))
	}
	select {
	case target := <-restartCh:
		t.Fatalf("OnEdgeRestart must not fire after validation failure, got %s", target)
	case <-time.After(60 * time.Millisecond):
	}
}

func TestManualTriggerRestartAndAutoRestartConfigToggle(t *testing.T) {
	t.Parallel()

	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exeBytes, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read test executable: %v", err)
	}

	sup := supervisor.New(log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		_ = sup.Stop(2 * time.Second)
	}()

	if err := sup.StartAll(ctx, []supervisor.ChildSpec{
		{Name: "core", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
		{Name: "bff", Binary: exePath, Args: []string{"-test.run=TestHelperProcess"}, Env: []string{"GO_WANT_HOTUPDATE_HELPER=1"}},
	}); err != nil {
		t.Fatalf("StartAll: %v", err)
	}
	beforeSnaps := sup.Snapshots()

	ext := exeExt()
	edgeExe := filepath.Join(t.TempDir(), "slipgate"+ext)
	if err := os.WriteFile(edgeExe, []byte("v1-edge"), 0o755); err != nil {
		t.Fatalf("write fake edge binary: %v", err)
	}

	assetName := PlatformAssetName("dev")
	archiveBytes := buildMockArchive(t, assetName, map[string][]byte{
		"slipgate-dev/webui/index.html":    []byte("<html>manual-restart-ui</html>"),
		"slipgate-dev/slipgate-core" + ext: exeBytes,
		"slipgate-dev/slipgate-bff" + ext:  exeBytes,
		"slipgate-dev/slipgate" + ext:      []byte("v2-manual-edge"),
	})
	sum := sha256.Sum256(archiveBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/dreamforSh/Slipgate/releases/tags/dev-latest":
			_ = json.NewEncoder(w).Encode(githubRelease{
				TagName:         "dev-latest",
				TargetCommitish: "cafebabe1234",
				Assets: []githubAsset{
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: srvURL + "/dl/SHA256SUMS.txt"},
					{Name: assetName, BrowserDownloadURL: srvURL + "/dl/" + assetName},
				},
			})
		case "/dl/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case "/dl/" + assetName:
			_, _ = w.Write(archiveBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	hotDir := t.TempDir()
	restartCh := make(chan string, 2)
	mgr := NewManager(Options{
		Config: config.Config{
			Mode:                   "dev",
			DevSyncMode:            "release",
			AutoRestartAfterUpdate: true,
			UpdateRepo:             "dreamforSh/Slipgate",
			UpdateBranch:           "main",
			HotUpdateDir:           hotDir,
		},
		Version:            "0.1.0",
		InitialCommit:      "111111110000",
		Supervisor:         sup,
		APIBaseURL:         srv.URL,
		AllowCustomHost:    true,
		Logger:             log.New(io.Discard, "", 0),
		EdgeExecutablePath: edgeExe,
		RestartDelay:       20 * time.Millisecond,
		ValidateEdgeBin:    func(_ context.Context, _ string) error { return nil },
		OnEdgeRestart:      func(target string) { restartCh <- target },
	})

	off := false
	cfgSnap, err := mgr.UpdateConfig(ConfigPatch{AutoRestartAfterUpdate: &off})
	if err != nil || cfgSnap.AutoRestartAfterUpdate {
		t.Fatalf("expected AutoRestartAfterUpdate=false after UpdateConfig, got %+v err=%v", cfgSnap, err)
	}

	// Verify AutoRestartAfterUpdate=false persists across restarts.
	reloaded := NewManager(Options{
		Config: config.Config{
			Mode:                   "dev",
			DevSyncMode:            "release",
			AutoRestartAfterUpdate: true,
			UpdateRepo:             "dreamforSh/Slipgate",
			UpdateBranch:           "main",
			HotUpdateDir:           hotDir,
		},
		Logger: log.New(io.Discard, "", 0),
	}).Status()
	if reloaded.AutoRestartAfterUpdate {
		t.Fatalf("expected persisted AutoRestartAfterUpdate=false in config.json")
	}

	st, err := mgr.Sync(context.Background(), false, false)
	if err != nil {
		t.Fatalf("Sync with autoRestartAfterUpdate=false failed: %v", err)
	}
	if st.State != StateIdle || st.RestartScheduled || !st.EdgeBinaryStaged {
		t.Fatalf("expected StateIdle, RestartScheduled=false, EdgeBinaryStaged=true, got %+v", st)
	}
	afterSnaps := sup.Snapshots()
	if afterSnaps[0].PID == beforeSnaps[0].PID || afterSnaps[1].PID == beforeSnaps[1].PID {
		t.Fatalf("expected child planes to hot-restart when AutoRestartAfterUpdate=false")
	}
	select {
	case target := <-restartCh:
		t.Fatalf("OnEdgeRestart must not fire automatically when disabled, got %s", target)
	case <-time.After(50 * time.Millisecond):
	}

	// Manual TriggerRestart executes OnEdgeRestart once.
	rstSnap, err := mgr.TriggerRestart(context.Background(), true)
	if err != nil {
		t.Fatalf("TriggerRestart failed: %v", err)
	}
	if rstSnap.State != StateRestarting || !rstSnap.RestartScheduled {
		t.Fatalf("expected StateRestarting + RestartScheduled=true after TriggerRestart, got %+v", rstSnap)
	}
	select {
	case target := <-restartCh:
		if !SameExecutablePath(target, edgeExe) {
			t.Fatalf("expected TriggerRestart target %s, got %s", edgeExe, target)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for TriggerRestart callback")
	}
}
