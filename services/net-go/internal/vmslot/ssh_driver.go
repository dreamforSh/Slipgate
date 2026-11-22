package vmslot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

// sshSlotsRoot is where the agentless SSH driver materializes slots on remote nodes.
const sshSlotsRoot = "/var/lib/slipgate/slots"

var (
	// ErrSSHHostKeyMismatch means a node presented a host key other than the pinned one.
	ErrSSHHostKeyMismatch = errors.New("vmslot: ssh host key mismatch")
	// ErrInvalidSSHHostKey means an admin-supplied host key could not be parsed.
	ErrInvalidSSHHostKey = errors.New("vmslot: invalid ssh host key")
)

// HostKeyPinner records the first host key seen for a node (trust on first use) and returns the
// key pinned afterwards, which differs from authorizedKey when another connection pinned first.
type HostKeyPinner func(ctx context.Context, nodeID, authorizedKey string) (string, error)

// AgentlessSSHDriver provisions and inspects slots over standard OpenSSH without pre-installing a
// remote daemon. Every value placed in a remote script is shell-quoted, secrets travel over stdin
// rather than the command line, and node host keys are pinned on first use.
type AgentlessSSHDriver struct {
	pinHostKey HostKeyPinner
}

func NewAgentlessSSHDriver(pin HostKeyPinner) *AgentlessSSHDriver {
	return &AgentlessSSHDriver{pinHostKey: pin}
}

// NormalizeSSHHostKey accepts an authorized_keys line ("ssh-ed25519 AAAA… comment") or a
// known_hosts / ssh-keyscan line ("host ssh-ed25519 AAAA…") and returns the canonical
// "<type> <base64>" form stored on the node.
func NormalizeSSHHostKey(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("%w: empty", ErrInvalidSSHHostKey)
	}
	if key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(trimmed)); err == nil {
		return authorizedKeyString(key), nil
	}
	if _, _, key, _, _, err := ssh.ParseKnownHosts([]byte(trimmed)); err == nil {
		return authorizedKeyString(key), nil
	}
	return "", fmt.Errorf("%w: expected an authorized_keys or ssh-keyscan line", ErrInvalidSSHHostKey)
}

// SSHHostKeyFingerprint returns the SHA256 fingerprint of a stored host key, or "" if unreadable.
func SSHHostKeyFingerprint(authorizedKey string) string {
	if strings.TrimSpace(authorizedKey) == "" {
		return ""
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(authorizedKey))
	if err != nil {
		return ""
	}
	return ssh.FingerprintSHA256(key)
}

func authorizedKeyString(key ssh.PublicKey) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}

// hostKeyAlgorithmsFor makes the server present the pinned key type, so a host that also has
// keys of other types is not mistaken for a mismatch.
func hostKeyAlgorithmsFor(key ssh.PublicKey) []string {
	if key.Type() == ssh.KeyAlgoRSA {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	}
	return []string{key.Type()}
}

func checkPinnedHostKey(nodeID, pinned string, offered ssh.PublicKey) error {
	want, _, _, _, err := ssh.ParseAuthorizedKey([]byte(pinned))
	if err != nil {
		return fmt.Errorf("%w: pinned key for node %s is unreadable: %v", ErrInvalidSSHHostKey, nodeID, err)
	}
	if !bytes.Equal(want.Marshal(), offered.Marshal()) {
		return fmt.Errorf("%w for node %s: pinned %s, offered %s; if the server was rebuilt, re-register the node with its new host key",
			ErrSSHHostKeyMismatch, nodeID, ssh.FingerprintSHA256(want), ssh.FingerprintSHA256(offered))
	}
	return nil
}

