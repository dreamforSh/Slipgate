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
