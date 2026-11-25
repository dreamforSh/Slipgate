package hotupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ActiveRelease records the currently active hot-updated release bundle and binaries so
// restarted edge processes launch updated child planes and detect external image upgrades.
type ActiveRelease struct {
	Version     string `json:"version"`
	Commit      string `json:"commit"`
	Tag         string `json:"tag,omitempty"`
	BaseVersion string `json:"baseVersion,omitempty"`
	BaseCommit  string `json:"baseCommit,omitempty"`
	// InstallExe is the externally installed edge binary (what a cold boot runs before handing off).
	InstallExe string `json:"installExe,omitempty"`
	BundleDir  string `json:"bundleDir,omitempty"`
	EdgeBin    string `json:"edgeBin,omitempty"`
	CoreBin    string `json:"coreBin,omitempty"`
	BFFBin     string `json:"bffBin,omitempty"`
	GuestdBin  string `json:"guestdBin,omitempty"`
	WebUIDir   string `json:"webUiDir,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

func activeReleasePath(hotUpdateDir string) string {
	return filepath.Join(strings.TrimSpace(hotUpdateDir), "active.json")
}

// LoadActiveRelease reads the persisted active release descriptor from <HotUpdateDir>/active.json.
func LoadActiveRelease(hotUpdateDir string) (*ActiveRelease, bool) {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil, false
	}
	raw, err := os.ReadFile(activeReleasePath(hotUpdateDir))
	if err != nil {
		return nil, false
	}
	var active ActiveRelease
	if err := json.Unmarshal(raw, &active); err != nil {
		return nil, false
	}
	if strings.TrimSpace(active.Commit) == "" && strings.TrimSpace(active.Version) == "" && strings.TrimSpace(active.EdgeBin) == "" {
		return nil, false
	}
	return &active, true
}

func saveActiveRelease(hotUpdateDir string, active *ActiveRelease) error {
	if strings.TrimSpace(hotUpdateDir) == "" || active == nil {
		return nil
	}
	return writeJSONAtomic(activeReleasePath(hotUpdateDir), active)
}

// ClearActiveRelease removes <HotUpdateDir>/active.json when restoring baseline or detecting external image upgrades.
func ClearActiveRelease(hotUpdateDir string) error {
	if strings.TrimSpace(hotUpdateDir) == "" {
		return nil
	}
	err := os.Remove(activeReleasePath(hotUpdateDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// CommitsEqual reports whether two git commit hashes (full or abbreviated >= 7 chars) refer to the same commit.
func CommitsEqual(a, b string) bool {
	return commitsEqual(a, b)
}

// ResolvedCurrentExecutable returns the cleaned, symlink-resolved path of the running executable.
func ResolvedCurrentExecutable() string {
	exe, err := os.Executable()
	if err != nil || strings.TrimSpace(exe) == "" {
		return ""
	}
	if real, symErr := filepath.EvalSymlinks(exe); symErr == nil && strings.TrimSpace(real) != "" {
		return filepath.Clean(real)
	}
	return filepath.Clean(exe)
}

// SameExecutablePath reports whether two paths point to the same executable after symlink resolution.
func SameExecutablePath(a, b string) bool {
	resolve := func(p string) string {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			return ""
		}
		if real, err := filepath.EvalSymlinks(trimmed); err == nil && strings.TrimSpace(real) != "" {
			return filepath.Clean(real)
		}
		if abs, err := filepath.Abs(trimmed); err == nil {
			return filepath.Clean(abs)
		}
		return filepath.Clean(trimmed)
	}
	ra := resolve(a)
	rb := resolve(b)
	if ra == "" || rb == "" {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ra, rb)
	}
	return ra == rb
}

func validateEdgeBinary(ctx context.Context, binPath string) error {
	info, err := os.Stat(binPath)
	if err != nil {
		return fmt.Errorf("hotupdate: inspect edge binary %s: %w", binPath, err)
	}
	if info.IsDir() || info.Size() == 0 {
		return fmt.Errorf("hotupdate: invalid edge binary %s (dir=%v size=%d)", binPath, info.IsDir(), info.Size())
	}
	_ = os.Chmod(binPath, 0o755)

	vCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(vCtx, binPath, "--version")
	out, err := cmd.CombinedOutput()
	trimmed := strings.TrimSpace(string(out))
	if err != nil {
		return fmt.Errorf("hotupdate: preflight %s --version failed: %w (%s)", binPath, err, trimmed)
	}
	if !strings.HasPrefix(trimmed, "slipgate ") {
		return fmt.Errorf("hotupdate: unexpected --version output from %s: %q", binPath, trimmed)
	}
	return nil
}

// validateStagedEdgeBinary checks a staged edge binary in place (chmod + `--version` preflight
// through validator) before anything is switched over to it.
func validateStagedEdgeBinary(ctx context.Context, binPath string, validator func(context.Context, string) error) error {
	info, err := os.Stat(binPath)
	if err != nil {
		return fmt.Errorf("hotupdate: inspect staged edge binary %s: %w", binPath, err)
	}
	if info.IsDir() || info.Size() == 0 {
		return fmt.Errorf("hotupdate: invalid staged edge binary %s (dir=%v size=%d)", binPath, info.IsDir(), info.Size())
	}
	_ = os.Chmod(binPath, 0o755)
	if validator != nil {
		return validator(ctx, binPath)
	}
	return nil
}

func backupBaselineEdge(hotUpdateDir, currentExe string) (string, error) {
	if strings.TrimSpace(hotUpdateDir) == "" || strings.TrimSpace(currentExe) == "" {
		return "", nil
	}
	dest := filepath.Join(hotUpdateDir, "baseline", "slipgate"+exeExt())
	if info, err := os.Stat(dest); err == nil && !info.IsDir() && info.Size() > 0 {
		return dest, nil
	}
	if err := copyFile(currentExe, dest, 0o755); err != nil {
		return "", err
	}
	return dest, nil
}
