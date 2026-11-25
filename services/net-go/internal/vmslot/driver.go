package vmslot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

var safeSegmentRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// ErrInvalidSlotID rejects slot ids that are unsafe as a path segment or shell word.
var ErrInvalidSlotID = errors.New("vmslot: invalid slot id")

var slotIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidSlotID reports whether id is safe as one path segment on every driver: it starts with a
// letter or digit (never ".", ".." or an option-like "-x") and never contains "..".
func ValidSlotID(id string) bool {
	return slotIDRe.MatchString(id) && !strings.Contains(id, "..")
}

// Jailed slot console, shared by LocalSlotDriver and AgentlessSSHDriver.
const (
	consoleDeniedChars = ";|&`$><\r\n"
	consoleHelpText    = "Built-in jailed commands: help, status, runtime, uname -a, machine-id, persona, seed, env, ls [dir], cat <rel-path>, ping\n"
)

func consoleMetacharDenied() DriverExecResult {
	return DriverExecResult{
		Stderr:   "permission denied: shell metacharacters are disabled in jailed slot console",
		ExitCode: 1,
	}
}

func consoleUnsupported(op string) DriverExecResult {
	return DriverExecResult{
		Stderr:   fmt.Sprintf("unsupported command %q in jailed slot console (type 'help')\n", op),
		ExitCode: 127,
	}
}

func consoleStatusLine(node ClusterNode, slot Slot) string {
	return fmt.Sprintf(
		"slot=%s runtime=%s state=%s node=%s (%s) hypervisor=%s exit_ip=%s subagents=%d/%d daemon=%s endpoint=%s\n",
		slot.ID, effectiveRuntimeProfile(slot.RuntimeProfile), slot.State, node.ID, node.Arch, slot.Hypervisor, slot.ExitIP,
		slot.ActiveSubagents, slot.MaxSubagents, defaultIfEmpty(slot.DaemonVersion, "sandbox-ready"), slot.GuestUDSPath,
	)
}

func consoleSeedSummary(seed SlotSeed) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# telemetryMode=%s rejectClientSettings=%v rejectClientIdentity=%v syncedAt=%d\n",
		seed.TelemetryMode, seed.RejectClientSettings, seed.RejectClientIdentity, seed.SyncedAtUnixMs)
	fmt.Fprintf(&out, "--- settings.json ---\n%s\n--- custom_setting.env ---\n%s\n",
		seed.SettingsJSONRaw, seed.CustomSettingRaw)
	return out.String()
}

func consoleEnvSummary(slot Slot, seed SlotSeed) string {
	return fmt.Sprintf(
		"SLIPGATE_SLOT_ID=%s\nSLIPGATE_GUEST_MACHINE_ID=%s\nSLIPGATE_CLEANSE_MODE=%s\nSLIPGATE_TELEMETRY_MODE=%s\n%s",
		slot.ID, slot.Persona.GuestMachineID, slot.CleanseMode, slot.Telemetry, redactProxyEnv(seed.ProxyEnvRaw),
	)
}

// runtimeSettingsRelPath is the runtime's settings file relative to the slot root.
func runtimeSettingsRelPath(slot Slot) string {
	switch effectiveRuntimeProfile(slot.RuntimeProfile) {
	case RuntimeCodexCLI:
		return "home/runner/.codex/config.toml"
	case RuntimeAntigravity:
		return "home/runner/.antigravity/settings.json"
	default:
		return "home/runner/.claude/settings.json"
	}
}

// DriverExecResult captures stdout, stderr, and exit status from a sandboxed or SSH slot command.
type DriverExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

// SlotDriver encapsulates OS/hypervisor materialization, guest daemon supervision, and terminal inspection.
type SlotDriver interface {
	MaterializeSlot(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) (Slot, error)
	StartSlot(ctx context.Context, node ClusterNode, slot Slot) (Slot, error)
	StopSlot(ctx context.Context, node ClusterNode, slot Slot) error
	SyncSeed(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) error
	ExecTerminalCommand(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, command string) (DriverExecResult, error)
	DestroySlot(ctx context.Context, node ClusterNode, slot Slot) error
}

