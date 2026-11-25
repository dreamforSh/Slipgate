package hotupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Why a full-service restart was scheduled.
const (
	RestartReasonUpdate       = "update"
	RestartReasonRollback     = "rollback"
	RestartReasonManual       = "manual"
	RestartReasonAutoRollback = "auto_rollback"
)

// Restart progress phases reported by the process that is about to restart.
const (
	RestartPhaseScheduled = "scheduled"
	RestartPhaseDraining  = "draining"
	RestartPhaseStopping  = "stopping"
)

// How the boot after a restart went.
const (
	RestartOutcomeSucceeded  = "succeeded"
	RestartOutcomeDegraded   = "degraded"
	RestartOutcomeRolledBack = "rolled_back"
)

// maxColdBootAttempts is how many cold boots (container / systemd restarts after a crash, not
// exec handoffs) a pending restart gets before startup rolls back to the previous release.
const maxColdBootAttempts = 2

const (
	restartMarkerFile = "restart.json"
	lastRestartFile   = "last-restart.json"
)

// RollbackPlan describes the release that was active before a restart, so a version that fails
// to come up can be swapped back without operator help.
type RollbackPlan struct {
	// Active is the previous active.json; nil with Baseline=true means "no hot-update release".
	Active   *ActiveRelease `json:"active,omitempty"`
	Baseline bool           `json:"baseline,omitempty"`
	// EdgeBin is the edge binary to exec when rolling back in-process.
	EdgeBin string `json:"edgeBin,omitempty"`
	Version string `json:"version,omitempty"`
	Commit  string `json:"commit,omitempty"`
}

// RestartMarker is written to <HotUpdateDir>/restart.json before a scheduled restart and
// cleared once the successor reports healthy.
type RestartMarker struct {
	ID          string        `json:"id"`
	Reason      string        `json:"reason"`
	Target      string        `json:"target"`
	FromVersion string        `json:"fromVersion"`
	FromCommit  string        `json:"fromCommit"`
	ToVersion   string        `json:"toVersion"`
	ToCommit    string        `json:"toCommit"`
	FromBootID  string        `json:"fromBootId"`
	RequestedAt string        `json:"requestedAt"`
	ColdBoots   int           `json:"coldBoots"`
	Rollback    *RollbackPlan `json:"rollback,omitempty"`
	RolledBack  bool          `json:"rolledBack,omitempty"`
	Note        string        `json:"note,omitempty"`
}

// LastRestart summarises the most recent full-service restart for the update center.
type LastRestart struct {
	ID             string  `json:"id"`
	Reason         string  `json:"reason"`
	Outcome        string  `json:"outcome"`
	FromVersion    string  `json:"fromVersion"`
	ToVersion      string  `json:"toVersion"`
	FromCommit     string  `json:"fromCommit"`
	ToCommit       string  `json:"toCommit"`
	RequestedAtIso string  `json:"requestedAtIso"`
	CompletedAtIso string  `json:"completedAtIso"`
	DurationMs     int64   `json:"durationMs"`
	ColdBoots      int     `json:"coldBoots"`
	Message        *string `json:"message"`
}

// RestartProgress is the live state of a restart the current process is carrying out.
type RestartProgress struct {
	Phase            string  `json:"phase"`
	Reason           string  `json:"reason"`
	Inflight         int     `json:"inflight"`
	StartedAtIso     string  `json:"startedAtIso"`
	DrainDeadlineIso *string `json:"drainDeadlineIso"`
}

// BootDecision is what PrepareBoot found before the edge started.
type BootDecision struct {
	Marker     *RestartMarker
	RolledBack bool
}

// LoadRestartMarker reads <HotUpdateDir>/restart.json.
func LoadRestartMarker(hotUpdateDir string) (*RestartMarker, bool) {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil, false
	}
	raw, err := os.ReadFile(filepath.Join(hotUpdateDir, restartMarkerFile))
	if err != nil {
		return nil, false
	}
	var marker RestartMarker
	if json.Unmarshal(raw, &marker) != nil || strings.TrimSpace(marker.ID) == "" {
		return nil, false
	}
	return &marker, true
}

func saveRestartMarker(hotUpdateDir string, marker *RestartMarker) error {
	if strings.TrimSpace(hotUpdateDir) == "" || marker == nil {
		return nil
	}
	return writeJSONAtomic(filepath.Join(hotUpdateDir, restartMarkerFile), marker)
}

