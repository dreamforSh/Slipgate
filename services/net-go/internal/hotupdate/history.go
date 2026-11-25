package hotupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
)

type persistedConfig struct {
	Channel                string `json:"channel"`
	AutoSyncEnabled        bool   `json:"autoSyncEnabled"`
	IntervalSeconds        int    `json:"intervalSeconds"`
	AutoRestartAfterUpdate *bool  `json:"autoRestartAfterUpdate,omitempty"`
	DrainTimeoutSeconds    int    `json:"drainTimeoutSeconds,omitempty"`
	Strategy               string `json:"strategy"`
}

type baselineSnapshot struct {
	Version    string `json:"version"`
	Commit     string `json:"commit"`
	Tag        string `json:"tag,omitempty"`
	EdgeBin    string `json:"edgeBin,omitempty"`
	CoreBin    string `json:"coreBin,omitempty"`
	BFFBin     string `json:"bffBin,omitempty"`
	WebUIDir   string `json:"webUiDir,omitempty"`
	GuestdBin  string `json:"guestdBin,omitempty"`
	CapturedAt string `json:"capturedAt"`
}

type persistedHistory struct {
	Baseline *baselineSnapshot `json:"baseline,omitempty"`
	Entries  []HistoryEntry    `json:"entries"`
}

type applyBundleRequest struct {
	BundleRoot   string
	NewCommit    string
	NewVersion   string
	Tag          string
	Channel      string
	Strategy     string
	Action       string
	AsyncRestart bool
	FromVersion  string
	FromCommit   string
}

type rollbackPlaneSnapshot struct {
	PrevCoreBin    string
	HasCore        bool
	PrevBFFBin     string
	HasBFF         bool
	PrevWebUIDir   string
	PrevGuestdBin  string
	GuestdSwitched bool
}

func (m *Manager) loadPersistedState() {
	if m.cfg.HotUpdateDir == "" {
		return
	}

	cfgPath := filepath.Join(m.cfg.HotUpdateDir, "config.json")
	if raw, err := os.ReadFile(cfgPath); err == nil {
		var pc persistedConfig
		if json.Unmarshal(raw, &pc) == nil {
			if pc.Channel == ChannelStable || pc.Channel == ChannelDev {
				m.status.Channel = pc.Channel
			}
			if pc.Strategy == "auto" || pc.Strategy == "release" || pc.Strategy == "git" {
				m.cfg.DevSyncMode = pc.Strategy
				m.status.Strategy = pc.Strategy
				m.status.ResolvedStrategy = resolveStrategy(pc.Strategy, m.repoDir)
			}
			if pc.IntervalSeconds >= 30 && pc.IntervalSeconds <= 86400 {
				m.cfg.DevSyncIntervalSec = pc.IntervalSeconds
				m.status.IntervalSeconds = pc.IntervalSeconds
			}
			m.status.AutoSyncEnabled = pc.AutoSyncEnabled
			if pc.AutoRestartAfterUpdate != nil {
				m.status.AutoRestartAfterUpdate = *pc.AutoRestartAfterUpdate
			}
			if pc.DrainTimeoutSeconds >= config.MinDrainTimeoutSec && pc.DrainTimeoutSeconds <= config.MaxDrainTimeoutSec {
				m.status.DrainTimeoutSeconds = pc.DrainTimeoutSeconds
			}
		}
	}

	if marker, ok := LoadRestartMarker(m.cfg.HotUpdateDir); ok {
		m.bootMarker = marker
	}
	m.status.LastRestart = loadLastRestart(m.cfg.HotUpdateDir)

	histPath := filepath.Join(m.cfg.HotUpdateDir, "history.json")
	if raw, err := os.ReadFile(histPath); err == nil {
		var ph persistedHistory
		if json.Unmarshal(raw, &ph) == nil {
			m.baseline = ph.Baseline
			m.history = ph.Entries
		}
	}

	m.bootActiveStamp = activeReleaseStamp(m.cfg.HotUpdateDir)
	active, hasActive := LoadActiveRelease(m.cfg.HotUpdateDir)
	if hasActive && strings.TrimSpace(active.InstallExe) != "" {
		m.installExe = active.InstallExe
	} else if !hasActive {
		// No hot-update release is active, so this process is the installed binary.
		m.installExe = m.currentExePath()
	}
	if hasActive {
		validBundle := bundleDirExists(active.BundleDir)
		if validBundle || active.Version != "" || active.Commit != "" {
			if strings.TrimSpace(active.Version) != "" {
				m.status.Version = active.Version
			}
			if strings.TrimSpace(active.Commit) != "" {
				m.status.ActiveCommit = active.Commit
			}
			if validBundle {
				m.activeBundleDir = active.BundleDir
			}
			m.activeTag = active.Tag
			if active.WebUIDir != "" {
				if info, err := os.Stat(filepath.Join(active.WebUIDir, "index.html")); err == nil && !info.IsDir() {
					m.activeWebUIDir = active.WebUIDir
					m.status.WebUIOverridden = true
				}
			}
			if active.GuestdBin != "" {
				if info, err := os.Stat(active.GuestdBin); err == nil && !info.IsDir() {
					m.guestdBin = active.GuestdBin
					m.status.GuestdUpdated = true
				}
			}
			if active.EdgeBin != "" {
				samePath := SameExecutablePath(m.currentExePath(), active.EdgeBin)
				sameBaseCommit := active.Commit != "" && commitsEqual(m.baseCommit, active.Commit)
				if samePath || sameBaseCommit {
					m.status.EdgeBinaryStaged = false
					m.status.EdgeBinaryPath = nil
				} else if info, err := os.Stat(active.EdgeBin); err == nil && !info.IsDir() {
					p := active.EdgeBin
					m.status.EdgeBinaryStaged = true
					m.status.EdgeBinaryPath = &p
				}
			}
		}
	}
}