func (d *AgentlessSSHDriver) hostKeyCallback(node ClusterNode) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, offered ssh.PublicKey) error {
		pinned := strings.TrimSpace(node.SSHHostKey)
		if pinned == "" {
			if d.pinHostKey == nil {
				return fmt.Errorf("%w: node %s has no pinned host key", ErrSSHHostKeyMismatch, node.ID)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var err error
			if pinned, err = d.pinHostKey(ctx, node.ID, authorizedKeyString(offered)); err != nil {
				return fmt.Errorf("vmslot: pin ssh host key for node %s: %w", node.ID, err)
			}
		}
		return checkPinnedHostKey(node.ID, pinned, offered)
	}
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
	cfg := &ssh.ClientConfig{
		User:            defaultIfEmpty(node.SSHUser, "root"),
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: d.hostKeyCallback(node),
		Timeout:         10 * time.Second,
	}
	if pinned := strings.TrimSpace(node.SSHHostKey); pinned != "" {
		if key, _, _, _, parseErr := ssh.ParseAuthorizedKey([]byte(pinned)); parseErr == nil {
			cfg.HostKeyAlgorithms = hostKeyAlgorithmsFor(key)
		}
	}
	return ssh.Dial("tcp", addr, cfg)
}

func (d *AgentlessSSHDriver) withClient(node ClusterNode, fn func(*ssh.Client) error) error {
	client, err := d.dialSSH(node)
	if err != nil {
		return err
	}
	defer client.Close()
	return fn(client)
}

func (d *AgentlessSSHDriver) runRemote(ctx context.Context, node ClusterNode, script string) (DriverExecResult, error) {
	var res DriverExecResult
	err := d.withClient(node, func(client *ssh.Client) error {
		var runErr error
		res, runErr = runSSHSession(ctx, client, script, nil)
		return runErr
	})
	return res, err
}

// runSSHSession runs script in a new session, feeding stdin when non-nil.
func runSSHSession(ctx context.Context, client *ssh.Client, script string, stdin []byte) (DriverExecResult, error) {
	session, err := client.NewSession()
	if err != nil {
		return DriverExecResult{}, err
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if stdin != nil {
		session.Stdin = bytes.NewReader(stdin)
	}

	done := make(chan error, 1)
	go func() {
		done <- session.Run(script)
	}()

	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
		select {
		case <-done:
			// Run has returned, so its output copiers are finished with the buffers.
			return DriverExecResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 124}, ctx.Err()
		case <-time.After(5 * time.Second):
			// The session goroutine may still be writing; leave the buffers alone.
			return DriverExecResult{ExitCode: 124}, ctx.Err()
		}
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

// writeRemoteFile streams data into a 0600 file over stdin, so secrets never show up in the
// remote process list.
func writeRemoteFile(ctx context.Context, client *ssh.Client, filePath string, data []byte) error {
	script := "umask 077 && mkdir -p " + shellQuote(path.Dir(filePath)) + " && cat > " + shellQuote(filePath)
	if data == nil {
		data = []byte{}
	}
	_, err := runSSHSession(ctx, client, script, data)
	return err
}

// shellQuote makes s a single literal word for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func sshSlotDir(slotID string) (string, error) {
	if !ValidSlotID(slotID) {
		return "", fmt.Errorf("%w: %q", ErrInvalidSlotID, slotID)
	}
	return sshSlotsRoot + "/" + slotID, nil
}