// ClearRestartMarker removes <HotUpdateDir>/restart.json.
func ClearRestartMarker(hotUpdateDir string) error {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil
	}
	err := os.Remove(filepath.Join(hotUpdateDir, restartMarkerFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func loadLastRestart(hotUpdateDir string) *LastRestart {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(hotUpdateDir, lastRestartFile))
	if err != nil {
		return nil
	}
	var last LastRestart
	if json.Unmarshal(raw, &last) != nil || last.ID == "" {
		return nil
	}
	return &last
}

// PrepareBoot runs before the edge reads active.json. A cold boot (not the target of an exec
// handoff) with a restart still pending means the new release crashed before it could report
// healthy; after maxColdBootAttempts such boots active.json is restored from the marker's
// rollback plan so the handoff that follows starts the previous release.
func PrepareBoot(hotUpdateDir string, coldBoot bool, logger *log.Logger) BootDecision {
	marker, ok := LoadRestartMarker(hotUpdateDir)
	if !ok {
		return BootDecision{}
	}
	if logger == nil {
		logger = log.Default()
	}
	if coldBoot {
		marker.ColdBoots++
	}
	decision := BootDecision{Marker: marker}
	if coldBoot && !marker.RolledBack && marker.Rollback != nil && marker.ColdBoots >= maxColdBootAttempts {
		if err := applyRollbackPlan(hotUpdateDir, marker.Rollback); err != nil {
			logger.Printf("[hotupdate] boot guard: rollback after %d failed boots could not be applied: %v", marker.ColdBoots, err)
		} else {
			marker.RolledBack = true
			marker.Note = fmt.Sprintf(
				"version %s did not come up after %d boot attempts; rolled back to %s",
				nonEmptyOr(marker.ToVersion, shortCommitLabel(marker.ToCommit)),
				marker.ColdBoots,
				rollbackLabel(marker.Rollback),
			)
			decision.RolledBack = true
			logger.Printf("[hotupdate] boot guard: %s", marker.Note)
		}
	}
	if err := saveRestartMarker(hotUpdateDir, marker); err != nil {
		logger.Printf("[hotupdate] boot guard: persist restart marker: %v", err)
	}
	return decision
}

func applyRollbackPlan(hotUpdateDir string, plan *RollbackPlan) error {
	if plan == nil {
		return errors.New("hotupdate: no rollback plan")
	}
	if plan.Baseline || plan.Active == nil {
		return ClearActiveRelease(hotUpdateDir)
	}
	restored := *plan.Active
	restored.UpdatedAt = isoNow()
	return saveActiveRelease(hotUpdateDir, &restored)
}

func rollbackLabel(plan *RollbackPlan) string {
	if plan == nil {
		return "-"
	}
	if label := nonEmptyOr(plan.Version, shortCommitLabel(plan.Commit)); label != "" {
		return label
	}
	if plan.Baseline {
		return "baseline"
	}
	return "previous release"
}

// rollbackPlanLocked captures what to restore if the release being activated fails to boot.
func (m *Manager) rollbackPlanLocked(prev *ActiveRelease) *RollbackPlan {
	plan := &RollbackPlan{
		Version: m.status.Version,
		Commit:  m.status.ActiveCommit,
	}
	if prev != nil {
		cp := *prev
		plan.Active = &cp
		plan.EdgeBin = prev.EdgeBin
	} else {
		plan.Baseline = true
	}
	if strings.TrimSpace(plan.EdgeBin) == "" {
		plan.EdgeBin = m.installExeLocked(prev)
	}
	return plan
}

// installExeLocked is the externally installed edge binary (what a cold boot runs).
func (m *Manager) installExeLocked(prev *ActiveRelease) string {
	if prev != nil && strings.TrimSpace(prev.InstallExe) != "" {
		return prev.InstallExe
	}
	if strings.TrimSpace(m.installExe) != "" {
		return m.installExe
	}
	if m.baseline != nil && strings.TrimSpace(m.baseline.EdgeBin) != "" {
		return m.baseline.EdgeBin
	}
	return m.currentExePath()
}

// DrainTimeout is how long a restart or shutdown waits for in-flight requests.
func (m *Manager) DrainTimeout() time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	sec := m.status.DrainTimeoutSeconds
	if sec <= 0 {
		sec = defaultDrainTimeoutSec
	}
	return time.Duration(sec) * time.Second
}

// RestartPending reports whether this process has a restart scheduled or in progress.
func (m *Manager) RestartPending() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status.RestartScheduled
}

// SetRestartProgress publishes the restart phase (and drain progress) through Status.
func (m *Manager) SetRestartProgress(phase string, inflight int, drainDeadline time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prog := m.status.RestartProgress
	if prog == nil {
		prog = &RestartProgress{Reason: RestartReasonManual, StartedAtIso: isoNow()}
		m.status.RestartProgress = prog
	}
	prog.Phase = phase
	prog.Inflight = max(0, inflight)
	if !drainDeadline.IsZero() {
		d := drainDeadline.UTC().Format(time.RFC3339)
		prog.DrainDeadlineIso = &d
	}
	m.status.State = StateRestarting
}

// HasPendingBoot reports whether this boot follows a scheduled restart that has not yet been
// confirmed healthy (main gates the public listener on readiness in that case).
func (m *Manager) HasPendingBoot() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bootMarker != nil
}