func (m *Manager) savePersistedConfigLocked() error {
	if m.cfg.HotUpdateDir == "" {
		return nil
	}
	autoRestart := m.status.AutoRestartAfterUpdate
	payload := persistedConfig{
		Channel:                m.status.Channel,
		AutoSyncEnabled:        m.status.AutoSyncEnabled,
		IntervalSeconds:        m.status.IntervalSeconds,
		AutoRestartAfterUpdate: &autoRestart,
		DrainTimeoutSeconds:    m.status.DrainTimeoutSeconds,
		Strategy:               m.cfg.DevSyncMode,
	}
	return writeJSONAtomic(filepath.Join(m.cfg.HotUpdateDir, "config.json"), payload)
}

func (m *Manager) savePersistedHistoryLocked() error {
	if m.cfg.HotUpdateDir == "" {
		return nil
	}
	payload := persistedHistory{
		Baseline: m.baseline,
		Entries:  m.history,
	}
	return writeJSONAtomic(filepath.Join(m.cfg.HotUpdateDir, "history.json"), payload)
}

func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// UpdateConfig validates, applies, and persists runtime update channel/scheduling configuration.
func (m *Manager) UpdateConfig(patch ConfigPatch) (StatusSnapshot, error) {
	m.mu.Lock()

	nextChannel := m.status.Channel
	nextAutoSync := m.status.AutoSyncEnabled
	nextInterval := m.status.IntervalSeconds
	nextAutoRestart := m.status.AutoRestartAfterUpdate
	nextDrain := m.status.DrainTimeoutSeconds
	nextStrategy := m.cfg.DevSyncMode

	if patch.Channel != nil {
		ch := strings.ToLower(strings.TrimSpace(*patch.Channel))
		if ch != ChannelStable && ch != ChannelDev {
			m.mu.Unlock()
			return m.Status(), fmt.Errorf("%w: invalid channel %q", ErrInvalidUpdateConfig, ch)
		}
		nextChannel = ch
	}
	if patch.AutoSyncEnabled != nil {
		nextAutoSync = *patch.AutoSyncEnabled
	}
	if patch.IntervalSeconds != nil {
		sec := *patch.IntervalSeconds
		if sec < 30 || sec > 86400 {
			m.mu.Unlock()
			return m.Status(), fmt.Errorf("%w: intervalSeconds must be between 30 and 86400", ErrInvalidUpdateConfig)
		}
		nextInterval = sec
	}
	if patch.AutoRestartAfterUpdate != nil {
		nextAutoRestart = *patch.AutoRestartAfterUpdate
	}
	if patch.DrainTimeoutSeconds != nil {
		sec := *patch.DrainTimeoutSeconds
		if sec < config.MinDrainTimeoutSec || sec > config.MaxDrainTimeoutSec {
			m.mu.Unlock()
			return m.Status(), fmt.Errorf("%w: drainTimeoutSeconds must be between %d and %d",
				ErrInvalidUpdateConfig, config.MinDrainTimeoutSec, config.MaxDrainTimeoutSec)
		}
		nextDrain = sec
	}
	if patch.Strategy != nil {
		st := strings.ToLower(strings.TrimSpace(*patch.Strategy))
		if st != "auto" && st != "release" && st != "git" {
			m.mu.Unlock()
			return m.Status(), fmt.Errorf("%w: invalid strategy %q", ErrInvalidUpdateConfig, st)
		}
		if st == "git" && st != m.cfg.DevSyncMode && !m.status.GitAvailable {
			m.mu.Unlock()
			return m.Status(), fmt.Errorf("%w: the git strategy needs a source checkout and git on this host", ErrInvalidUpdateConfig)
		}
		nextStrategy = st
	}

	if nextInterval <= 0 {
		nextInterval = 60
	}

	channelChanged := nextChannel != m.status.Channel
	m.status.Channel = nextChannel
	m.status.AutoSyncEnabled = nextAutoSync
	m.status.IntervalSeconds = nextInterval
	m.status.AutoRestartAfterUpdate = nextAutoRestart
	m.status.DrainTimeoutSeconds = nextDrain
	m.cfg.DrainTimeoutSec = nextDrain
	m.cfg.DevSyncIntervalSec = nextInterval
	m.cfg.DevSyncMode = nextStrategy
	m.cfg.AutoRestartAfterUpdate = nextAutoRestart
	m.status.Strategy = nextStrategy
	m.status.ResolvedStrategy = resolveStrategy(nextStrategy, m.repoDir)
	if channelChanged {
		m.status.UpdateAvailable = false
		m.status.RemoteVersion = nil
		m.status.RemoteTag = nil
		m.status.RemoteCommit = nil
		m.status.ReleaseName = nil
		m.status.ReleaseNotes = nil
		m.status.ReleaseURL = nil
		m.status.PublishedAtIso = nil
		m.status.AssetName = nil
		m.status.AssetSizeBytes = nil
	}

	err := m.savePersistedConfigLocked()
	snap := m.snapshotLocked()
	m.mu.Unlock()

	if err != nil {
		return snap, fmt.Errorf("persist update config: %w", err)
	}

	select {
	case m.configCh <- struct{}{}:
	default:
	}

	return snap, nil
}