// cleanSlotRelPath validates a console path argument as relative and inside the slot root.
func cleanSlotRelPath(rel string) (string, error) {
	if rel == "" {
		rel = "."
	}
	if strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) || strings.Contains(rel, `\`) {
		return "", errors.New("access denied: absolute host paths outside slot root are blocked")
	}
	cleaned := path.Clean(rel)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("access denied: path traversal outside slot root is blocked")
	}
	return cleaned, nil
}

// jailedRemoteScript resolves rel inside slotDir on the remote host (following symlinks) and runs
// action on the resolved path only if it stays inside the slot root.
func jailedRemoteScript(slotDir, rel, action string) string {
	return fmt.Sprintf(
		`r=$(readlink -f %s) && p=$(readlink -f %s) && [ -e "$p" ] || { echo 'no such file or directory' >&2; exit 1; }; `+
			`case "$p" in "$r"|"$r"/*) ;; *) echo 'access denied: path escapes slot root' >&2; exit 1;; esac; %s "$p"`,
		shellQuote(slotDir), shellQuote(slotDir+"/"+rel), action,
	)
}

func (d *AgentlessSSHDriver) MaterializeSlot(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, target *clashpool.DialTarget) (Slot, error) {
	slotDir, err := sshSlotDir(slot.ID)
	if err != nil {
		return slot, err
	}
	proxyEnv := seed.ProxyEnvRaw
	if proxyEnv == "" && target != nil && target.SOCKSAddr != "" {
		proxyEnv = fmt.Sprintf("ALL_PROXY=socks5h://%s:%s@%s", target.SocksUsername, target.SocksPassword, target.SOCKSAddr)
	}

	machineIDFile := slotDir + "/etc/machine-id"
	steps := []string{
		"set -e",
		"umask 077",
		"mkdir -p " + shellQuote(slotDir+"/etc") + " " + shellQuote(slotDir+"/seed"),
		"printf '%s\\n' " + shellQuote(slot.Persona.GuestMachineID) + " > " + shellQuote(machineIDFile),
		"chmod 444 " + shellQuote(machineIDFile),
	}
	switch effectiveRuntimeProfile(slot.RuntimeProfile) {
	case RuntimeCodexCLI:
		steps = append(steps, "mkdir -p "+shellQuote(slotDir+"/home/runner/.codex"))
	case RuntimeAntigravity:
		agMachineID := slotDir + "/home/runner/.antigravity/machineid"
		steps = append(steps,
			"mkdir -p "+shellQuote(slotDir+"/home/runner/.antigravity")+" "+shellQuote(slotDir+"/home/runner/.config/antigravity"),
			"printf '%s\\n' "+shellQuote(slot.Persona.GuestMachineID)+" > "+shellQuote(agMachineID),
			"chmod 444 "+shellQuote(agMachineID),
		)
	default:
		steps = append(steps, "mkdir -p "+shellQuote(slotDir+"/home/runner/.claude"))
	}

	err = d.withClient(node, func(client *ssh.Client) error {
		if _, runErr := runSSHSession(ctx, client, strings.Join(steps, "; "), nil); runErr != nil {
			return runErr
		}
		return writeRemoteFile(ctx, client, slotDir+"/seed/proxy.env", []byte(proxyEnv))
	})
	if err != nil {
		return slot, err
	}
	slot.RootDir = slotDir
	return slot, nil
}

func (d *AgentlessSSHDriver) StartSlot(ctx context.Context, node ClusterNode, slot Slot) (Slot, error) {
	slotDir, err := sshSlotDir(slot.ID)
	if err != nil {
		return slot, err
	}
	if _, err := d.runRemote(ctx, node, "test -r "+shellQuote(slotDir+"/etc/machine-id")); err != nil {
		return slot, err
	}
	now := time.Now().UTC()
	slot.State = StateReady
	slot.DaemonVersion = "ssh-agentless"
	slot.GuestUDSPath = fmt.Sprintf("ssh://%s%s", node.SSHAddr, slotDir)
	slot.LastHeartbeat = &now
	return slot, nil
}

func (d *AgentlessSSHDriver) StopSlot(ctx context.Context, node ClusterNode, slot Slot) error {
	if _, err := sshSlotDir(slot.ID); err != nil {
		return err
	}
	_, err := d.runRemote(ctx, node, "docker stop "+shellQuote("slipgate-"+slot.ID)+" >/dev/null 2>&1 || true")
	return err
}

func (d *AgentlessSSHDriver) SyncSeed(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, _ *clashpool.DialTarget) error {
	slotDir, err := sshSlotDir(slot.ID)
	if err != nil {
		return err
	}
	return d.withClient(node, func(client *ssh.Client) error {
		if err := writeRemoteFile(ctx, client, slotDir+"/seed/settings.json", []byte(seed.SettingsJSONRaw)); err != nil {
			return err
		}
		return writeRemoteFile(ctx, client, slotDir+"/seed/custom_setting.env", []byte(seed.CustomSettingRaw))
	})
}

// ExecTerminalCommand serves the same jailed console commands as LocalSlotDriver. Nothing typed
// by the user is ever executed as a command on the node: only fixed scripts with quoted paths.
func (d *AgentlessSSHDriver) ExecTerminalCommand(ctx context.Context, node ClusterNode, slot Slot, seed SlotSeed, command string) (DriverExecResult, error) {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return DriverExecResult{}, nil
	}
	if strings.ContainsAny(trimmed, consoleDeniedChars) {
		return consoleMetacharDenied(), nil
	}
	slotDir, err := sshSlotDir(slot.ID)
	if err != nil {
		return DriverExecResult{Stderr: err.Error() + "\n", ExitCode: 1}, nil
	}

	fields := strings.Fields(trimmed)
	remote := func(script string, redact bool) (DriverExecResult, error) {
		res, runErr := d.runRemote(ctx, node, script)
		if runErr != nil && res.ExitCode == 0 {
			res.ExitCode = 1
			if res.Stderr == "" {
				res.Stderr = runErr.Error() + "\n"
			}
		}
		if redact {
			res.Stdout = redactProxyEnv(res.Stdout)
		}
		return res, nil
	}
	jailed := func(rel, action string, redact bool) (DriverExecResult, error) {
		cleaned, relErr := cleanSlotRelPath(rel)
		if relErr != nil {
			return DriverExecResult{Stderr: relErr.Error() + "\n", ExitCode: 1}, nil
		}
		return remote(jailedRemoteScript(slotDir, cleaned, action), redact)
	}

	switch fields[0] {
	case "help":
		return DriverExecResult{Stdout: consoleHelpText}, nil
	case "status":
		return DriverExecResult{Stdout: consoleStatusLine(node, slot)}, nil
	case "seed":
		return DriverExecResult{Stdout: consoleSeedSummary(seed)}, nil
	case "env":
		return DriverExecResult{Stdout: consoleEnvSummary(slot, seed)}, nil
	case "persona":
		personaBytes, _ := json.MarshalIndent(slot.Persona, "", "  ")
		return DriverExecResult{Stdout: string(personaBytes) + "\n"}, nil
	case "uname":
		return remote("uname -a", false)
	case "machine-id":
		return jailed("etc/machine-id", "cat", false)
	case "runtime":
		return jailed(runtimeSettingsRelPath(slot), "cat", false)
	case "ping":
		res, _ := remote("test -r "+shellQuote(slotDir+"/etc/machine-id"), false)
		if res.ExitCode != 0 {
			return DriverExecResult{Stderr: "ssh ping failed: " + strings.TrimSpace(res.Stderr) + "\n", ExitCode: 1}, nil
		}
		return DriverExecResult{Stdout: fmt.Sprintf("PONG ssh-agentless node=%s slot=%s machine_id=%s\n", node.ID, slot.ID, slot.Persona.GuestMachineID)}, nil
	case "ls":
		rel := "."
		if len(fields) > 1 {
			rel = fields[1]
		}
		return jailed(rel, "ls -1Ap", false)
	case "cat":
		if len(fields) < 2 {
			return DriverExecResult{Stderr: "usage: cat <relative-path>\n", ExitCode: 1}, nil
		}
		rel := fields[1]
		if rel == "/etc/machine-id" {
			rel = "etc/machine-id"
		}
		return jailed(rel, "cat", strings.Contains(strings.ToLower(rel), "proxy"))
	default:
		return consoleUnsupported(fields[0]), nil
	}
}

func (d *AgentlessSSHDriver) DestroySlot(ctx context.Context, node ClusterNode, slot Slot) error {
	slotDir, err := sshSlotDir(slot.ID)
	if err != nil {
		return err
	}
	script := "chmod 644 " + shellQuote(slotDir+"/etc/machine-id") + " " + shellQuote(slotDir+"/home/runner/.antigravity/machineid") +
		" 2>/dev/null || true; rm -rf -- " + shellQuote(slotDir)
	_, err = d.runRemote(ctx, node, script)
	return err
}
