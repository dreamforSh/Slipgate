package vmslot

import (
	"bytes"
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

	"golang.org/x/crypto/ssh"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

var safeSegmentRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

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
	guestdBin string

	mu    sync.Mutex
	procs map[string]*exec.Cmd
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

func (d *LocalSlotDriver) GuestdAvailable() bool {
	if d.guestdBin == "" {
		return false
	}
	info, err := os.Stat(d.guestdBin)
	return err == nil && !info.IsDir()
}

func (d *LocalSlotDriver) slotRootDir(slotID string) (string, error) {
	if !safeSegmentRe.MatchString(slotID) || strings.Contains(slotID, "..") {
		return "", fmt.Errorf("%w: unsafe slot id %q", ErrInvalidHardwarePersona, slotID)
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

	if !d.GuestdAvailable() {
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
	cmd := exec.Command(d.guestdBin)
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
	if err := cmd.Start(); err != nil {
		return slot, fmt.Errorf("vmslot: spawn slipgate-guestd: %w", err)
	}

	endpoint := "tcp://" + addr
	pingCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()

	var pingErr error
	for attempt := 0; attempt < 15; attempt++ {
		if pingErr = dpbridge.Ping(pingCtx, endpoint); pingErr == nil {
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
	if strings.ContainsAny(trimmed, ";|&`$><\r\n") {
		return DriverExecResult{
			Stderr:   "permission denied: shell metacharacters are disabled in jailed slot console",
			ExitCode: 1,
		}, nil
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
		return DriverExecResult{
			Stdout: "Built-in jailed commands: help, status, runtime, uname -a, machine-id, persona, seed, env, ls [dir], cat <rel-path>, ping\n",
		}, nil

	case "status":
		return DriverExecResult{
			Stdout: fmt.Sprintf(
				"slot=%s runtime=%s state=%s node=%s (%s) hypervisor=%s exit_ip=%s subagents=%d/%d daemon=%s endpoint=%s\n",
				slot.ID, effectiveRuntimeProfile(slot.RuntimeProfile), slot.State, node.ID, node.Arch, slot.Hypervisor, slot.ExitIP,
				slot.ActiveSubagents, slot.MaxSubagents, defaultIfEmpty(slot.DaemonVersion, "sandbox-ready"), slot.GuestUDSPath,
			),
		}, nil

	case "runtime":
		rp := effectiveRuntimeProfile(slot.RuntimeProfile)
		switch rp {
		case RuntimeCodexCLI:
			return readJailedFile(rootDir, "home/runner/.codex/config.toml", false)
		case RuntimeAntigravity:
			return readJailedFile(rootDir, "home/runner/.antigravity/settings.json", false)
		default:
			return readJailedFile(rootDir, "home/runner/.claude/settings.json", false)
		}

	case "uname":
		return DriverExecResult{
			Stdout: fmt.Sprintf("Linux %s 6.8.0-slipgate #1 SMP PREEMPT_DYNAMIC %s GNU/Linux\n", slot.ID, runtime.GOARCH),
		}, nil

	case "machine-id":
		return readJailedFile(rootDir, "etc/machine-id", false)

	case "persona":
		return readJailedFile(rootDir, "persona.json", false)

	case "seed":
		var out strings.Builder
		fmt.Fprintf(&out, "# telemetryMode=%s rejectClientSettings=%v rejectClientIdentity=%v syncedAt=%d\n",
			seed.TelemetryMode, seed.RejectClientSettings, seed.RejectClientIdentity, seed.SyncedAtUnixMs)
		fmt.Fprintf(&out, "--- settings.json ---\n%s\n--- custom_setting.env ---\n%s\n",
			seed.SettingsJSONRaw, seed.CustomSettingRaw)
		return DriverExecResult{Stdout: out.String()}, nil

	case "env":
		return DriverExecResult{
			Stdout: fmt.Sprintf(
				"SLIPGATE_SLOT_ID=%s\nSLIPGATE_GUEST_MACHINE_ID=%s\nSLIPGATE_CLEANSE_MODE=%s\nSLIPGATE_TELEMETRY_MODE=%s\n%s",
				slot.ID, slot.Persona.GuestMachineID, slot.CleanseMode, slot.Telemetry, redactProxyEnv(seed.ProxyEnvRaw),
			),
		}, nil

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
		return DriverExecResult{
			Stderr:   fmt.Sprintf("unsupported command %q in jailed slot console (type 'help')\n", op),
			ExitCode: 127,
		}, nil
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

// AgentlessSSHDriver provisions and inspects slots over standard OpenSSH without pre-installing a remote daemon.
type AgentlessSSHDriver struct{}

func NewAgentlessSSHDriver() *AgentlessSSHDriver {
	return &AgentlessSSHDriver{}
}

func (d *AgentlessSSHDriver) dialSSH(node ClusterNode) (*ssh.Client, error) {
	if strings.TrimSpace(node.SSHAddr) == "" {
		return nil, errors.New("vmslot: sshAddr is required")
	}
	if strings.TrimSpace(node.SSHKeyPEM) == "" {
		return nil, errors.New("vmslot: ssh private key is required for agentless ssh driver")
	}
	signer, err := ssh.ParsePrivateKey([]byte(node.SSHKeyPEM))
	if err != nil {
		return nil, fmt.Errorf("vmslot: parse ssh private key: %w", err)
	}
	addr := node.SSHAddr
	if _, _, splitErr := net.SplitHostPort(addr); splitErr != nil {
		addr = net.JoinHostPort(addr, "22")
	}
	user := defaultIfEmpty(node.SSHUser, "root")
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // Explicit TOFUless support for dynamic admin-registered cluster nodes.
		Timeout:         10 * time.Second,
	}
	return ssh.Dial("tcp", addr, cfg)
}

func (d *AgentlessSSHDriver) runRemote(ctx context.Context, node ClusterNode, script string) (DriverExecResult, error) {
	client, err := d.dialSSH(node)
	if err != nil {
		return DriverExecResult{}, err
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return DriverExecResult{}, err
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- session.Run(script)
	}()

	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		return DriverExecResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 124}, ctx.Err()
	case runErr := <-done:
		code := 0
		if runErr != nil {
			code = 1
			var exitErr *ssh.ExitError
			if errors.As(runErr, &exitErr) {
				code = exitErr.ExitStatus()
			}
		}
		return DriverExecResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: code}, runErr
	}
}

func (d *AgentlessSSHDriver) MaterializeSlot(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) (Slot, error) {
	slotDir := fmt.Sprintf("/var/lib/slipgate/slots/%s", slot.ID)
	proxyEnv := seed.ProxyEnvRaw
	if proxyEnv == "" && target != nil && target.SOCKSAddr != "" {
		proxyEnv = fmt.Sprintf("ALL_PROXY=socks5h://%s:%s@%s", target.SocksUsername, target.SocksPassword, target.SOCKSAddr)
	}
	rp := effectiveRuntimeProfile(slot.RuntimeProfile)
	runtimeSetup := fmt.Sprintf("mkdir -p %s/home/runner/.claude", slotDir)
	switch rp {
	case RuntimeCodexCLI:
		runtimeSetup = fmt.Sprintf("mkdir -p %s/home/runner/.codex", slotDir)
	case RuntimeAntigravity:
		runtimeSetup = fmt.Sprintf("mkdir -p %s/home/runner/.antigravity %s/home/runner/.config/antigravity && printf '%%s\\n' %q > %s/home/runner/.antigravity/machineid && chmod 444 %s/home/runner/.antigravity/machineid", slotDir, slotDir, slot.Persona.GuestMachineID, slotDir, slotDir)
	}
	script := fmt.Sprintf(
		"set -e; umask 077; mkdir -p %s/etc %s/seed; printf '%%s\\n' %q > %s/etc/machine-id; chmod 444 %s/etc/machine-id; printf '%%s' %q > %s/seed/proxy.env; %s",
		slotDir, slotDir, slot.Persona.GuestMachineID, slotDir, slotDir, proxyEnv, slotDir, runtimeSetup,
	)
	if _, err := d.runRemote(ctx, node, script); err != nil {
		return slot, err
	}
	slot.RootDir = slotDir
	return slot, nil
}

func (d *AgentlessSSHDriver) StartSlot(ctx context.Context, node ClusterNode, slot Slot) (Slot, error) {
	if _, err := d.runRemote(ctx, node, fmt.Sprintf("test -r /var/lib/slipgate/slots/%s/etc/machine-id", slot.ID)); err != nil {
		return slot, err
	}
	now := time.Now().UTC()
	slot.State = StateReady
	slot.DaemonVersion = "ssh-agentless"
	slot.GuestUDSPath = fmt.Sprintf("ssh://%s/var/lib/slipgate/slots/%s", node.SSHAddr, slot.ID)
	slot.LastHeartbeat = &now
	return slot, nil
}

func (d *AgentlessSSHDriver) StopSlot(ctx context.Context, node ClusterNode, slot Slot) error {
	_, err := d.runRemote(ctx, node, fmt.Sprintf("docker stop slipgate-%s >/dev/null 2>&1 || true", slot.ID))
	return err
}

func (d *AgentlessSSHDriver) SyncSeed(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, _ *clashpool.DialTarget) error {
	slotDir := fmt.Sprintf("/var/lib/slipgate/slots/%s", slot.ID)
	script := fmt.Sprintf(
		"mkdir -p %s/seed && printf '%%s' %q > %s/seed/settings.json && printf '%%s' %q > %s/seed/custom_setting.env",
		slotDir, seed.SettingsJSONRaw, slotDir, seed.CustomSettingRaw, slotDir,
	)
	_, err := d.runRemote(ctx, node, script)
	return err
}

func (d *AgentlessSSHDriver) ExecTerminalCommand(ctx context.Context, node ClusterNode, slot Slot, _ SlotSeed, command string) (DriverExecResult, error) {
	if strings.ContainsAny(command, ";|&`$><\r\n") {
		return DriverExecResult{Stderr: "disallowed shell metacharacters", ExitCode: 1}, nil
	}
	res, err := d.runRemote(ctx, node, fmt.Sprintf("cd /var/lib/slipgate/slots/%s && %s", slot.ID, command))
	if err != nil && res.ExitCode == 0 {
		res.ExitCode = 1
	}
	return res, nil
}

func (d *AgentlessSSHDriver) DestroySlot(ctx context.Context, node ClusterNode, slot Slot) error {
	_, err := d.runRemote(ctx, node, fmt.Sprintf("chmod 644 /var/lib/slipgate/slots/%s/etc/machine-id /var/lib/slipgate/slots/%s/home/runner/.antigravity/machineid 2>/dev/null || true; rm -rf /var/lib/slipgate/slots/%s", slot.ID, slot.ID, slot.ID))
	return err
}

func defaultIfEmpty(val, fallback string) string {
	if strings.TrimSpace(val) == "" {
		return fallback
	}
	return val
}
