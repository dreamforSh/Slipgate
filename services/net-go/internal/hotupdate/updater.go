package hotupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	ErrRollbackUnavailable   = errors.New("hotupdate: no previous release available for rollback")
	ErrInvalidUpdateConfig   = errors.New("hotupdate: invalid update configuration")
	ErrUpdateBusy            = errors.New("hotupdate: another update operation is already in progress")
	ErrRestartUnavailable    = errors.New("hotupdate: automatic edge restart is not configured")
)

const (
	StateIdle            = "idle"
	StateChecking        = "checking"
	StateDownloading     = "downloading"
	StateApplying        = "applying"
	StateReloadingPlanes = "reloading_planes"
	StateRestarting      = "restarting"
	StateRollingBack     = "rolling_back"
	StateError           = "error"
)

const (
	ChannelStable = "stable"
	ChannelDev    = "dev"
)

const (
	maxManifestBytes = 4 << 20   // 4 MiB
	maxArchiveBytes  = 512 << 20 // 512 MiB
	maxExtractedFile = 256 << 20 // 256 MiB
	maxHistoryItems  = 30
	maxKeepReleases  = 5
	releasesCacheTTL = 60 * time.Second

	defaultDrainTimeoutSec = config.DefaultDrainTimeoutSec
)

// Options configures the repo-synced hot-update manager.
type Options struct {
	Config             config.Config
	Version            string
	InitialCommit      string
	Supervisor         *supervisor.Supervisor
	Logger             *log.Logger
	APIBaseURL         string
	AllowCustomHost    bool
	OnWebUIDir         func(string)
	GetWebUIDir        func() string
	OnGuestdBin        func(string)
	OnPlanesRestarted  func(context.Context)
	OnEdgeRestart      func(targetBinary string)
	ValidateEdgeBin    func(ctx context.Context, binPath string) error
	RestartDelay       time.Duration
	EdgeExecutablePath string
}

// Progress tracks real-time download or staging progress for active updates.
type Progress struct {
	Stage           string  `json:"stage"`
	DownloadedBytes int64   `json:"downloadedBytes"`
	TotalBytes      int64   `json:"totalBytes"`
	Percent         float64 `json:"percent"`
}

// ComponentStatus reports runtime state and hot-update override status for one Slipgate component.
type ComponentStatus struct {
	Name            string  `json:"name"`
	Status          string  `json:"status"`
	BinaryPath      *string `json:"binaryPath"`
	Overridden      bool    `json:"overridden"`
	RestartRequired bool    `json:"restartRequired"`
	PID             int     `json:"pid"`
	LastError       *string `json:"lastError"`
}

// HistoryEntry records an applied release update or rollback attempt.
type HistoryEntry struct {
	ID                string  `json:"id"`
	Action            string  `json:"action"`
	FromVersion       string  `json:"fromVersion"`
	ToVersion         string  `json:"toVersion"`
	FromCommit        string  `json:"fromCommit"`
	ToCommit          string  `json:"toCommit"`
	Tag               *string `json:"tag"`
	Channel           string  `json:"channel"`
	Strategy          string  `json:"strategy"`
	BundleDir         *string `json:"bundleDir"`
	RollbackAvailable bool    `json:"rollbackAvailable"`
	Succeeded         bool    `json:"succeeded"`
	Error             *string `json:"error"`
	CreatedAtIso      string  `json:"createdAtIso"`
}

// PreviousReleaseInfo summarizes the immediate rollback target if one is available on disk.
type PreviousReleaseInfo struct {
	ID      string  `json:"id"`
	Version string  `json:"version"`
	Commit  string  `json:"commit"`
	Tag     *string `json:"tag"`
}