// LocalSlotDriver manages local isolated VM/container slot directories, immutable machine-id files, and optional slipgate-guestd processes.
type LocalSlotDriver struct {
	vmDataDir string

	mu sync.Mutex
	// guestdBin can be swapped by a hot update while slots start; read it through GuestdBin.
	guestdBin string
	procs     map[string]*exec.Cmd
}

func NewLocalSlotDriver(vmDataDir, guestdBin string) *LocalSlotDriver {
	if strings.TrimSpace(vmDataDir) == "" {
		vmDataDir = filepath.Join(os.TempDir(), "slipgate-vms")
	}
	return &LocalSlotDriver{
		vmDataDir: vmDataDir,
		guestdBin: strings.TrimSpace(guestdBin),
		procs:     make(map[string]*exec.Cmd),
	}
}

// GuestdBin is the slipgate-guestd binary new slots start with.
func (d *LocalSlotDriver) GuestdBin() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.guestdBin
}

// SetGuestdBin switches the slipgate-guestd binary used by slots started from now on (a hot
// update delivering a new guestd); running daemons keep their binary until restarted.
func (d *LocalSlotDriver) SetGuestdBin(bin string) {
	d.mu.Lock()
	d.guestdBin = strings.TrimSpace(bin)
	d.mu.Unlock()
}

func (d *LocalSlotDriver) GuestdAvailable() bool {
	return guestdUsable(d.GuestdBin())
}

func guestdUsable(bin string) bool {
	if bin == "" {
		return false
	}
	info, err := os.Stat(bin)
	return err == nil && !info.IsDir()
}

func (d *LocalSlotDriver) slotRootDir(slotID string) (string, error) {
	if !ValidSlotID(slotID) {
		return "", fmt.Errorf("%w: %q", ErrInvalidSlotID, slotID)
	}
	return filepath.Join(d.vmDataDir, "slots", slotID), nil
}

func (d *LocalSlotDriver) MaterializeSlot(_ context.Context, node ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) (Slot, error) {
	rootDir, err := d.slotRootDir(slot.ID)
	if err != nil {
		return slot, err
	}
	etcDir := filepath.Join(rootDir, "etc")
	seedDir := filepath.Join(rootDir, "seed")
	if err := os.MkdirAll(etcDir, 0o750); err != nil {
		return slot, fmt.Errorf("vmslot: create slot etc dir: %w", err)
	}
	if err := os.MkdirAll(seedDir, 0o750); err != nil {
		return slot, fmt.Errorf("vmslot: create slot seed dir: %w", err)
	}

	// Enforce read-only immutable etc/machine-id inside the slot root.
	machineIDPath := filepath.Join(etcDir, "machine-id")
	if rawExisting, readErr := os.ReadFile(machineIDPath); readErr == nil {
		existingID := strings.TrimSpace(string(rawExisting))
		if existingID != "" && existingID != slot.Persona.GuestMachineID {
			return slot, ErrImmutableMachineID
		}
	} else {
		if err := os.WriteFile(machineIDPath, []byte(slot.Persona.GuestMachineID+"\n"), 0o600); err != nil {
			return slot, fmt.Errorf("vmslot: write etc/machine-id: %w", err)
		}
		_ = os.Chmod(machineIDPath, 0o444)
	}

	personaBytes, _ := json.MarshalIndent(slot.Persona, "", "  ")
	if err := os.WriteFile(filepath.Join(rootDir, "persona.json"), personaBytes, 0o600); err != nil {
		return slot, fmt.Errorf("vmslot: write persona.json: %w", err)
	}

	runtimeSpec := map[string]any{
		"slotId":          slot.ID,
		"clusterNodeId":   node.ID,
		"runtimeProfile":  effectiveRuntimeProfile(slot.RuntimeProfile),
		"hypervisorKind":  slot.Hypervisor,
		"guestMachineId":  slot.Persona.GuestMachineID,
		"macAddress":      slot.Persona.MACAddress,
		"smbiosUuid":      slot.Persona.SMBIOSUUID,
		"smbiosSerial":    slot.Persona.SMBIOSSerial,
		"memoryMiB":       slot.MemoryMiB,
		"cpuModel":        slot.Persona.CPUModel,
		"cpuCores":        slot.Persona.CPUCores,
		"maxSubagents":    slot.MaxSubagents,
		"telemetryMode":   slot.Telemetry,
		"cleanseMode":     slot.CleanseMode,
		"launchCommand":   buildLaunchCommandPreview(slot, rootDir),
		"materializedUtc": time.Now().UTC().Format(time.RFC3339),
	}
	runtimeBytes, _ := json.MarshalIndent(runtimeSpec, "", "  ")
	if err := os.WriteFile(filepath.Join(rootDir, "runtime-command.json"), runtimeBytes, 0o600); err != nil {
		return slot, fmt.Errorf("vmslot: write runtime-command.json: %w", err)
	}

	if err := writeSeedFiles(seedDir, slot, seed, target); err != nil {
		return slot, err
	}
	if err := writeRuntimeHomeFiles(rootDir, slot, seed); err != nil {
		return slot, err
	}

	slot.RootDir = rootDir
	return slot, nil
}