func (m *Manager) captureBaselineLocked() {
	if m.baseline != nil {
		return
	}
	snap := &baselineSnapshot{
		Version:    m.status.Version,
		Commit:     m.status.ActiveCommit,
		Tag:        m.activeTag,
		WebUIDir:   m.currentWebUIDirLocked(),
		GuestdBin:  m.guestdBin,
		CapturedAt: isoNow(),
	}
	if m.onEdgeRestart != nil {
		if edgeBak, err := backupBaselineEdge(m.cfg.HotUpdateDir, m.currentExePath()); err == nil && edgeBak != "" {
			snap.EdgeBin = edgeBak
		}
	}
	if m.sup != nil {
		if bin, ok := m.sup.ChildBinary("core"); ok {
			snap.CoreBin = bin
		}
		if bin, ok := m.sup.ChildBinary("bff"); ok {
			snap.BFFBin = bin
		}
	}
	m.baseline = snap
}

func (m *Manager) applyExtractedBundle(ctx context.Context, req applyBundleRequest) (bool, error) {
	prevActive, _ := LoadActiveRelease(m.cfg.HotUpdateDir)

	m.mu.Lock()
	m.captureBaselineLocked()
	prevSnap := m.planeSnapshotLocked()
	autoRestartEnabled := m.status.AutoRestartAfterUpdate
	plan := m.rollbackPlanLocked(prevActive)
	installExe := m.installExeLocked(prevActive)
	m.mu.Unlock()

	ext := exeExt()
	coreBin := filepath.Join(req.BundleRoot, "slipgate-core"+ext)
	bffBin := filepath.Join(req.BundleRoot, "slipgate-bff"+ext)
	edgeBin := filepath.Join(req.BundleRoot, "slipgate"+ext)
	guestdBin := filepath.Join(req.BundleRoot, "slipgate-guestd"+ext)

	// The new edge stays inside its (persistent) bundle directory and is started through the
	// active.json handoff; the installed binary is never overwritten, so the previous release
	// and the baseline remain bootable for rollback.
	edgeStaged := false
	var edgeStagedPtr *string
	newEdge := ""
	if info, err := os.Stat(edgeBin); err == nil && !info.IsDir() {
		if err := validateStagedEdgeBinary(ctx, edgeBin, m.validateEdgeBin); err != nil {
			return false, err
		}
		edgeStaged = true
		p := edgeBin
		edgeStagedPtr = &p
		newEdge = edgeBin
	}

	webDir := filepath.Join(req.BundleRoot, "webui")
	webOverridden := false
	if info, err := os.Stat(filepath.Join(webDir, "index.html")); err == nil && !info.IsDir() {
		webOverridden = true
	}

	// guestd also runs from the bundle directory, so every release keeps its own copy and a
	// rollback really restores the previous one.
	guestdUpdated := false
	if info, err := os.Stat(guestdBin); err == nil && !info.IsDir() {
		_ = os.Chmod(guestdBin, 0o755)
		guestdUpdated = true
	}

	activeCoreBin := prevSnap.PrevCoreBin
	coreChanged := false
	if info, err := os.Stat(coreBin); err == nil && !info.IsDir() {
		_ = os.Chmod(coreBin, 0o755)
		activeCoreBin = coreBin
		coreChanged = true
	}
	activeBFFBin := prevSnap.PrevBFFBin
	bffChanged := false
	if info, err := os.Stat(bffBin); err == nil && !info.IsDir() {
		_ = os.Chmod(bffBin, 0o755)
		activeBFFBin = bffBin
		bffChanged = true
	}
	activeWebDir := prevSnap.PrevWebUIDir
	if webOverridden {
		activeWebDir = webDir
	} else if req.Action == "rollback" && req.BundleRoot == "" {
		activeWebDir = ""
	}
	activeGuestd := prevSnap.PrevGuestdBin
	if guestdUpdated {
		activeGuestd = guestdBin
	}
	// A bundle without an edge binary keeps whichever edge the previous release ran.
	activeEdge := newEdge
	if activeEdge == "" && prevActive != nil {
		activeEdge = prevActive.EdgeBin
	}
	// BaseVersion/BaseCommit describe the installed binary (not the hot-updated edge running
	// now), so carry them forward: startup compares them to detect an external upgrade.
	baseVersion, baseCommit := m.baseVersion, m.baseCommit
	if prevActive != nil && strings.TrimSpace(prevActive.BaseCommit) != "" {
		baseVersion, baseCommit = prevActive.BaseVersion, prevActive.BaseCommit
	}
	active := &ActiveRelease{
		Version:            req.NewVersion,
		Commit:             req.NewCommit,
		Tag:                req.Tag,
		BaseVersion:        baseVersion,
		BaseCommit:         baseCommit,
		InstallExe:         installExe,
		InstallFingerprint: installFingerprintFor(prevActive, installExe, m.currentExePath()),
		BundleDir:          req.BundleRoot,
		EdgeBin:            activeEdge,
		CoreBin:            activeCoreBin,
		BFFBin:             activeBFFBin,
		GuestdBin:          activeGuestd,
		WebUIDir:           activeWebDir,
		UpdatedAt:          isoNow(),
	}

	// Any changed binary means a full-service restart (edge re-exec + every supervised plane)
	// when automatic restarts are on; a web-UI-only bundle is swapped live.
	binariesChanged := newEdge != "" || coreChanged || bffChanged || guestdUpdated
	fullRestart := m.onEdgeRestart != nil && autoRestartEnabled && binariesChanged
	restartTarget := newEdge
	if restartTarget == "" {
		restartTarget = m.currentExePath()
	}
	restart := restartRequest{
		Target:      restartTarget,
		Async:       req.AsyncRestart,
		Reason:      restartReasonFor(req.Action),
		FromVersion: req.FromVersion,
		FromCommit:  req.FromCommit,
		ToVersion:   req.NewVersion,
		ToCommit:    req.NewCommit,
		Rollback:    plan,
	}

	// record publishes the applied release in the status and history once it is in effect.
	record := func(reloaded bool) {
		updatedAt := isoNow()
		m.mu.Lock()
		defer m.mu.Unlock()
		m.status.ActiveCommit = req.NewCommit
		if req.NewVersion != "" {
			m.status.Version = req.NewVersion
		}
		rc := req.NewCommit
		m.status.RemoteCommit = &rc
		m.status.UpdateAvailable = false
		if webOverridden {
			m.activeWebUIDir = webDir
			m.status.WebUIOverridden = true
		} else if req.Action == "rollback" && req.BundleRoot == "" {
			m.activeWebUIDir = ""
			m.status.WebUIOverridden = false
		}
		m.status.EdgeBinaryStaged = edgeStaged
		m.status.EdgeBinaryPath = edgeStagedPtr
		if guestdUpdated {
			m.guestdBin = guestdBin
			m.status.GuestdUpdated = true
		}
		m.status.LastUpdatedAtIso = &updatedAt
		if reloaded || webOverridden {
			m.status.ReloadCount++
		}
		if fullRestart {
			m.status.RestartScheduled = true
			m.status.State = StateRestarting
			m.status.LastError = nil
		} else if edgeStaged {
			pending := restart
			m.pendingRestart = &pending
		}
		m.activeBundleDir = req.BundleRoot
		m.activeTag = req.Tag
		m.appendHistoryLocked(buildHistoryEntry(req))
		_ = m.savePersistedHistoryLocked()
	}

	if fullRestart {
		// The restarted edge starts every plane (and the web UI) from active.json.
		if err := saveActiveRelease(m.cfg.HotUpdateDir, active); err != nil {
			return false, fmt.Errorf("persist active release: %w", err)
		}
		record(true)
		m.triggerEdgeRestart(restart)
		return true, nil
	}

	// No full restart: the web UI and guestd switch live, changed planes restart below, and
	// active.json / history are written only once the new planes are actually running.
	if webOverridden && m.onWebUIDir != nil {
		m.onWebUIDir(webDir)
	}
	if guestdUpdated && m.onGuestdBin != nil {
		m.onGuestdBin(guestdBin)
		prevSnap.GuestdSwitched = true
	}
	planesChanged := false
	if m.sup != nil {
		if coreChanged && m.sup.UpdateChildBinary("core", coreBin) == nil {
			planesChanged = true
		}
		if bffChanged && m.sup.UpdateChildBinary("bff", bffBin) == nil {
			planesChanged = true
		}
	}
	finish := func() error {
		if err := saveActiveRelease(m.cfg.HotUpdateDir, active); err != nil {
			return fmt.Errorf("persist active release: %w", err)
		}
		record(planesChanged)
		m.notifyBuildInfo(req.NewVersion, req.NewCommit)
		return nil
	}
	if !planesChanged {
		if err := finish(); err != nil {
			m.restorePlaneSnapshot(prevSnap)
			return false, err
		}
		return true, nil
	}
	if err := m.reloadPlanes(ctx, req.AsyncRestart, req.BundleRoot, prevSnap, finish, func(err error) {
		m.recordFailedApply(req, err)
	}); err != nil {
		return false, err
	}
	return true, nil
}