// ReleaseItem describes a GitHub Release discovered on the configured repository.
type ReleaseItem struct {
	Tag            string  `json:"tag"`
	Name           string  `json:"name"`
	Version        string  `json:"version"`
	Commit         *string `json:"commit"`
	Channel        string  `json:"channel"`
	Prerelease     bool    `json:"prerelease"`
	PublishedAtIso *string `json:"publishedAtIso"`
	HTMLURL        *string `json:"htmlUrl"`
	Body           string  `json:"body"`
	AssetName      *string `json:"assetName"`
	AssetSizeBytes *int64  `json:"assetSizeBytes"`
	Current        bool    `json:"current"`
	Installable    bool    `json:"installable"`
}

// ReleasesResult matches packages/contracts/src/system.ts SystemReleasesResponseSchema.
type ReleasesResult struct {
	Repo           string        `json:"repo"`
	CurrentVersion string        `json:"currentVersion"`
	CurrentCommit  string        `json:"currentCommit"`
	Standalone     bool          `json:"standalone"`
	FetchedAtIso   *string       `json:"fetchedAtIso"`
	Releases       []ReleaseItem `json:"releases"`
}

// ConfigPatch holds runtime update policy changes sent via PUT /internal/supervisor/update/config.
type ConfigPatch struct {
	Channel                *string `json:"channel,omitempty"`
	AutoSyncEnabled        *bool   `json:"autoSyncEnabled,omitempty"`
	IntervalSeconds        *int    `json:"intervalSeconds,omitempty"`
	AutoRestartAfterUpdate *bool   `json:"autoRestartAfterUpdate,omitempty"`
	DrainTimeoutSeconds    *int    `json:"drainTimeoutSeconds,omitempty"`
	Strategy               *string `json:"strategy,omitempty"`
}

// SyncOptions controls manual or scheduled check/apply behavior.
type SyncOptions struct {
	CheckOnly         bool
	AsyncRestart      bool
	Channel           string
	TargetTag         string
	Force             bool
	AllowReleaseApply bool
}

// StatusSnapshot matches packages/contracts/src/system.ts SystemUpdateStatusSchema.
type StatusSnapshot struct {
	Mode                   string               `json:"mode"`
	Channel                string               `json:"channel"`
	Standalone             bool                 `json:"standalone"`
	Strategy               string               `json:"strategy"`
	ResolvedStrategy       string               `json:"resolvedStrategy"`
	Repo                   string               `json:"repo"`
	Branch                 string               `json:"branch"`
	Version                string               `json:"version"`
	ActiveCommit           string               `json:"activeCommit"`
	RemoteCommit           *string              `json:"remoteCommit"`
	RemoteVersion          *string              `json:"remoteVersion"`
	RemoteTag              *string              `json:"remoteTag"`
	ReleaseName            *string              `json:"releaseName"`
	ReleaseNotes           *string              `json:"releaseNotes"`
	ReleaseURL             *string              `json:"releaseUrl"`
	PublishedAtIso         *string              `json:"publishedAtIso"`
	AssetName              *string              `json:"assetName"`
	AssetSizeBytes         *int64               `json:"assetSizeBytes"`
	UpdateAvailable        bool                 `json:"updateAvailable"`
	AutoSyncEnabled        bool                 `json:"autoSyncEnabled"`
	IntervalSeconds        int                  `json:"intervalSeconds"`
	AutoRestartAfterUpdate bool                 `json:"autoRestartAfterUpdate"`
	DrainTimeoutSeconds    int                  `json:"drainTimeoutSeconds"`
	RestartScheduled       bool                 `json:"restartScheduled"`
	RestartProgress        *RestartProgress     `json:"restartProgress"`
	LastRestart            *LastRestart         `json:"lastRestart"`
	BootID                 string               `json:"bootId"`
	State                  string               `json:"state"`
	Progress               *Progress            `json:"progress"`
	ReloadCount            int                  `json:"reloadCount"`
	WebUIOverridden        bool                 `json:"webUiOverridden"`
	EdgeBinaryStaged       bool                 `json:"edgeBinaryStaged"`
	EdgeBinaryPath         *string              `json:"edgeBinaryPath"`
	GuestdUpdated          bool                 `json:"guestdUpdated"`
	GitHubTokenConfigured  bool                 `json:"githubTokenConfigured"`
	AllowReleaseApply      bool                 `json:"allowReleaseApply"`
	CanRollback            bool                 `json:"canRollback"`
	PreviousRelease        *PreviousReleaseInfo `json:"previousRelease"`
	Components             []ComponentStatus    `json:"components"`
	History                []HistoryEntry       `json:"history"`
	LastCheckedAtIso       *string              `json:"lastCheckedAtIso"`
	LastUpdatedAtIso       *string              `json:"lastUpdatedAtIso"`
	LastError              *string              `json:"lastError"`
}

