package hotupdate

import (
	"archive/tar"
	"archive/zip"
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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
)

var (
	ErrChecksumMismatch      = errors.New("hotupdate: sha256 checksum mismatch")
	ErrUnsafeArchivePath     = errors.New("hotupdate: unsafe archive entry path")
	ErrUntrustedDownloadHost = errors.New("hotupdate: untrusted download URL host")
	ErrDirtyGitWorktree      = errors.New("hotupdate: git worktree has uncommitted changes")
)

const (
	maxManifestBytes = 4 << 20   // 4 MiB
	maxArchiveBytes  = 512 << 20 // 512 MiB
	maxExtractedFile = 256 << 20 // 256 MiB
)

// Options configures the repo-synced hot-update manager.
type Options struct {
	Config          config.Config
	Version         string
	InitialCommit   string
	Supervisor      *supervisor.Supervisor
	Logger          *log.Logger
	APIBaseURL      string
	AllowCustomHost bool
	OnWebUIDir      func(string)
}

// StatusSnapshot matches packages/contracts/src/system.ts SystemUpdateStatusSchema.
type StatusSnapshot struct {
	Mode             string  `json:"mode"`
	Strategy         string  `json:"strategy"`
	ResolvedStrategy string  `json:"resolvedStrategy"`
	Repo             string  `json:"repo"`
	Branch           string  `json:"branch"`
	Version          string  `json:"version"`
	ActiveCommit     string  `json:"activeCommit"`
	RemoteCommit     *string `json:"remoteCommit"`
	UpdateAvailable  bool    `json:"updateAvailable"`
	AutoSyncEnabled  bool    `json:"autoSyncEnabled"`
	IntervalSeconds  int     `json:"intervalSeconds"`
	State            string  `json:"state"`
	ReloadCount      int     `json:"reloadCount"`
	WebUIOverridden  bool    `json:"webUiOverridden"`
	EdgeBinaryStaged bool    `json:"edgeBinaryStaged"`
	LastCheckedAtIso *string `json:"lastCheckedAtIso"`
	LastUpdatedAtIso *string `json:"lastUpdatedAtIso"`
	LastError        *string `json:"lastError"`
}