// planeSnapshotLocked captures what restorePlaneSnapshot puts back if a plane reload fails.
func (m *Manager) planeSnapshotLocked() rollbackPlaneSnapshot {
	snap := rollbackPlaneSnapshot{
		PrevWebUIDir:  m.currentWebUIDirLocked(),
		PrevGuestdBin: m.guestdBin,
	}
	if m.sup != nil {
		snap.PrevCoreBin, snap.HasCore = m.sup.ChildBinary("core")
		snap.PrevBFFBin, snap.HasBFF = m.sup.ChildBinary("bff")
	}
	return snap
}

// reloadPlanes restarts the supervised planes (already pointed at their new binaries) and runs
// finish once they are up, so active.json and the history only ever record a release whose
// planes actually started; on failure the previous binaries are restored and restarted. With
// async the restart begins after a short delay, because the request that asked for it travels
// through slipgate-bff, which is about to be restarted: failures are then reported through fail.
func (m *Manager) reloadPlanes(
	ctx context.Context,
	async bool,
	bundleDir string,
	prev rollbackPlaneSnapshot,
	finish func() error,
	fail func(error),
) error {
	run := func(runCtx context.Context) error {
		err := m.sup.RestartAll(runCtx, 5*time.Second)
		if err == nil {
			if m.onPlanesRestarted != nil {
				m.onPlanesRestarted(runCtx)
			}
			if err = finish(); err == nil {
				return nil
			}
		}
		m.restorePlaneSnapshot(prev)
		if rbErr := m.sup.RestartAll(context.Background(), 5*time.Second); rbErr != nil {
			m.logger.Printf("[hotupdate] restarting the previous planes failed: %v", rbErr)
		} else if m.onPlanesRestarted != nil {
			m.onPlanesRestarted(context.Background())
		}
		return fmt.Errorf("restart supervised planes (rolled back to the previous binaries): %w", err)
	}
	if !async {
		m.setState(StateReloadingPlanes, nil)
		return run(ctx)
	}

	m.mu.Lock()
	m.pendingPlaneBundle = bundleDir
	m.status.State = StateReloadingPlanes
	m.status.LastError = nil
	m.mu.Unlock()
	time.AfterFunc(150*time.Millisecond, func() {
		// No other update may start while the planes are being swapped.
		m.syncMu.Lock()
		defer m.syncMu.Unlock()
		err := run(context.Background())
		m.mu.Lock()
		m.pendingPlaneBundle = ""
		switch {
		case err != nil:
			msg := err.Error()
			m.status.State = StateError
			m.status.LastError = &msg
		case m.status.RestartScheduled:
			m.status.State = StateRestarting
		default:
			m.status.State = StateIdle
		}
		m.mu.Unlock()
		if err != nil {
			m.logger.Printf("[hotupdate] %v", err)
			if fail != nil {
				fail(err)
			}
		}
	})
	return nil
}