// Manager polls or triggers repo-synced updates across stable and dev channels.
type Manager struct {
	cfg               config.Config
	sup               *supervisor.Supervisor
	logger            *log.Logger
	apiBaseURL        string
	allowCustomHost   bool
	baseVersion       string
	baseCommit        string
	edgeExePath       string
	onWebUIDir        func(string)
	getWebUIDir       func() string
	onGuestdBin       func(string)
	onPlanesRestarted func(context.Context)
	onEdgeRestart     func(string)
	validateEdgeBin   func(context.Context, string) error
	restartDelay      time.Duration
	httpClient        *http.Client
	repoDir           string
	configCh          chan struct{}

	restartMu        sync.Mutex
	restartTriggered bool

	// installExe is the externally installed edge binary a cold boot runs (carried in active.json).
	installExe string
	// bootMarker is the restart this boot completes, settled by CompleteBoot.
	bootMarker *RestartMarker
	// pendingRestart remembers the rollback plan of an applied update whose restart was left to
	// the operator (autoRestartAfterUpdate off), for TriggerRestart.
	pendingRestart *restartRequest

	syncMu sync.Mutex
	mu     sync.RWMutex
	status StatusSnapshot

	activeBundleDir string
	activeTag       string
	activeWebUIDir  string
	guestdBin       string
	baseline        *baselineSnapshot
	history         []HistoryEntry

	releasesMu      sync.Mutex
	cachedReleases  []ReleaseItem
	releasesFetched time.Time
}

// NewManager constructs an update Manager from runtime config and supervisor.
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

	defaultChannel := ChannelStable
	if strings.EqualFold(strings.TrimSpace(opts.Config.Mode), "dev") {
		defaultChannel = ChannelDev
	}
	autoSync := opts.Config.Mode == "dev" && opts.Config.DevSyncIntervalSec > 0
	intervalSec := opts.Config.DevSyncIntervalSec
	if intervalSec <= 0 {
		intervalSec = 3600
	}

	drainSec := opts.Config.DrainTimeoutSec
	if drainSec < config.MinDrainTimeoutSec || drainSec > config.MaxDrainTimeoutSec {
		drainSec = defaultDrainTimeoutSec
	}

	validateFn := opts.ValidateEdgeBin
	if validateFn == nil && opts.OnEdgeRestart != nil {
		validateFn = validateEdgeBinary
	}
	bootID := fmt.Sprintf("boot-%d-%d", os.Getpid(), time.Now().UnixNano())

	m := &Manager{
		cfg:               opts.Config,
		sup:               opts.Supervisor,
		logger:            logger,
		apiBaseURL:        apiBase,
		allowCustomHost:   opts.AllowCustomHost,
		baseVersion:       version,
		baseCommit:        commit,
		edgeExePath:       strings.TrimSpace(opts.EdgeExecutablePath),
		onWebUIDir:        opts.OnWebUIDir,
		getWebUIDir:       opts.GetWebUIDir,
		onGuestdBin:       opts.OnGuestdBin,
		onPlanesRestarted: opts.OnPlanesRestarted,
		onEdgeRestart:     opts.OnEdgeRestart,
		validateEdgeBin:   validateFn,
		restartDelay:      opts.RestartDelay,
		repoDir:           repoDir,
		activeWebUIDir:    strings.TrimSpace(opts.Config.WebUIDir),
		guestdBin:         strings.TrimSpace(opts.Config.GuestdBin),
		configCh:          make(chan struct{}, 1),
		status: StatusSnapshot{
			Mode:                   opts.Config.Mode,
			Channel:                defaultChannel,
			Standalone:             false,
			Strategy:               opts.Config.DevSyncMode,
			ResolvedStrategy:       resolved,
			Repo:                   opts.Config.UpdateRepo,
			Branch:                 opts.Config.UpdateBranch,
			Version:                version,
			ActiveCommit:           commit,
			AutoSyncEnabled:        autoSync,
			IntervalSeconds:        opts.Config.DevSyncIntervalSec,
			AutoRestartAfterUpdate: opts.Config.AutoRestartAfterUpdate,
			DrainTimeoutSeconds:    drainSec,
			BootID:                 bootID,
			State:                  StateIdle,
			WebUIOverridden:        opts.Config.WebUIDir != "",
			GitHubTokenConfigured:  strings.TrimSpace(opts.Config.GitHubToken) != "",
			AllowReleaseApply:      true,
		},
	}

	m.httpClient = &http.Client{
		Timeout: 3 * time.Minute,
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

	m.loadPersistedState()
	if m.status.IntervalSeconds <= 0 && !autoSync {
		m.status.IntervalSeconds = intervalSec
	}

	return m
}