func (d *LocalSlotDriver) SyncSeed(_ context.Context, _ ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) error {
	rootDir := slot.RootDir
	if rootDir == "" {
		var err error
		rootDir, err = d.slotRootDir(slot.ID)
		if err != nil {
			return err
		}
	}
	seedDir := filepath.Join(rootDir, "seed")
	if err := os.MkdirAll(seedDir, 0o750); err != nil {
		return err
	}
	if err := writeSeedFiles(seedDir, slot, seed, target); err != nil {
		return err
	}
	return writeRuntimeHomeFiles(rootDir, slot, seed)
}

func (d *LocalSlotDriver) StartSlot(ctx context.Context, _ ClusterNode, slot Slot) (Slot, error) {
	if slot.RootDir == "" {
		var err error
		slot.RootDir, err = d.slotRootDir(slot.ID)
		if err != nil {
			return slot, err
		}
	}

	_ = d.StopSlot(ctx, ClusterNode{}, slot)
	now := time.Now().UTC()

	guestdBin := d.GuestdBin()
	if !guestdUsable(guestdBin) {
		slot.State = StateReady
		slot.GuestPID = 0
		slot.DaemonVersion = "sandbox-ready"
		slot.GuestUDSPath = "sandbox://" + slot.ID
		slot.LastHeartbeat = &now
		return slot, nil
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		slot.State = StateReady
		slot.DaemonVersion = "sandbox-ready"
		slot.GuestUDSPath = "sandbox://" + slot.ID
		slot.LastHeartbeat = &now
		return slot, nil
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	rp := effectiveRuntimeProfile(slot.RuntimeProfile)
	guestHome := filepath.Join(slot.RootDir, "home", "runner")
	guestToken := strings.TrimSpace(os.Getenv("SLIPGATE_GUEST_TOKEN"))
	cmd := exec.Command(guestdBin)
	cmd.Dir = slot.RootDir
	cmd.Env = append(os.Environ(),
		"HOME="+guestHome,
		"SLIPGATE_GUEST_ADDR="+addr,
		"SLIPGATE_GUEST_MACHINE_ID="+slot.Persona.GuestMachineID,
		"SLIPGATE_SLOT_ID="+slot.ID,
		"SLIPGATE_RUNTIME_PROFILE="+string(rp),
		"SLIPGATE_MAX_SUBAGENTS="+strconv.FormatUint(uint64(max(1, slot.MaxSubagents)), 10),
		"SLIPGATE_CLEANSE_MODE="+defaultIfEmpty(slot.CleanseMode, "zero"),
		"SLIPGATE_TELEMETRY_MODE="+defaultIfEmpty(string(slot.Telemetry), string(TelemetryIsolated)),
		"CLAUDE_CONFIG_DIR="+filepath.Join(guestHome, ".claude"),
		"CODEX_HOME="+filepath.Join(guestHome, ".codex"),
		"ANTIGRAVITY_HOME="+filepath.Join(guestHome, ".antigravity"),
	)
	if guestToken != "" {
		cmd.Env = append(cmd.Env, "SLIPGATE_GUEST_TOKEN="+guestToken)
	}
	if err := cmd.Start(); err != nil {
		return slot, fmt.Errorf("vmslot: spawn slipgate-guestd: %w", err)
	}

	endpoint := "tcp://" + addr
	pingCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()

	var pingErr error
	for attempt := 0; attempt < 15; attempt++ {
		if pingErr = dpbridge.PingAuth(pingCtx, endpoint, guestToken); pingErr == nil {
			break
		}
		select {
		case <-pingCtx.Done():
			pingErr = pingCtx.Err()
			break
		case <-time.After(100 * time.Millisecond):
		}
	}
	if pingErr != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
		return slot, fmt.Errorf("vmslot: slipgate-guestd failed health ping on %s: %w", endpoint, pingErr)
	}

	d.mu.Lock()
	d.procs[slot.ID] = cmd
	d.mu.Unlock()

	slot.State = StateReady
	slot.GuestPID = cmd.Process.Pid
	slot.GuestUDSPath = endpoint
	slot.DaemonVersion = "slipgate-guestd/0.2.0"
	slot.LastHeartbeat = &now
	return slot, nil
}