// recordFailedApply adds a failed history entry for an update or rollback whose planes never
// came up (the active release is unchanged).
func (m *Manager) recordFailedApply(req applyBundleRequest, err error) {
	entry := buildHistoryEntry(req)
	entry.Succeeded = false
	msg := err.Error()
	entry.Error = &msg
	m.mu.Lock()
	m.appendHistoryLocked(entry)
	_ = m.savePersistedHistoryLocked()
	m.mu.Unlock()
}

// notifyBuildInfo reports the release now in effect without an edge restart (health endpoints).
func (m *Manager) notifyBuildInfo(version, commit string) {
	if m.onBuildInfo != nil {
		m.onBuildInfo(version, commit)
	}
}

// finishOperationState sets the state once an update, rollback or restart request returns.
func (m *Manager) finishOperationState() {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.status.RestartScheduled:
		m.status.State = StateRestarting
	case m.pendingPlaneBundle != "":
		m.status.State = StateReloadingPlanes
	default:
		m.status.State = StateIdle
	}
	m.status.LastError = nil
}

func (m *Manager) restorePlaneSnapshot(snap rollbackPlaneSnapshot) {
	if m.onWebUIDir != nil {
		m.onWebUIDir(snap.PrevWebUIDir)
	}
	if snap.GuestdSwitched && m.onGuestdBin != nil {
		m.onGuestdBin(snap.PrevGuestdBin)
	}
	if m.sup != nil {
		if snap.HasCore {
			_ = m.sup.UpdateChildBinary("core", snap.PrevCoreBin)
		}
		if snap.HasBFF {
			_ = m.sup.UpdateChildBinary("bff", snap.PrevBFFBin)
		}
	}
}

func buildHistoryEntry(req applyBundleRequest) HistoryEntry {
	var tagPtr *string
	if strings.TrimSpace(req.Tag) != "" {
		t := strings.TrimSpace(req.Tag)
		tagPtr = &t
	}
	var dirPtr *string
	if strings.TrimSpace(req.BundleRoot) != "" {
		d := strings.TrimSpace(req.BundleRoot)
		dirPtr = &d
	}
	action := req.Action
	if action == "" {
		action = "apply"
	}
	return HistoryEntry{
		ID:           fmt.Sprintf("rel-%d", time.Now().UnixNano()),
		Action:       action,
		FromVersion:  req.FromVersion,
		ToVersion:    req.NewVersion,
		FromCommit:   req.FromCommit,
		ToCommit:     req.NewCommit,
		Tag:          tagPtr,
		Channel:      nonEmptyOr(req.Channel, ChannelStable),
		Strategy:     nonEmptyOr(req.Strategy, "release"),
		BundleDir:    dirPtr,
		Succeeded:    true,
		CreatedAtIso: isoNow(),
	}
}

func (m *Manager) appendHistoryLocked(entry HistoryEntry) {
	m.history = append([]HistoryEntry{entry}, m.history...)
	if len(m.history) > maxHistoryItems {
		m.history = m.history[:maxHistoryItems]
	}
}

// Rollback restores supervised children and web UI assets to a prior staged release or baseline.
func (m *Manager) Rollback(ctx context.Context, releaseID string, asyncRestart bool) (StatusSnapshot, error) {
	if !m.syncMu.TryLock() {
		return m.Status(), ErrUpdateBusy
	}
	defer m.syncMu.Unlock()

	m.mu.RLock()
	target, found := m.resolveRollbackTargetLocked(releaseID)
	curVersion := m.status.Version
	curCommit := m.status.ActiveCommit
	channel := m.status.Channel
	m.mu.RUnlock()

	if !found {
		return m.Status(), ErrRollbackUnavailable
	}

	m.setState(StateRollingBack, nil)

	var applyErr error
	if target.isBaseline && target.baseline != nil {
		applyErr = m.restoreBaseline(ctx, target.baseline, asyncRestart, curVersion, curCommit, channel)
	} else {
		_, applyErr = m.applyExtractedBundle(ctx, applyBundleRequest{
			BundleRoot:   target.bundleDir,
			NewCommit:    target.commit,
			NewVersion:   target.version,
			Tag:          target.tag,
			Channel:      nonEmptyOr(target.channel, channel),
			Strategy:     "release",
			Action:       "rollback",
			AsyncRestart: asyncRestart,
			FromVersion:  curVersion,
			FromCommit:   curCommit,
		})
	}

	if applyErr != nil {
		msg := applyErr.Error()
		m.setState(StateError, &msg)
		return m.Status(), applyErr
	}

	m.finishOperationState()
	return m.Status(), nil
}