// StartAutoSync starts the background check/sync loop and reacts dynamically to runtime config updates.
func (m *Manager) StartAutoSync(ctx context.Context) {
	go func() {
		// Brief startup delay before the first automatic check when enabled at boot.
		m.mu.RLock()
		initialEnabled := m.status.AutoSyncEnabled && m.status.IntervalSeconds > 0
		m.mu.RUnlock()

		if initialEnabled {
			initialTimer := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
				initialTimer.Stop()
				return
			case <-m.configCh:
				initialTimer.Stop()
			case <-initialTimer.C:
				m.runAutoSyncCycle(ctx)
			}
		}

		for {
			m.mu.RLock()
			enabled := m.status.AutoSyncEnabled
			intervalSec := m.status.IntervalSeconds
			m.mu.RUnlock()

			if !enabled || intervalSec <= 0 {
				select {
				case <-ctx.Done():
					return
				case <-m.configCh:
					continue
				}
			}

			timer := time.NewTimer(time.Duration(intervalSec) * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-m.configCh:
				timer.Stop()
				continue
			case <-timer.C:
				m.runAutoSyncCycle(ctx)
			}
		}
	}()
}

func (m *Manager) runAutoSyncCycle(ctx context.Context) {
	m.mu.RLock()
	mode := m.cfg.Mode
	channel := m.status.Channel
	m.mu.RUnlock()

	// Dev mode auto-applies updates automatically; release mode only auto-checks so upgrades remain explicit & step-up gated.
	checkOnly := !strings.EqualFold(mode, "dev") || channel == ChannelStable
	if _, err := m.SyncWithOptions(ctx, SyncOptions{
		CheckOnly:         checkOnly,
		AsyncRestart:      false,
		AllowReleaseApply: false,
	}); err != nil && !errors.Is(err, ErrUpdateBusy) {
		m.logger.Printf("[hotupdate] auto-sync cycle failed: %v", err)
	}
}

// Status returns a thread-safe copy of the current update state, including component snapshots and history.
func (m *Manager) Status() StatusSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshotLocked()
}

// Sync checks the configured repository for updates and applies them if checkOnly is false.
// Legacy direct Sync calls remain blocked in release mode unless SyncWithOptions sets AllowReleaseApply=true.
func (m *Manager) Sync(ctx context.Context, checkOnly bool, asyncRestart bool) (StatusSnapshot, error) {
	return m.SyncWithOptions(ctx, SyncOptions{
		CheckOnly:         checkOnly,
		AsyncRestart:      asyncRestart,
		AllowReleaseApply: false,
	})
}