type githubAsset struct {
	Name               string `json:"name"`
	APIURL             string `json:"url"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type githubRelease struct {
	TagName         string        `json:"tag_name"`
	TargetCommitish string        `json:"target_commitish"`
	Assets          []githubAsset `json:"assets"`
}

type buildMeta struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// Manager polls or triggers repo-synced hot updates in dev mode.
type Manager struct {
	cfg             config.Config
	sup             *supervisor.Supervisor
	logger          *log.Logger
	apiBaseURL      string
	allowCustomHost bool
	onWebUIDir      func(string)
	httpClient      *http.Client
	repoDir         string

	syncMu sync.Mutex
	mu     sync.RWMutex
	status StatusSnapshot
}

// NewManager constructs a hot-update Manager from runtime config and supervisor.
func NewManager(opts Options) *Manager {
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	apiBase := strings.TrimRight(strings.TrimSpace(opts.APIBaseURL), "/")
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}

	repoDir := strings.TrimSpace(opts.Config.GitRepoDir)
	if repoDir == "" {
		if wd, err := os.Getwd(); err == nil {
			repoDir = findGitRoot(wd)
		}
	}

	resolved := resolveStrategy(opts.Config.DevSyncMode, repoDir)
	version := strings.TrimSpace(opts.Version)
	if version == "" {
		version = "0.1.0"
	}
	commit := strings.TrimSpace(opts.InitialCommit)
	if commit == "" {
		commit = "dev"
	}
	if resolved == "git" && commit == "dev" && repoDir != "" {
		if head, err := readGitHead(repoDir); err == nil && head != "" {
			commit = head
		}
	}

	autoSync := opts.Config.Mode == "dev" && opts.Config.DevSyncIntervalSec > 0

	m := &Manager{
		cfg:             opts.Config,
		sup:             opts.Supervisor,
		logger:          logger,
		apiBaseURL:      apiBase,
		allowCustomHost: opts.AllowCustomHost,
		onWebUIDir:      opts.OnWebUIDir,
		repoDir:         repoDir,
		status: StatusSnapshot{
			Mode:             opts.Config.Mode,
			Strategy:         opts.Config.DevSyncMode,
			ResolvedStrategy: resolved,
			Repo:             opts.Config.UpdateRepo,
			Branch:           opts.Config.UpdateBranch,
			Version:          version,
			ActiveCommit:     commit,
			AutoSyncEnabled:  autoSync,
			IntervalSeconds:  opts.Config.DevSyncIntervalSec,
			State:            "idle",
			WebUIOverridden:  opts.Config.WebUIDir != "",
		},
	}

	m.httpClient = &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("hotupdate: too many HTTP redirects")
			}
			if err := validateDownloadURL(req.URL.String(), m.allowCustomHost); err != nil {
				return err
			}
			// Never forward GitHub Authorization headers to external CDN / S3 hosts.
			if len(via) > 0 && req.URL.Host != via[0].URL.Host {
				req.Header.Del("Authorization")
			}
			return nil
		},
	}

	return m
}

// StartAutoSync starts background repo polling when Mode=="dev" and DevSyncIntervalSec > 0.
func (m *Manager) StartAutoSync(ctx context.Context) {
	if m.cfg.Mode != "dev" || m.cfg.DevSyncIntervalSec <= 0 {
		return
	}

	interval := time.Duration(m.cfg.DevSyncIntervalSec) * time.Second
	go func() {
		initialTimer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			initialTimer.Stop()
			return
		case <-initialTimer.C:
		}

		if _, err := m.Sync(ctx, false, false); err != nil {
			m.logger.Printf("[hotupdate] initial dev sync check failed: %v", err)
		}

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := m.Sync(ctx, false, false); err != nil {
					m.logger.Printf("[hotupdate] periodic dev sync failed: %v", err)
				}
			}
		}
	}()
}

// Status returns a thread-safe copy of the current update state.
func (m *Manager) Status() StatusSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneSnapshot(m.status)
}

// Sync checks the configured repository for updates and applies them if checkOnly is false.
// When asyncRestart is true, child plane restarts run shortly after Sync returns so proxied HTTP responses flush cleanly.
func (m *Manager) Sync(ctx context.Context, checkOnly bool, asyncRestart bool) (StatusSnapshot, error) {
	if !checkOnly && !strings.EqualFold(strings.TrimSpace(m.cfg.Mode), "dev") {
		return m.Status(), errors.New("hotupdate: binary apply is disabled outside dev mode (SLIPGATE_MODE=dev required)")
	}
	m.syncMu.Lock()
	defer m.syncMu.Unlock()

	m.setState("checking", nil)
	now := isoNow()
	m.mu.Lock()
	m.status.LastCheckedAtIso = &now
	resolved := resolveStrategy(m.cfg.DevSyncMode, m.repoDir)
	m.status.ResolvedStrategy = resolved
	m.mu.Unlock()

	var err error
	if resolved == "git" {
		err = m.syncGit(ctx, checkOnly, asyncRestart)
	} else {
		err = m.syncRelease(ctx, checkOnly, asyncRestart)
	}

	if err != nil {
		msg := err.Error()
		m.setState("error", &msg)
		return m.Status(), err
	}

	m.setState("idle", nil)
	return m.Status(), nil
}

func (m *Manager) syncRelease(ctx context.Context, checkOnly bool, asyncRestart bool) error {
	relURL := fmt.Sprintf("%s/repos/%s/releases/tags/dev-latest", m.apiBaseURL, m.cfg.UpdateRepo)
	var rel githubRelease
	if err := m.fetchJSON(ctx, relURL, &rel); err != nil {
		return fmt.Errorf("fetch dev-latest release: %w", err)
	}

	remoteCommit := strings.TrimSpace(rel.TargetCommitish)
	remoteVersion := strings.TrimSpace(rel.TagName)

	if metaAsset, ok := findAsset(rel.Assets, "BUILD_META.json"); ok {
		if metaRaw, err := m.downloadBytes(ctx, m.assetDownloadURL(metaAsset), maxManifestBytes); err == nil {
			var meta buildMeta
			if json.Unmarshal(metaRaw, &meta) == nil {
				if strings.TrimSpace(meta.Commit) != "" {
					remoteCommit = strings.TrimSpace(meta.Commit)
				}
				if strings.TrimSpace(meta.Version) != "" {
					remoteVersion = strings.TrimSpace(meta.Version)
				}
			}
		}
	}

	m.mu.Lock()
	activeCommit := m.status.ActiveCommit
	available := remoteCommit != "" && !commitsEqual(remoteCommit, activeCommit)
	if remoteCommit != "" {
		rc := remoteCommit
		m.status.RemoteCommit = &rc
	}
	m.status.UpdateAvailable = available
	m.mu.Unlock()

	if checkOnly || !available {
		return nil
	}

	m.setState("downloading", nil)

	sumsAsset, hasSums := findAsset(rel.Assets, "SHA256SUMS.txt")
	if !hasSums {
		return fmt.Errorf("%w: missing SHA256SUMS.txt in dev-latest release", ErrChecksumMismatch)
	}
	sumsBytes, err := m.downloadBytes(ctx, m.assetDownloadURL(sumsAsset), maxManifestBytes)
	if err != nil {
		return fmt.Errorf("download SHA256SUMS.txt: %w", err)
	}

	var chosen *githubAsset
	for _, candidate := range PlatformAssetCandidates("dev") {
		if asset, ok := findAsset(rel.Assets, candidate); ok {
			chosen = &asset
			break
		}
	}
	if chosen == nil {
		return fmt.Errorf("hotupdate: no matching archive asset for %s/%s in dev-latest", runtime.GOOS, runtime.GOARCH)
	}

	expectedSHA, ok := lookupChecksum(sumsBytes, chosen.Name)
	if !ok {
		return fmt.Errorf("%w: %s absent from SHA256SUMS.txt", ErrChecksumMismatch, chosen.Name)
	}

	tmpDir, err := os.MkdirTemp("", "slipgate-dl-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, chosen.Name)
	if err := m.downloadVerifiedFile(ctx, m.assetDownloadURL(*chosen), archivePath, expectedSHA); err != nil {
		return err
	}

	m.setState("applying", nil)
	shortCommit := remoteCommit
	if len(shortCommit) > 12 {
		shortCommit = shortCommit[:12]
	}
	releasesRoot := filepath.Join(m.cfg.HotUpdateDir, "releases")
	targetDir := filepath.Join(releasesRoot, fmt.Sprintf("%s-%d", shortCommit, time.Now().UnixNano()))
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return fmt.Errorf("prepare release dir: %w", err)
	}

	if err := extractArchive(archivePath, targetDir); err != nil {
		_ = os.RemoveAll(targetDir)
		return fmt.Errorf("extract archive: %w", err)
	}

	bundleRoot := resolveBundleRoot(targetDir)
	applied, err := m.applyExtractedBundle(ctx, bundleRoot, remoteCommit, remoteVersion, asyncRestart)
	if err != nil {
		_ = os.RemoveAll(targetDir)
		return err
	}
	if applied {
		pruneOldReleases(releasesRoot, targetDir, 2)
	}
	return nil
}

func (m *Manager) applyExtractedBundle(
	ctx context.Context,
	bundleRoot string,
	newCommit string,
	newVersion string,
	asyncRestart bool,
) (bool, error) {
	webDir := filepath.Join(bundleRoot, "webui")
	webOverridden := false
	if info, err := os.Stat(filepath.Join(webDir, "index.html")); err == nil && !info.IsDir() {
		if m.onWebUIDir != nil {
			m.onWebUIDir(webDir)
			webOverridden = true
		}
	}

	ext := exeExt()
	coreBin := filepath.Join(bundleRoot, "slipgate-core"+ext)
	bffBin := filepath.Join(bundleRoot, "slipgate-bff"+ext)
	edgeBin := filepath.Join(bundleRoot, "slipgate"+ext)

	edgeStaged := false
	if info, err := os.Stat(edgeBin); err == nil && !info.IsDir() {
		edgeStaged = true
	}

	reloaded := false
	if m.sup != nil {
		updatedChild := false
		if info, err := os.Stat(coreBin); err == nil && !info.IsDir() {
			_ = os.Chmod(coreBin, 0o755)
			if err := m.sup.UpdateChildBinary("core", coreBin); err == nil {
				updatedChild = true
			}
		}
		if info, err := os.Stat(bffBin); err == nil && !info.IsDir() {
			_ = os.Chmod(bffBin, 0o755)
			if err := m.sup.UpdateChildBinary("bff", bffBin); err == nil {
				updatedChild = true
			}
		}
		if updatedChild {
			m.setState("reloading_planes", nil)
			reloaded = true
			if asyncRestart {
				time.AfterFunc(150*time.Millisecond, func() {
					if err := m.sup.RestartAll(context.Background(), 5*time.Second); err != nil {
						m.logger.Printf("[hotupdate] async plane restart warning: %v", err)
					}
				})
			} else {
				if err := m.sup.RestartAll(ctx, 5*time.Second); err != nil {
					return false, fmt.Errorf("restart supervised planes: %w", err)
				}
			}
		}
	}

	updatedAt := isoNow()
	m.mu.Lock()
	m.status.ActiveCommit = newCommit
	if newVersion != "" {
		m.status.Version = newVersion
	}
	rc := newCommit
	m.status.RemoteCommit = &rc
	m.status.UpdateAvailable = false
	m.status.WebUIOverridden = m.status.WebUIOverridden || webOverridden
	m.status.EdgeBinaryStaged = edgeStaged
	m.status.LastUpdatedAtIso = &updatedAt
	if reloaded || webOverridden {
		m.status.ReloadCount++
	}
	m.mu.Unlock()

	return true, nil
}

func (m *Manager) syncGit(ctx context.Context, checkOnly bool, asyncRestart bool) error {
	if m.repoDir == "" {
		return errors.New("hotupdate: git strategy selected but repository directory was not found")
	}

	if _, err := runCmd(ctx, m.repoDir, "git", "fetch", "origin", m.cfg.UpdateBranch, "--quiet"); err != nil {
		return fmt.Errorf("git fetch origin %s: %w", m.cfg.UpdateBranch, err)
	}
	headOut, err := runCmd(ctx, m.repoDir, "git", "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("git rev-parse HEAD: %w", err)
	}
	fetchOut, err := runCmd(ctx, m.repoDir, "git", "rev-parse", "FETCH_HEAD")
	if err != nil {
		return fmt.Errorf("git rev-parse FETCH_HEAD: %w", err)
	}

	localCommit := strings.TrimSpace(headOut)
	remoteCommit := strings.TrimSpace(fetchOut)

	m.mu.Lock()
	m.status.ActiveCommit = localCommit
	rc := remoteCommit
	m.status.RemoteCommit = &rc
	available := remoteCommit != "" && !commitsEqual(localCommit, remoteCommit)
	m.status.UpdateAvailable = available
	m.mu.Unlock()

	if checkOnly || !available {
		return nil
	}

	porcelain, err := runCmd(ctx, m.repoDir, "git", "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("git status: %w", err)
	}
	if strings.TrimSpace(porcelain) != "" {
		return ErrDirtyGitWorktree
	}

	m.setState("downloading", nil)
	if _, err := runCmd(ctx, m.repoDir, "git", "pull", "--ff-only", "origin", m.cfg.UpdateBranch); err != nil {
		return fmt.Errorf("git pull --ff-only: %w", err)
	}

	m.setState("applying", nil)
	ext := exeExt()
	stageDir := filepath.Join(m.cfg.HotUpdateDir, "git-builds", remoteCommit[:min(12, len(remoteCommit))])
	if err := os.MkdirAll(stageDir, 0o755); err != nil {
		return err
	}

	if _, err := exec.LookPath("bun"); err == nil {
		if _, err := runCmd(ctx, m.repoDir, "bun", "run", "--cwd", "apps/web-vue", "build"); err != nil {
			return fmt.Errorf("rebuild web-vue: %w", err)
		}
		webDist := filepath.Join(m.repoDir, "apps", "web-vue", "dist")
		stageWeb := filepath.Join(stageDir, "webui")
		_ = os.RemoveAll(stageWeb)
		if err := copyDir(webDist, stageWeb); err != nil {
			return fmt.Errorf("stage webui dir: %w", err)
		}

		bffOut := filepath.Join(stageDir, "slipgate-bff"+ext)
		if _, err := runCmd(ctx, m.repoDir, "bun", "build", "--compile", "services/bff-ts/src/index.ts", "--outfile", bffOut); err != nil {
			return fmt.Errorf("rebuild slipgate-bff: %w", err)
		}
	}

	if _, err := exec.LookPath("zig"); err == nil {
		zigDir := filepath.Join(m.repoDir, "services", "core-zig")
		if _, err := runCmd(ctx, zigDir, "zig", "build", "--prefix", stageDir, "-Doptimize=ReleaseSafe"); err != nil {
			return fmt.Errorf("rebuild slipgate-core: %w", err)
		}
		zigOutCore := filepath.Join(stageDir, "bin", "slipgate-core"+ext)
		if _, statErr := os.Stat(zigOutCore); statErr == nil {
			_ = os.Rename(zigOutCore, filepath.Join(stageDir, "slipgate-core"+ext))
		}
	}

	_, err = m.applyExtractedBundle(ctx, stageDir, remoteCommit, m.status.Version, asyncRestart)
	return err
}

func (m *Manager) setState(state string, lastErr *string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.State = state
	m.status.LastError = lastErr
}

func (m *Manager) fetchJSON(ctx context.Context, rawURL string, dest any) error {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d from %s: %s", resp.StatusCode, rawURL, strings.TrimSpace(string(snippet)))
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, dest)
}

func (m *Manager) assetDownloadURL(a githubAsset) string {
	if m.cfg.GitHubToken != "" && strings.TrimSpace(a.APIURL) != "" {
		return strings.TrimSpace(a.APIURL)
	}
	if strings.TrimSpace(a.BrowserDownloadURL) != "" {
		return strings.TrimSpace(a.BrowserDownloadURL)
	}
	return strings.TrimSpace(a.APIURL)
}

func (m *Manager) downloadBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, rawURL)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func (m *Manager) downloadVerifiedFile(ctx context.Context, rawURL, destPath, expectedSHA string) error {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d downloading archive %s", resp.StatusCode, rawURL)
	}

	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	hasher := sha256.New()
	limited := io.LimitReader(resp.Body, maxArchiveBytes+1)
	written, copyErr := io.Copy(io.MultiWriter(f, hasher), limited)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return closeErr
	}
	if written > maxArchiveBytes {
		_ = os.Remove(destPath)
		return fmt.Errorf("archive exceeds %d bytes", maxArchiveBytes)
	}

	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(gotSHA, strings.TrimSpace(expectedSHA)) {
		_ = os.Remove(destPath)
		return fmt.Errorf("%w: expected %s got %s", ErrChecksumMismatch, expectedSHA, gotSHA)
	}
	return nil
}

// PlatformAssetCandidates returns ordered archive names matching the current OS/arch and libc.
func PlatformAssetCandidates(tagPrefix string) []string {
	arch := runtime.GOARCH
	switch runtime.GOOS {
	case "windows":
		return []string{fmt.Sprintf("slipgate-%s-windows-%s.zip", tagPrefix, arch)}
	case "linux":
		musl := fmt.Sprintf("slipgate-%s-linux-%s-musl.tar.gz", tagPrefix, arch)
		glibc := fmt.Sprintf("slipgate-%s-linux-%s.tar.gz", tagPrefix, arch)
		if isMuslLinux() {
			return []string{musl, glibc}
		}
		return []string{glibc, musl}
	default:
		return []string{fmt.Sprintf("slipgate-%s-%s-%s.tar.gz", tagPrefix, runtime.GOOS, arch)}
	}
}

// PlatformAssetName returns the primary asset filename expected for this platform.
func PlatformAssetName(tagPrefix string) string {
	return PlatformAssetCandidates(tagPrefix)[0]
}

func validateDownloadURL(rawURL string, allowCustomHost bool) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if allowCustomHost {
		if u.Scheme != "http" && u.Scheme != "https" {
			return fmt.Errorf("%w: unsupported scheme %q", ErrUntrustedDownloadHost, u.Scheme)
		}
		return nil
	}
	if u.Scheme != "https" {
		return fmt.Errorf("%w: non-HTTPS scheme %q", ErrUntrustedDownloadHost, u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "api.github.com", "github.com", "objects.githubusercontent.com", "codeload.github.com":
		return nil
	}
	if strings.HasSuffix(host, ".githubusercontent.com") {
		return nil
	}
	return fmt.Errorf("%w: %q", ErrUntrustedDownloadHost, host)
}

func resolveStrategy(configuredMode, repoDir string) string {
	switch configuredMode {
	case "git":
		return "git"
	case "release":
		return "release"
	default:
		if repoDir != "" && hasTool("git") && (hasTool("bun") || hasTool("zig")) {
			return "git"
		}
		return "release"
	}
}

func hasTool(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func findGitRoot(startDir string) string {
	cur := startDir
	for {
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return ""
		}
		cur = parent
	}
}

func readGitHead(repoDir string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := runCmd(ctx, repoDir, "git", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func runCmd(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func findAsset(assets []githubAsset, name string) (githubAsset, bool) {
	for _, a := range assets {
		if a.Name == name {
			return a, true
		}
	}
	return githubAsset{}, false
}

func lookupChecksum(sumsBytes []byte, fileName string) (string, bool) {
	lines := strings.Split(string(sumsBytes), "\n")
	for _, line := range lines {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		candidate := strings.TrimPrefix(fields[1], "*")
		candidate = filepath.Base(candidate)
		if candidate == fileName {
			return fields[0], true
		}
	}
	return "", false
}

func extractArchive(archivePath, destDir string) error {
	if strings.HasSuffix(strings.ToLower(archivePath), ".zip") {
		return extractZip(archivePath, destDir)
	}
	return extractTarGz(archivePath, destDir)
}

func extractTarGz(archivePath, destDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}

		target, err := safeJoin(destDir, hdr.Name)
		if err != nil {
			return err
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(hdr.Mode) & 0o777
			if mode == 0 {
				mode = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, io.LimitReader(tr, maxExtractedFile))
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink, tar.TypeLink:
			return fmt.Errorf("%w: symlink entry %q rejected", ErrUnsafeArchivePath, hdr.Name)
		}
	}
	return nil
}

func extractZip(archivePath, destDir string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, zf := range zr.File {
		if zf.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink entry %q rejected", ErrUnsafeArchivePath, zf.Name)
		}
		target, err := safeJoin(destDir, zf.Name)
		if err != nil {
			return err
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, zf.Mode()&0o777|0o644)
		if err != nil {
			_ = rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, io.LimitReader(rc, maxExtractedFile))
		closeOut := out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeOut != nil {
			return closeOut
		}
	}
	return nil
}

func safeJoin(rootDir, entryName string) (string, error) {
	if strings.HasPrefix(entryName, "/") || strings.HasPrefix(entryName, `\`) {
		return "", fmt.Errorf("%w: absolute entry %q", ErrUnsafeArchivePath, entryName)
	}
	normalized := filepath.FromSlash(strings.ReplaceAll(entryName, `\`, "/"))
	cleaned := filepath.Clean(normalized)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) || filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("%w: traversal entry %q", ErrUnsafeArchivePath, entryName)
	}
	target := filepath.Join(rootDir, cleaned)
	rel, err := filepath.Rel(rootDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: escaped root %q", ErrUnsafeArchivePath, entryName)
	}
	return target, nil
}

func resolveBundleRoot(extractDir string) string {
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return extractDir
	}
	var dirs []string
	hasFiles := false
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		} else {
			hasFiles = true
		}
	}
	if !hasFiles && len(dirs) == 1 {
		return filepath.Join(extractDir, dirs[0])
	}
	return extractDir
}

func pruneOldReleases(releasesRoot, keepDir string, maxKeep int) {
	entries, err := os.ReadDir(releasesRoot)
	if err != nil {
		return
	}
	type item struct {
		path string
		mod  time.Time
	}
	var items []item
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		full := filepath.Join(releasesRoot, e.Name())
		if full == keepDir {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		items = append(items, item{path: full, mod: info.ModTime()})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].mod.After(items[j].mod)
	})
	keepPrevious := maxKeep - 1
	if keepPrevious < 0 {
		keepPrevious = 0
	}
	for i := keepPrevious; i < len(items); i++ {
		_ = os.RemoveAll(items[i].path)
	}
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func isMuslLinux() bool {
	if _, err := os.Stat("/etc/alpine-release"); err == nil {
		return true
	}
	for _, pattern := range []string{"/lib/ld-musl-*.so.1", "/usr/lib/ld-musl-*.so.1"} {
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			return true
		}
	}
	return false
}

func commitsEqual(a, b string) bool {
	a = strings.ToLower(strings.TrimSpace(a))
	b = strings.ToLower(strings.TrimSpace(b))
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	if len(a) >= 7 && len(b) >= 7 {
		return strings.HasPrefix(a, b) || strings.HasPrefix(b, a)
	}
	return false
}

func exeExt() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

func isoNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func cloneSnapshot(in StatusSnapshot) StatusSnapshot {
	out := in
	out.RemoteCommit = cloneStrPtr(in.RemoteCommit)
	out.LastCheckedAtIso = cloneStrPtr(in.LastCheckedAtIso)
	out.LastUpdatedAtIso = cloneStrPtr(in.LastUpdatedAtIso)
	out.LastError = cloneStrPtr(in.LastError)
	return out
}

func cloneStrPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
