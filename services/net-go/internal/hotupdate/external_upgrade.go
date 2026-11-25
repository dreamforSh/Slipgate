package hotupdate

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// ReconcileExternalUpgrade runs at startup, before PrepareBoot and the active.json handoff. When
// the installed binary was upgraded outside the update center (a new image, a reinstall, a
// rebuild), the hot-update overlay describes the previous install: the active release, any
// pending restart marker and the baseline (whose plane paths now hold the new binaries) are
// cleared, so the new install runs as shipped and the next update captures a fresh baseline.
// It reports whether the overlay was cleared.
func ReconcileExternalUpgrade(hotUpdateDir, binVersion, binCommit, curExe string, logger *log.Logger) bool {
	active, ok := LoadActiveRelease(hotUpdateDir)
	if !ok {
		return false
	}
	// The release's own edge (started through the handoff) is not the installed binary.
	if strings.TrimSpace(active.EdgeBin) != "" && SameExecutablePath(curExe, active.EdgeBin) {
		return false
	}
	reason := externalUpgradeReason(active, binVersion, binCommit, curExe)
	if reason == "" {
		return false
	}
	if logger == nil {
		logger = log.Default()
	}
	logger.Printf(
		"[hotupdate] detected external upgrade (%s; binary %s/%s, active release %s/%s); clearing the hot-update release, restart marker and baseline",
		reason, binVersion, shortCommitLabel(binCommit), active.Version, shortCommitLabel(active.Commit),
	)
	if err := ClearActiveRelease(hotUpdateDir); err != nil {
		logger.Printf("[hotupdate] clear active release: %v", err)
	}
	if err := ClearRestartMarker(hotUpdateDir); err != nil {
		logger.Printf("[hotupdate] clear restart marker: %v", err)
	}
	if err := ResetBaseline(hotUpdateDir); err != nil {
		logger.Printf("[hotupdate] reset baseline: %v", err)
	}
	return true
}

// externalUpgradeReason explains why the running install differs from the one active.json was
// written for, or returns "" when it is the same install.
func externalUpgradeReason(active *ActiveRelease, binVersion, binCommit, curExe string) string {
	// Same path, different file: covers rebuilt images whose commit is the placeholder "dev".
	if active.InstallFingerprint != "" && SameExecutablePath(curExe, active.InstallExe) {
		if fp := ExecutableFingerprint(curExe); fp != "" && fp != active.InstallFingerprint {
			return "the installed binary was replaced"
		}
	}
	base, bin := strings.TrimSpace(active.BaseVersion), strings.TrimSpace(binVersion)
	if base != "" && bin != "" && base != bin {
		return fmt.Sprintf("installed version changed from %s to %s", base, bin)
	}
	// Also covers catching up: the install now ships the very release that was hot-applied.
	if isRealCommit(active.BaseCommit) && isRealCommit(binCommit) && !CommitsEqual(active.BaseCommit, binCommit) {
		return fmt.Sprintf("installed commit changed from %s to %s", shortCommitLabel(active.BaseCommit), shortCommitLabel(binCommit))
	}
	return ""
}

// isRealCommit filters out build placeholders ("dev", "unknown") that never identify a build.
func isRealCommit(commit string) bool {
	c := strings.TrimSpace(commit)
	return len(c) >= 7 && !strings.EqualFold(c, "unknown")
}

// ExecutableFingerprint is a cheap identity for an installed binary: size and modification time.
func ExecutableFingerprint(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return ""
	}
	return fmt.Sprintf("%d-%d", info.Size(), info.ModTime().UnixNano())
}

// installFingerprintFor carries the install fingerprint forward, or takes it from the install
// binary when that is the process running now (otherwise the file on disk is not known to be
// the one that booted, so no fingerprint is recorded).
func installFingerprintFor(prev *ActiveRelease, installExe, currentExe string) string {
	if prev != nil && prev.InstallFingerprint != "" && SameExecutablePath(prev.InstallExe, installExe) {
		return prev.InstallFingerprint
	}
	if SameExecutablePath(installExe, currentExe) {
		return ExecutableFingerprint(installExe)
	}
	return ""
}