func (d *LocalSlotDriver) StopSlot(_ context.Context, _ ClusterNode, slot Slot) error {
	d.mu.Lock()
	cmd, ok := d.procs[slot.ID]
	delete(d.procs, slot.ID)
	d.mu.Unlock()
	if ok && cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
	return nil
}

func (d *LocalSlotDriver) DestroySlot(ctx context.Context, node ClusterNode, slot Slot) error {
	_ = d.StopSlot(ctx, node, slot)
	rootDir := slot.RootDir
	if rootDir == "" {
		var err error
		rootDir, err = d.slotRootDir(slot.ID)
		if err != nil {
			return err
		}
	}
	// Reset read-only file permissions on machine-id anchors so Windows os.RemoveAll succeeds cleanly.
	for _, roRel := range []string{
		filepath.Join("etc", "machine-id"),
		filepath.Join("home", "runner", ".antigravity", "machineid"),
	} {
		roPath := filepath.Join(rootDir, roRel)
		if _, statErr := os.Stat(roPath); statErr == nil {
			_ = os.Chmod(roPath, 0o644)
		}
	}
	return os.RemoveAll(rootDir)
}

func (d *LocalSlotDriver) ExecTerminalCommand(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, command string) (DriverExecResult, error) {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return DriverExecResult{}, nil
	}
	if strings.ContainsAny(trimmed, consoleDeniedChars) {
		return consoleMetacharDenied(), nil
	}

	rootDir := slot.RootDir
	if rootDir == "" {
		var err error
		rootDir, err = d.slotRootDir(slot.ID)
		if err != nil {
			return DriverExecResult{Stderr: err.Error(), ExitCode: 1}, nil
		}
	}

	fields := strings.Fields(trimmed)
	op := fields[0]

	switch op {
	case "help":
		return DriverExecResult{Stdout: consoleHelpText}, nil

	case "status":
		return DriverExecResult{Stdout: consoleStatusLine(node, slot)}, nil

	case "runtime":
		return readJailedFile(rootDir, runtimeSettingsRelPath(slot), false)

	case "uname":
		return DriverExecResult{
			Stdout: fmt.Sprintf("Linux %s 6.8.0-slipgate #1 SMP PREEMPT_DYNAMIC %s GNU/Linux\n", slot.ID, runtime.GOARCH),
		}, nil

	case "machine-id":
		return readJailedFile(rootDir, "etc/machine-id", false)

	case "persona":
		return readJailedFile(rootDir, "persona.json", false)

	case "seed":
		return DriverExecResult{Stdout: consoleSeedSummary(seed)}, nil

	case "env":
		return DriverExecResult{Stdout: consoleEnvSummary(slot, seed)}, nil

	case "ping":
		if strings.HasPrefix(slot.GuestUDSPath, "tcp://") || strings.HasPrefix(slot.GuestUDSPath, "unix://") {
			if err := dpbridge.Ping(ctx, slot.GuestUDSPath); err != nil {
				return DriverExecResult{Stderr: "guestd ping failed: " + err.Error() + "\n", ExitCode: 1}, nil
			}
			return DriverExecResult{Stdout: fmt.Sprintf("PONG from slipgate-guestd (%s) machine_id=%s\n", slot.GuestUDSPath, slot.Persona.GuestMachineID)}, nil
		}
		return DriverExecResult{Stdout: fmt.Sprintf("PONG sandbox-ready slot=%s machine_id=%s\n", slot.ID, slot.Persona.GuestMachineID)}, nil

	case "ls":
		rel := "."
		if len(fields) > 1 {
			rel = fields[1]
		}
		target, err := resolveInsideSlotRoot(rootDir, rel)
		if err != nil {
			return DriverExecResult{Stderr: err.Error() + "\n", ExitCode: 1}, nil
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			return DriverExecResult{Stderr: err.Error() + "\n", ExitCode: 1}, nil
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		var b strings.Builder
		for _, ent := range entries {
			suffix := ""
			if ent.IsDir() {
				suffix = "/"
			}
			b.WriteString(ent.Name() + suffix + "\n")
		}
		return DriverExecResult{Stdout: b.String()}, nil

	case "cat":
		if len(fields) < 2 {
			return DriverExecResult{Stderr: "usage: cat <relative-path>\n", ExitCode: 1}, nil
		}
		rel := fields[1]
		if rel == "/etc/machine-id" {
			rel = "etc/machine-id"
		}
		redact := strings.Contains(strings.ToLower(rel), "proxy")
		return readJailedFile(rootDir, rel, redact)

	default:
		return consoleUnsupported(op), nil
	}
}