func (m *Manager) restoreBaseline(
	ctx context.Context,
	base *baselineSnapshot,
	asyncRestart bool,
	fromVersion string,
	fromCommit string,
	channel string,
) error {
	prevActive, _ := LoadActiveRelease(m.cfg.HotUpdateDir)

	m.mu.RLock()
	autoRestartEnabled := m.status.AutoRestartAfterUpdate
	plan := m.rollbackPlanLocked(prevActive)
	installExe := m.installExeLocked(prevActive)
	prevSnap := m.planeSnapshotLocked()
	m.mu.RUnlock()

	// Prefer the installed binary itself (its siblings are the baseline planes); fall back to the
	// copy captured before the first update.
	var (
		edgeStaged    bool
		edgeStagedPtr *string
		restartTarget string
	)
	for _, candidate := range []string{installExe, base.EdgeBin} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err != nil || info.IsDir() {
			continue
		}
		if m.onEdgeRestart != nil || m.validateEdgeBin != nil {
			if err := validateStagedEdgeBinary(ctx, candidate, m.validateEdgeBin); err != nil {
				return err
			}
			restartTarget = candidate
			if !SameExecutablePath(candidate, m.currentExePath()) {
				edgeStaged = true
				p := candidate
				edgeStagedPtr = &p
			}
		}
		break
	}

	fullRestart := m.onEdgeRestart != nil && autoRestartEnabled && restartTarget != ""
	restart := restartRequest{
		Target:      restartTarget,
		Async:       asyncRestart,
		Reason:      RestartReasonRollback,
		FromVersion: fromVersion,
		FromCommit:  fromCommit,
		ToVersion:   base.Version,
		ToCommit:    base.Commit,
		Rollback:    plan,
	}
	historyReq := applyBundleRequest{
		NewCommit:   base.Commit,
		NewVersion:  base.Version,
		Tag:         base.Tag,
		Channel:     channel,
		Strategy:    "release",
		Action:      "rollback",
		FromVersion: fromVersion,
		FromCommit:  fromCommit,
	}
	record := func(reloaded bool) {
		updatedAt := isoNow()
		m.mu.Lock()
		defer m.mu.Unlock()
		m.status.Version = base.Version
		m.status.ActiveCommit = base.Commit
		m.status.WebUIOverridden = base.WebUIDir != ""
		m.status.EdgeBinaryStaged = edgeStaged
		m.status.EdgeBinaryPath = edgeStagedPtr
		m.status.GuestdUpdated = false
		m.status.UpdateAvailable = false
		m.status.LastUpdatedAtIso = &updatedAt
		m.activeWebUIDir = base.WebUIDir
		m.guestdBin = base.GuestdBin
		m.activeBundleDir = ""
		m.activeTag = base.Tag
		if reloaded {
			m.status.ReloadCount++
		}
		if fullRestart {
			m.status.RestartScheduled = true
			m.status.State = StateRestarting
			m.status.LastError = nil
		} else if edgeStaged {
			pending := restart
			m.pendingRestart = &pending
		}
		m.appendHistoryLocked(buildHistoryEntry(historyReq))
		_ = m.savePersistedHistoryLocked()
	}

	if fullRestart {
		if err := ClearActiveRelease(m.cfg.HotUpdateDir); err != nil {
			return fmt.Errorf("clear active release during baseline rollback: %w", err)
		}
		record(true)
		m.triggerEdgeRestart(restart)
		return nil
	}

	if m.onWebUIDir != nil {
		m.onWebUIDir(base.WebUIDir)
	}
	if base.GuestdBin != "" && m.onGuestdBin != nil {
		m.onGuestdBin(base.GuestdBin)
		prevSnap.GuestdSwitched = true
	}
	planesChanged := false
	if m.sup != nil {
		if base.CoreBin != "" && m.sup.UpdateChildBinary("core", base.CoreBin) == nil {
			planesChanged = true
		}
		if base.BFFBin != "" && m.sup.UpdateChildBinary("bff", base.BFFBin) == nil {
			planesChanged = true
		}
	}
	finish := func() error {
		if err := ClearActiveRelease(m.cfg.HotUpdateDir); err != nil {
			return fmt.Errorf("clear active release during baseline rollback: %w", err)
		}
		record(planesChanged)
		m.notifyBuildInfo(base.Version, base.Commit)
		return nil
	}
	if !planesChanged {
		if err := finish(); err != nil {
			m.restorePlaneSnapshot(prevSnap)
			return err
		}
		return nil
	}
	return m.reloadPlanes(ctx, asyncRestart, "baseline", prevSnap, finish, func(err error) {
		m.recordFailedApply(historyReq, err)
	})
}

// ResetBaseline forgets the captured baseline (history.json "baseline" and the backup edge in
// <HotUpdateDir>/baseline). It runs after an external upgrade: the baseline's plane paths now
// hold the new install's binaries, so restoring it would mix versions.
func ResetBaseline(hotUpdateDir string) error {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil
	}
	histPath := filepath.Join(hotUpdateDir, "history.json")
	if raw, err := os.ReadFile(histPath); err == nil {
		var ph persistedHistory
		if json.Unmarshal(raw, &ph) == nil && ph.Baseline != nil {
			ph.Baseline = nil
			if err := writeJSONAtomic(histPath, ph); err != nil {
				return err
			}
		}
	}
	return os.RemoveAll(filepath.Join(hotUpdateDir, "baseline"))
}

// TriggerRestart validates any staged edge binary (or the current executable) and schedules a
// graceful full-service restart: drain in-flight requests, stop every plane, re-exec the edge.
// A restart that activates a staged update keeps that update's rollback plan, so the boot guard
// can still undo it if the new version never becomes healthy.
func (m *Manager) TriggerRestart(ctx context.Context, async bool) (StatusSnapshot, error) {
	if m.onEdgeRestart == nil {
		return m.Status(), ErrRestartUnavailable
	}
	if !m.syncMu.TryLock() {
		return m.Status(), ErrUpdateBusy
	}
	defer m.syncMu.Unlock()

	m.mu.RLock()
	staged := m.status.EdgeBinaryStaged
	stagedPath := ""
	if m.status.EdgeBinaryPath != nil {
		stagedPath = strings.TrimSpace(*m.status.EdgeBinaryPath)
	}
	var pending *restartRequest
	if m.pendingRestart != nil {
		cp := *m.pendingRestart
		pending = &cp
	}
	m.mu.RUnlock()

	target := m.currentExePath()
	if staged && stagedPath != "" {
		if _, err := os.Stat(stagedPath); err != nil {
			return m.Status(), fmt.Errorf("hotupdate: staged edge binary unavailable: %w", err)
		}
		target = stagedPath
	}
	if target == "" {
		return m.Status(), ErrRestartUnavailable
	}
	if m.validateEdgeBin != nil {
		if err := m.validateEdgeBin(ctx, target); err != nil {
			return m.Status(), err
		}
	}

	req := restartRequest{Target: target, Async: async, Reason: RestartReasonManual}
	if pending != nil {
		req = *pending
		req.Target = target
		req.Async = async
	}
	m.triggerEdgeRestart(req)
	return m.Status(), nil
}

