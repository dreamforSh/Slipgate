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
	BundleDir   string `json:"bundleDir,omitempty"`
	EdgeBin     string `json:"edgeBin,omitempty"`
	CoreBin     string `json:"coreBin,omitempty"`
	BFFBin      string `json:"bffBin,omitempty"`
	GuestdBin   string `json:"guestdBin,omitempty"`
	WebUIDir    string `json:"webUiDir,omitempty"`
	UpdatedAt   string `json:"updatedAt"`
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

func replaceExecutableAtomically(currentExe, newBin string) error {
	return replaceExecutableAtomicallyWithValidator(context.Background(), currentExe, newBin, nil)
}

func replaceExecutableAtomicallyWithValidator(
	ctx context.Context,
	currentExe string,
	newBin string,
	validator func(context.Context, string) error,
) error {
	if strings.TrimSpace(currentExe) == "" {
		return errors.New("hotupdate: current executable path is empty")
	}
	dir := filepath.Dir(currentExe)
	tmpPath := filepath.Join(dir, fmt.Sprintf(".%s.tmp-%d", filepath.Base(currentExe), time.Now().UnixNano()))
	if err := copyFile(newBin, tmpPath, 0o755); err != nil {
		return err
	}
	_ = os.Chmod(tmpPath, 0o755)
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	if validator != nil {
		if err := validator(ctx, tmpPath); err != nil {
			return err
		}
	}

	if runtime.GOOS == "windows" {
		backup := currentExe + ".old"
		_ = os.Remove(backup)
		if _, err := os.Stat(currentExe); err == nil {
			if err := os.Rename(currentExe, backup); err != nil {
				return err
			}
		}
		if err := os.Rename(tmpPath, currentExe); err != nil {
			_ = os.Rename(backup, currentExe)
			return err
		}
		cleanupTmp = false
		_ = os.Remove(backup)
		return nil
	}

	if err := os.Rename(tmpPath, currentExe); err != nil {
		return err
	}
	cleanupTmp = false
	return nil
}

// prepareAndStageEdgeBinary validates srcBin (preflighting a sibling temp copy first when
// currentExe's directory is writable, then swapping atomically onto currentExe; otherwise
// validating srcBin directly in the update stage directory for non-writable system paths).
func prepareAndStageEdgeBinary(
	ctx context.Context,
	currentExe string,
	srcBin string,
	validator func(context.Context, string) error,
) (target string, err error) {
	_ = os.Chmod(srcBin, 0o755)

	if strings.TrimSpace(currentExe) != "" {
		tmpPath := filepath.Join(
			filepath.Dir(currentExe),
			fmt.Sprintf(".%s.tmp-%d", filepath.Base(currentExe), time.Now().UnixNano()),
		)
		if copyErr := copyFile(srcBin, tmpPath, 0o755); copyErr == nil {
			_ = os.Chmod(tmpPath, 0o755)
			if validator != nil {
				if valErr := validator(ctx, tmpPath); valErr != nil {
					_ = os.Remove(tmpPath)
					return "", valErr
				}
			}
			swapErr := func() error {
				if runtime.GOOS == "windows" {
					backup := currentExe + ".old"
					_ = os.Remove(backup)
					if _, stErr := os.Stat(currentExe); stErr == nil {
						if err := os.Rename(currentExe, backup); err != nil {
							return err
						}
					}
					if err := os.Rename(tmpPath, currentExe); err != nil {
						_ = os.Rename(backup, currentExe)
						return err
					}
					_ = os.Remove(backup)
					return nil
				}
				return os.Rename(tmpPath, currentExe)
			}()
			if swapErr == nil {
				return currentExe, nil
			}
			_ = os.Remove(tmpPath)
			return srcBin, nil
		}
	}

	if validator != nil {
		if err := validator(ctx, srcBin); err != nil {
			return "", err
		}
	}
	return srcBin, nil
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