func resolveInsideSlotRoot(rootDir, relPath string) (string, error) {
	if filepath.IsAbs(relPath) || strings.HasPrefix(relPath, "/") || strings.HasPrefix(relPath, `\`) {
		return "", errors.New("access denied: absolute host paths outside slot root are blocked")
	}
	absRoot, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}
	cleaned := filepath.Clean(filepath.Join(absRoot, relPath))
	if cleaned != absRoot && !strings.HasPrefix(cleaned, absRoot+string(filepath.Separator)) {
		return "", errors.New("access denied: path traversal outside slot root is blocked")
	}
	return cleaned, nil
}

func readJailedFile(rootDir, relPath string, redact bool) (DriverExecResult, error) {
	target, err := resolveInsideSlotRoot(rootDir, relPath)
	if err != nil {
		return DriverExecResult{Stderr: err.Error() + "\n", ExitCode: 1}, nil
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return DriverExecResult{Stderr: err.Error() + "\n", ExitCode: 1}, nil
	}
	text := string(raw)
	if redact {
		text = redactProxyEnv(text)
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return DriverExecResult{Stdout: text}, nil
}

func redactProxyEnv(raw string) string {
	lines := strings.Split(raw, "\n")
	for i, line := range lines {
		if idx := strings.Index(line, "://"); idx != -1 {
			if at := strings.Index(line[idx+3:], "@"); at != -1 {
				credsStart := idx + 3
				credsEnd := credsStart + at
				if colon := strings.Index(line[credsStart:credsEnd], ":"); colon != -1 {
					user := line[credsStart : credsStart+colon]
					lines[i] = line[:credsStart] + user + ":***" + line[credsEnd:]
				}
			}
		}
	}
	res := strings.Join(lines, "\n")
	if res != "" && !strings.HasSuffix(res, "\n") {
		res += "\n"
	}
	return res
}

func writeSeedFiles(seedDir string, slot Slot, seed SlotSeed, target *clashpool.DialTarget) error {
	settings := seed.SettingsJSONRaw
	if strings.TrimSpace(settings) == "" {
		settings = "{}"
	}
	if err := os.WriteFile(filepath.Join(seedDir, "settings.json"), []byte(settings+"\n"), 0o600); err != nil {
		return fmt.Errorf("vmslot: write seed settings.json: %w", err)
	}
	if err := os.WriteFile(filepath.Join(seedDir, "custom_setting.env"), []byte(seed.CustomSettingRaw), 0o600); err != nil {
		return fmt.Errorf("vmslot: write seed custom_setting.env: %w", err)
	}
	if strings.TrimSpace(seed.AuthJSONRaw) != "" {
		if err := os.WriteFile(filepath.Join(seedDir, "auth.json"), []byte(seed.AuthJSONRaw+"\n"), 0o600); err != nil {
			return fmt.Errorf("vmslot: write seed auth.json: %w", err)
		}
	}
	proxyEnv := seed.ProxyEnvRaw
	if proxyEnv == "" && target != nil && target.SOCKSAddr != "" {
		proxyURL := fmt.Sprintf("socks5h://%s:%s@%s", target.SocksUsername, target.SocksPassword, target.SOCKSAddr)
		proxyEnv = fmt.Sprintf("HTTP_PROXY=%s\nHTTPS_PROXY=%s\nALL_PROXY=%s\n", proxyURL, proxyURL, proxyURL)
	}
	if err := os.WriteFile(filepath.Join(seedDir, "proxy.env"), []byte(proxyEnv), 0o600); err != nil {
		return fmt.Errorf("vmslot: write seed proxy.env: %w", err)
	}
	bootstrap := seed.BootstrapScriptRaw
	if strings.TrimSpace(bootstrap) == "" {
		bootstrap = fmt.Sprintf("#!/bin/sh\nset -e\n# Bound slot=%s runtime=%s machine_id=%s exit_ip=%s\n", slot.ID, effectiveRuntimeProfile(slot.RuntimeProfile), slot.Persona.GuestMachineID, slot.ExitIP)
	}
	if err := os.WriteFile(filepath.Join(seedDir, "bootstrap.sh"), []byte(bootstrap), 0o700); err != nil {
		return fmt.Errorf("vmslot: write bootstrap.sh: %w", err)
	}
	return nil
}

func effectiveRuntimeProfile(rp RuntimeProfile) RuntimeProfile {
	switch rp {
	case RuntimeCodexCLI, RuntimeAntigravity:
		return rp
	default:
		return RuntimeClaudeCode
	}
}

func writeRuntimeHomeFiles(rootDir string, slot Slot, seed SlotSeed) error {
	rp := effectiveRuntimeProfile(slot.RuntimeProfile)
	homeDir := filepath.Join(rootDir, "home", "runner")
	if err := os.MkdirAll(homeDir, 0o750); err != nil {
		return fmt.Errorf("vmslot: create guest home dir: %w", err)
	}

	userDigest := sha256.Sum256([]byte("slipgate-vm-user:" + slot.Persona.GuestMachineID))
	userIDHex := hex.EncodeToString(userDigest[:])
	authContent := strings.TrimSpace(seed.AuthJSONRaw)
	if authContent == "" {
		authContent = "{}"
	}
	settingsContent := strings.TrimSpace(seed.SettingsJSONRaw)
	if settingsContent == "" {
		settingsContent = "{}"
	}

	switch rp {
	case RuntimeCodexCLI:
		codexDir := filepath.Join(homeDir, ".codex")
		if err := os.MkdirAll(codexDir, 0o700); err != nil {
			return err
		}
		otelExporter := "none"
		if slot.Telemetry == TelemetryEnabled {
			otelExporter = "otlp-http"
		}
		configTOML := fmt.Sprintf(
			"# Generated by Slipgate VM Coordinator (slot=%s machine_id=%s)\n"+
				"model = \"gpt-5-codex\"\n"+
				"approval_policy = \"never\"\n"+
				"sandbox_mode = \"workspace-write\"\n"+
				"disable_response_storage = true\n\n"+
				"[otel]\n"+
				"exporter = %q\n",
			slot.ID, slot.Persona.GuestMachineID, otelExporter,
		)
		if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(configTOML), 0o600); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte(authContent+"\n"), 0o600); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(codexDir, "version.json"), []byte("{\"version\":\"0.38.0\",\"channel\":\"stable\"}\n"), 0o600); err != nil {
			return err
		}

	case RuntimeAntigravity:
		agDir := filepath.Join(homeDir, ".antigravity")
		agCfgDir := filepath.Join(homeDir, ".config", "antigravity")
		if err := os.MkdirAll(agDir, 0o700); err != nil {
			return err
		}
		if err := os.MkdirAll(agCfgDir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(agDir, "settings.json"), []byte(settingsContent+"\n"), 0o600); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(agDir, "oauth_creds.json"), []byte(authContent+"\n"), 0o600); err != nil {
			return err
		}
		midPath := filepath.Join(agDir, "machineid")
		if _, statErr := os.Stat(midPath); os.IsNotExist(statErr) {
			if err := os.WriteFile(midPath, []byte(slot.Persona.GuestMachineID+"\n"), 0o600); err != nil {
				return err
			}
			_ = os.Chmod(midPath, 0o444)
		}
		argvJSON, _ := json.MarshalIndent(map[string]any{
			"enable-crash-reporter": false,
			"crash-reporter-id":     slot.Persona.SMBIOSUUID,
			"machine-id":            slot.Persona.GuestMachineID,
		}, "", "  ")
		if err := os.WriteFile(filepath.Join(agCfgDir, "argv.json"), append(argvJSON, '\n'), 0o600); err != nil {
			return err
		}

	default:
		claudeDir := filepath.Join(homeDir, ".claude")
		if err := os.MkdirAll(claudeDir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(claudeDir, "settings.json"), []byte(settingsContent+"\n"), 0o600); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(claudeDir, ".credentials.json"), []byte(authContent+"\n"), 0o600); err != nil {
			return err
		}
		claudeState, _ := json.MarshalIndent(map[string]any{
			"userID":                        userIDHex,
			"hasCompletedOnboarding":        true,
			"bypassPermissionsModeAccepted": true,
		}, "", "  ")
		if err := os.WriteFile(filepath.Join(homeDir, ".claude.json"), append(claudeState, '\n'), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func buildLaunchCommandPreview(slot Slot, rootDir string) string {
	rp := effectiveRuntimeProfile(slot.RuntimeProfile)
	switch slot.Hypervisor {
	case HypervisorKVM:
		return fmt.Sprintf(
			"qemu-system-x86_64 -name slipgate-%s-%s -m %d -smp %d -smbios type=1,uuid=%s,serial=%s -device virtio-net-pci,mac=%s -fw_cfg name=opt/slipgate/machine-id,file=%s",
			rp, slot.ID, slot.MemoryMiB, max(1, slot.Persona.CPUCores), slot.Persona.SMBIOSUUID, slot.Persona.SMBIOSSerial, slot.Persona.MACAddress, filepath.Join(rootDir, "etc", "machine-id"),
		)
	case HypervisorMacOS:
		return fmt.Sprintf("vfkit --cpus %d --memory %d --device virtio-net,mac=%s", max(1, slot.Persona.CPUCores), slot.MemoryMiB, slot.Persona.MACAddress)
	default:
		return fmt.Sprintf(
			"docker run -d --name slipgate-%s --memory %dm --mac-address %s -v %s:/etc/machine-id:ro -v %s:/home/runner -e SLIPGATE_GUEST_MACHINE_ID=%s -e SLIPGATE_RUNTIME_PROFILE=%s",
			slot.ID, slot.MemoryMiB, slot.Persona.MACAddress, filepath.Join(rootDir, "etc", "machine-id"), filepath.Join(rootDir, "home", "runner"), slot.Persona.GuestMachineID, rp,
		)
	}
}

func defaultIfEmpty(val, fallback string) string {
	if strings.TrimSpace(val) == "" {
		return fallback
	}
	return val
}