type rollbackTarget struct {
	id         string
	version    string
	commit     string
	tag        string
	channel    string
	bundleDir  string
	isBaseline bool
	baseline   *baselineSnapshot
}

func (m *Manager) resolveRollbackTargetLocked(releaseID string) (rollbackTarget, bool) {
	if releaseID == "baseline" && m.baseline != nil {
		if m.baselineWritableTargetOKLocked(m.baseline) {
			return rollbackTarget{
				id:         "baseline",
				version:    m.baseline.Version,
				commit:     m.baseline.Commit,
				tag:        m.baseline.Tag,
				isBaseline: true,
				baseline:   m.baseline,
			}, true
		}
		return rollbackTarget{}, false
	}

	if releaseID != "" {
		for _, entry := range m.history {
			if entry.ID != releaseID || !entry.Succeeded || entry.BundleDir == nil {
				continue
			}
			if bundleDirExists(*entry.BundleDir) {
				tag := ""
				if entry.Tag != nil {
					tag = *entry.Tag
				}
				return rollbackTarget{
					id:        entry.ID,
					version:   entry.ToVersion,
					commit:    entry.ToCommit,
					tag:       tag,
					channel:   entry.Channel,
					bundleDir: *entry.BundleDir,
				}, true
			}
		}
		return rollbackTarget{}, false
	}

	// Default automatic target: pick the newest succeeded entry whose bundleDir is still on disk
	// and differs from the active bundleDir; otherwise fall back to baseline.
	for _, entry := range m.history {
		if !entry.Succeeded || entry.BundleDir == nil {
			continue
		}
		if *entry.BundleDir == m.activeBundleDir && m.activeBundleDir != "" {
			continue
		}
		if bundleDirExists(*entry.BundleDir) {
			tag := ""
			if entry.Tag != nil {
				tag = *entry.Tag
			}
			return rollbackTarget{
				id:        entry.ID,
				version:   entry.ToVersion,
				commit:    entry.ToCommit,
				tag:       tag,
				channel:   entry.Channel,
				bundleDir: *entry.BundleDir,
			}, true
		}
	}

	if m.baseline != nil && m.baselineWritableTargetOKLocked(m.baseline) {
		sameAsCurrent := m.baseline.Version == m.status.Version && commitsEqual(m.baseline.Commit, m.status.ActiveCommit) && m.activeBundleDir == ""
		if !sameAsCurrent {
			return rollbackTarget{
				id:         "baseline",
				version:    m.baseline.Version,
				commit:     m.baseline.Commit,
				tag:        m.baseline.Tag,
				isBaseline: true,
				baseline:   m.baseline,
			}, true
		}
	}

	return rollbackTarget{}, false
}

func (m *Manager) baselineWritableTargetOKLocked(base *baselineSnapshot) bool {
	if base == nil {
		return false
	}
	if base.CoreBin != "" {
		if _, err := os.Stat(base.CoreBin); errors.Is(err, os.ErrNotExist) {
			return false
		}
	}
	if base.BFFBin != "" {
		if _, err := os.Stat(base.BFFBin); errors.Is(err, os.ErrNotExist) {
			return false
		}
	}
	return true
}

func bundleDirExists(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}

func (m *Manager) currentWebUIDirLocked() string {
	if m.getWebUIDir != nil {
		if live := strings.TrimSpace(m.getWebUIDir()); live != "" {
			return live
		}
	}
	return m.activeWebUIDir
}

func (m *Manager) snapshotLocked() StatusSnapshot {
	out := m.status
	out.RemoteCommit = cloneStrPtr(m.status.RemoteCommit)
	out.RemoteVersion = cloneStrPtr(m.status.RemoteVersion)
	out.RemoteTag = cloneStrPtr(m.status.RemoteTag)
	out.ReleaseName = cloneStrPtr(m.status.ReleaseName)
	out.ReleaseNotes = cloneStrPtr(m.status.ReleaseNotes)
	out.ReleaseURL = cloneStrPtr(m.status.ReleaseURL)
	out.PublishedAtIso = cloneStrPtr(m.status.PublishedAtIso)
	out.AssetName = cloneStrPtr(m.status.AssetName)
	if m.status.AssetSizeBytes != nil {
		v := *m.status.AssetSizeBytes
		out.AssetSizeBytes = &v
	}
	if m.status.Progress != nil {
		p := *m.status.Progress
		out.Progress = &p
	}
	out.EdgeBinaryPath = cloneStrPtr(m.status.EdgeBinaryPath)
	if m.status.RestartProgress != nil {
		prog := *m.status.RestartProgress
		prog.DrainDeadlineIso = cloneStrPtr(m.status.RestartProgress.DrainDeadlineIso)
		out.RestartProgress = &prog
	}
	if m.status.LastRestart != nil {
		last := *m.status.LastRestart
		last.Message = cloneStrPtr(m.status.LastRestart.Message)
		out.LastRestart = &last
	}
	out.LastCheckedAtIso = cloneStrPtr(m.status.LastCheckedAtIso)
	out.LastUpdatedAtIso = cloneStrPtr(m.status.LastUpdatedAtIso)
	out.LastError = cloneStrPtr(m.status.LastError)

	histOut := make([]HistoryEntry, 0, len(m.history))
	for _, entry := range m.history {
		item := entry
		item.Tag = cloneStrPtr(entry.Tag)
		item.BundleDir = cloneStrPtr(entry.BundleDir)
		item.Error = cloneStrPtr(entry.Error)
		if entry.Succeeded && entry.BundleDir != nil && *entry.BundleDir != m.activeBundleDir && bundleDirExists(*entry.BundleDir) {
			item.RollbackAvailable = true
		} else {
			item.RollbackAvailable = false
		}
		histOut = append(histOut, item)
	}
	out.History = histOut

	if prev, ok := m.resolveRollbackTargetLocked(""); ok {
		out.CanRollback = true
		var tagPtr *string
		if prev.tag != "" {
			t := prev.tag
			tagPtr = &t
		}
		out.PreviousRelease = &PreviousReleaseInfo{
			ID:      prev.id,
			Version: prev.version,
			Commit:  prev.commit,
			Tag:     tagPtr,
		}
	} else {
		out.CanRollback = false
		out.PreviousRelease = nil
	}

	out.Components = m.buildComponentsLocked()
	return out
}