// SyncWithOptions executes a repository check or release/git update with channel, tag, and step-up approval options.
func (m *Manager) SyncWithOptions(ctx context.Context, opts SyncOptions) (StatusSnapshot, error) {
	if !opts.CheckOnly && !strings.EqualFold(strings.TrimSpace(m.cfg.Mode), "dev") && !opts.AllowReleaseApply {
		return m.Status(), errors.New("hotupdate: binary apply is disabled outside dev mode (SLIPGATE_MODE=dev required)")
	}
	if !m.syncMu.TryLock() {
		return m.Status(), ErrUpdateBusy
	}
	defer m.syncMu.Unlock()

	if opts.Channel != "" && opts.Channel != ChannelStable && opts.Channel != ChannelDev {
		return m.Status(), fmt.Errorf("%w: unsupported channel %q", ErrInvalidUpdateConfig, opts.Channel)
	}

	m.mu.Lock()
	channel := m.status.Channel
	if opts.Channel != "" {
		channel = opts.Channel
	}
	strategy := m.cfg.DevSyncMode
	resolved := resolveStrategy(strategy, m.repoDir)
	if opts.TargetTag != "" || (m.cfg.Mode != "dev" && strategy == "auto") {
		resolved = "release"
	}
	now := isoNow()
	m.status.LastCheckedAtIso = &now
	m.status.ResolvedStrategy = resolved
	m.status.Progress = nil
	m.mu.Unlock()

	m.setState(StateChecking, nil)

	var err error
	if resolved == "git" {
		err = m.syncGit(ctx, opts.CheckOnly, opts.AsyncRestart, channel)
	} else {
		err = m.syncRelease(ctx, opts, channel)
	}

	m.mu.Lock()
	m.status.Progress = nil
	m.mu.Unlock()

	if err != nil {
		msg := err.Error()
		m.setState(StateError, &msg)
		return m.Status(), err
	}

	if m.isRestartScheduled() {
		m.setState(StateRestarting, nil)
	} else {
		m.setState(StateIdle, nil)
	}
	return m.Status(), nil
}

func (m *Manager) isRestartScheduled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status.RestartScheduled
}

func (m *Manager) currentExePath() string {
	if m.edgeExePath != "" {
		return m.edgeExePath
	}
	return ResolvedCurrentExecutable()
}

// restartRequest describes a full-service restart: the edge drains, stops every plane and
// re-execs Target, which starts the planes of the active release again.
type restartRequest struct {
	Target      string
	Async       bool
	Reason      string
	FromVersion string
	FromCommit  string
	ToVersion   string
	ToCommit    string
	Rollback    *RollbackPlan
}

func restartReasonFor(action string) string {
	if action == "rollback" {
		return RestartReasonRollback
	}
	return RestartReasonUpdate
}