// CompleteBoot settles the restart marker once the edge knows whether its planes came up:
// it records the outcome, and when a restarted release never became ready it restores the
// previous release and restarts into it (once — an automatic rollback is never rolled back).
func (m *Manager) CompleteBoot(ctx context.Context, ready bool) {
	m.mu.Lock()
	marker := m.bootMarker
	m.bootMarker = nil
	m.mu.Unlock()
	if marker == nil {
		return
	}

	completed := time.Now().UTC()
	last := &LastRestart{
		ID:             marker.ID,
		Reason:         marker.Reason,
		FromVersion:    marker.FromVersion,
		ToVersion:      marker.ToVersion,
		FromCommit:     marker.FromCommit,
		ToCommit:       marker.ToCommit,
		RequestedAtIso: marker.RequestedAt,
		CompletedAtIso: completed.Format(time.RFC3339),
		ColdBoots:      marker.ColdBoots,
	}
	if requested, err := time.Parse(time.RFC3339Nano, marker.RequestedAt); err == nil {
		last.DurationMs = max(0, completed.Sub(requested).Milliseconds())
	}

	canRollback := marker.Rollback != nil && marker.Reason != RestartReasonAutoRollback && m.onEdgeRestart != nil
	switch {
	case marker.RolledBack:
		last.Outcome = RestartOutcomeRolledBack
		msg := marker.Note
		last.Message = &msg
		m.recordAutoRollback(marker, msg)
	case ready:
		last.Outcome = RestartOutcomeSucceeded
	case canRollback:
		msg := fmt.Sprintf(
			"version %s did not pass the post-restart health check; rolling back to %s",
			nonEmptyOr(marker.ToVersion, shortCommitLabel(marker.ToCommit)),
			rollbackLabel(marker.Rollback),
		)
		if err := applyRollbackPlan(m.cfg.HotUpdateDir, marker.Rollback); err != nil {
			msg = fmt.Sprintf("post-restart health check failed and rollback could not be applied: %v", err)
			last.Outcome = RestartOutcomeDegraded
			last.Message = &msg
			break
		}
		last.Outcome = RestartOutcomeRolledBack
		last.Message = &msg
		m.recordAutoRollback(marker, msg)
		m.persistLastRestart(last)
		_ = ClearRestartMarker(m.cfg.HotUpdateDir)
		m.logger.Printf("[hotupdate] boot guard: %s", msg)
		target := strings.TrimSpace(marker.Rollback.EdgeBin)
		if target == "" {
			target = m.currentExePath()
		}
		m.mu.Lock()
		m.status.RestartScheduled = true
		m.status.State = StateRestarting
		m.status.Version = nonEmptyOr(marker.Rollback.Version, m.status.Version)
		m.status.ActiveCommit = nonEmptyOr(marker.Rollback.Commit, m.status.ActiveCommit)
		m.mu.Unlock()
		m.triggerEdgeRestart(restartRequest{
			Target:    target,
			Async:     true,
			Reason:    RestartReasonAutoRollback,
			ToVersion: marker.Rollback.Version,
			ToCommit:  marker.Rollback.Commit,
		})
		return
	default:
		last.Outcome = RestartOutcomeDegraded
		msg := "planes did not report ready within the startup timeout"
		last.Message = &msg
	}

	m.persistLastRestart(last)
	if err := ClearRestartMarker(m.cfg.HotUpdateDir); err != nil {
		m.logger.Printf("[hotupdate] boot guard: clear restart marker: %v", err)
	}
	m.logger.Printf("[hotupdate] restart %s (%s) finished: %s in %dms", last.ID, last.Reason, last.Outcome, last.DurationMs)
	_ = ctx
}

func (m *Manager) persistLastRestart(last *LastRestart) {
	m.mu.Lock()
	m.status.LastRestart = last
	m.mu.Unlock()
	if m.cfg.HotUpdateDir == "" || last == nil {
		return
	}
	if err := writeJSONAtomic(filepath.Join(m.cfg.HotUpdateDir, lastRestartFile), last); err != nil {
		m.logger.Printf("[hotupdate] persist last restart: %v", err)
	}
}

func (m *Manager) recordAutoRollback(marker *RestartMarker, msg string) {
	if marker == nil || marker.Rollback == nil {
		return
	}
	plan := marker.Rollback
	tag := ""
	bundle := ""
	if plan.Active != nil {
		tag = plan.Active.Tag
		bundle = plan.Active.BundleDir
	}
	entry := buildHistoryEntry(applyBundleRequest{
		BundleRoot:  bundle,
		NewCommit:   plan.Commit,
		NewVersion:  plan.Version,
		Tag:         tag,
		Strategy:    "release",
		Action:      "rollback",
		FromVersion: marker.ToVersion,
		FromCommit:  marker.ToCommit,
	})
	entry.Error = &msg
	m.mu.Lock()
	entry.Channel = m.status.Channel
	m.appendHistoryLocked(entry)
	m.status.Version = nonEmptyOr(plan.Version, m.status.Version)
	m.status.ActiveCommit = nonEmptyOr(plan.Commit, m.status.ActiveCommit)
	if plan.Active != nil {
		m.activeBundleDir = plan.Active.BundleDir
		m.activeTag = plan.Active.Tag
	} else {
		m.activeBundleDir = ""
	}
	_ = m.savePersistedHistoryLocked()
	m.mu.Unlock()
}