func (m *Manager) buildComponentsLocked() []ComponentStatus {
	childMap := make(map[string]supervisor.ChildSnapshot)
	if m.sup != nil {
		for _, snap := range m.sup.Snapshots() {
			childMap[snap.Name] = snap
		}
	}

	edgePath, _ := os.Executable()
	var edgeBinPtr *string
	if m.status.EdgeBinaryStaged && m.status.EdgeBinaryPath != nil {
		edgeBinPtr = cloneStrPtr(m.status.EdgeBinaryPath)
	} else if edgePath != "" {
		edgeBinPtr = &edgePath
	}
	edgeStatus := "running"
	if m.status.EdgeBinaryStaged {
		edgeStatus = "staged"
	}

	components := []ComponentStatus{
		{
			Name:            "edge",
			Status:          edgeStatus,
			BinaryPath:      edgeBinPtr,
			Overridden:      m.status.EdgeBinaryStaged,
			RestartRequired: m.status.EdgeBinaryStaged,
			PID:             os.Getpid(),
		},
	}

	for _, name := range []string{"core", "bff"} {
		snap, exists := childMap[name]
		status := "unknown"
		if exists {
			status = string(snap.Status)
		} else if !m.cfg.Supervise {
			status = "stopped"
		}
		var binPtr *string
		overridden := false
		if snap.Binary != "" {
			b := snap.Binary
			binPtr = &b
			if m.cfg.HotUpdateDir != "" && strings.HasPrefix(filepath.Clean(b), filepath.Clean(m.cfg.HotUpdateDir)) {
				overridden = true
			}
		}
		var errPtr *string
		if snap.LastError != "" {
			e := snap.LastError
			errPtr = &e
		}
		components = append(components, ComponentStatus{
			Name:       name,
			Status:     status,
			BinaryPath: binPtr,
			Overridden: overridden,
			PID:        snap.PID,
			LastError:  errPtr,
		})
	}

	guestdStatus := "unknown"
	var guestdPtr *string
	if m.guestdBin != "" {
		g := m.guestdBin
		guestdPtr = &g
		if m.status.GuestdUpdated {
			guestdStatus = "staged"
		} else if _, err := os.Stat(g); err == nil {
			guestdStatus = "pending"
		}
	}
	components = append(components, ComponentStatus{
		Name:       "guestd",
		Status:     guestdStatus,
		BinaryPath: guestdPtr,
		Overridden: m.status.GuestdUpdated,
	})

	webDir := m.currentWebUIDirLocked()
	webStatus := "embedded"
	var webPtr *string
	if webDir != "" {
		webStatus = "overridden"
		w := webDir
		webPtr = &w
	}
	components = append(components, ComponentStatus{
		Name:       "webui",
		Status:     webStatus,
		BinaryPath: webPtr,
		Overridden: m.status.WebUIOverridden || webDir != "",
	})

	return components
}

func (m *Manager) pruneReleasesKeepingHistory(releasesRoot string, maxKeep int, protect ...string) {
	entries, err := os.ReadDir(releasesRoot)
	if err != nil {
		return
	}

	m.mu.RLock()
	keepSet := make(map[string]struct{})
	for _, dir := range append([]string{m.activeBundleDir, m.pendingPlaneBundle}, protect...) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		keepSet[filepath.Clean(dir)] = struct{}{}
		keepSet[filepath.Clean(filepath.Dir(dir))] = struct{}{}
	}
	keptFromHistory := 0
	for _, entry := range m.history {
		if entry.BundleDir != nil && *entry.BundleDir != "" && keptFromHistory < maxKeep {
			clean := filepath.Clean(*entry.BundleDir)
			keepSet[clean] = struct{}{}
			keepSet[filepath.Clean(filepath.Dir(clean))] = struct{}{}
			keptFromHistory++
		}
	}
	m.mu.RUnlock()

	type dirItem struct {
		path string
		mod  time.Time
	}
	var candidates []dirItem
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		full := filepath.Clean(filepath.Join(releasesRoot, e.Name()))
		if _, protected := keepSet[full]; protected {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		candidates = append(candidates, dirItem{path: full, mod: info.ModTime()})
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].mod.After(candidates[j].mod)
	})
	extraKeep := maxKeep - len(keepSet)/2
	if extraKeep < 0 {
		extraKeep = 0
	}
	for i := extraKeep; i < len(candidates); i++ {
		_ = os.RemoveAll(candidates[i].path)
	}
}

func cloneStrPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