// triggerEdgeRestart writes the restart marker (so the successor can confirm health or roll
// back) and invokes OnEdgeRestart once after a short delay that lets the HTTP response which
// requested the restart reach the browser.
func (m *Manager) triggerEdgeRestart(req restartRequest) {
	if strings.TrimSpace(req.Target) == "" {
		return
	}
	m.restartMu.Lock()
	if m.restartTriggered || m.onEdgeRestart == nil {
		m.restartMu.Unlock()
		return
	}
	m.restartTriggered = true
	delay := m.restartDelay
	cb := m.onEdgeRestart
	m.restartMu.Unlock()

	m.mu.Lock()
	reason := nonEmptyOr(req.Reason, RestartReasonManual)
	marker := &RestartMarker{
		ID:          fmt.Sprintf("rst-%d", time.Now().UnixNano()),
		Reason:      reason,
		Target:      req.Target,
		FromVersion: nonEmptyOr(req.FromVersion, m.status.Version),
		FromCommit:  nonEmptyOr(req.FromCommit, m.status.ActiveCommit),
		ToVersion:   nonEmptyOr(req.ToVersion, m.status.Version),
		ToCommit:    nonEmptyOr(req.ToCommit, m.status.ActiveCommit),
		FromBootID:  m.status.BootID,
		RequestedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Rollback:    req.Rollback,
	}
	m.status.RestartScheduled = true
	m.status.State = StateRestarting
	m.status.LastError = nil
	m.status.RestartProgress = &RestartProgress{
		Phase:        RestartPhaseScheduled,
		Reason:       reason,
		StartedAtIso: isoNow(),
	}
	m.pendingRestart = nil
	m.mu.Unlock()

	if err := saveRestartMarker(m.cfg.HotUpdateDir, marker); err != nil {
		m.logger.Printf("[hotupdate] warning: persist restart marker: %v (restart continues without boot guard)", err)
	}
	m.logger.Printf("[hotupdate] full-service restart scheduled (%s): %s -> %s via %s",
		reason, marker.FromVersion, marker.ToVersion, req.Target)

	if delay <= 0 {
		if req.Async {
			delay = 600 * time.Millisecond
		} else {
			delay = 150 * time.Millisecond
		}
	}
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		<-timer.C
		cb(req.Target)
	}()
}

func (m *Manager) syncGit(ctx context.Context, checkOnly bool, asyncRestart bool, channel string) error {
	if m.repoDir == "" {
		return errors.New("hotupdate: git strategy selected but repository directory was not found")
	}

	m.mu.RLock()
	branch := m.cfg.UpdateBranch
	hotDir := m.cfg.HotUpdateDir
	curVersion := m.status.Version
	curCommit := m.status.ActiveCommit
	m.mu.RUnlock()

	if _, err := runCmd(ctx, m.repoDir, "git", "fetch", "origin", branch, "--quiet"); err != nil {
		return fmt.Errorf("git fetch origin %s: %w", branch, err)
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

	m.setState(StateDownloading, nil)
	if _, err := runCmd(ctx, m.repoDir, "git", "pull", "--ff-only", "origin", branch); err != nil {
		return fmt.Errorf("git pull --ff-only: %w", err)
	}

	m.setState(StateApplying, nil)
	ext := exeExt()
	stageDir := filepath.Join(hotDir, "git-builds", remoteCommit[:min(12, len(remoteCommit))])
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

	if _, err := exec.LookPath("go"); err == nil {
		goDir := filepath.Join(m.repoDir, "services", "net-go")
		edgeOut := filepath.Join(stageDir, "slipgate"+ext)
		ldflags := fmt.Sprintf("-s -w -X main.version=%s -X main.commit=%s", curVersion, remoteCommit)
		if _, err := runCmd(ctx, goDir, "go", "build", "-trimpath", "-ldflags", ldflags, "-o", edgeOut, "./cmd/slipgate"); err != nil {
			return fmt.Errorf("rebuild slipgate: %w", err)
		}
	}

	_, err = m.applyExtractedBundle(ctx, applyBundleRequest{
		BundleRoot:   stageDir,
		NewCommit:    remoteCommit,
		NewVersion:   curVersion,
		Tag:          branch,
		Channel:      channel,
		Strategy:     "git",
		Action:       "apply",
		AsyncRestart: asyncRestart,
		FromVersion:  curVersion,
		FromCommit:   curCommit,
	})
	return err
}

func (m *Manager) setState(state string, lastErr *string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.State = state
	m.status.LastError = lastErr
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

func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
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
		return copyFile(path, target, 0o644)
	})
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

func shortCommitLabel(commit string) string {
	trimmed := strings.TrimSpace(commit)
	if len(trimmed) > 12 {
		return trimmed[:12]
	}
	return trimmed
}
