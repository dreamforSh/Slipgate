package vmslot

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

func TestValidSlotID(t *testing.T) {
	for _, id := range []string{"vm-1a2b3c4d", "a", "Slot_01.b", strings.Repeat("a", 64)} {
		if !ValidSlotID(id) {
			t.Errorf("expected %q to be valid", id)
		}
	}
	for _, id := range []string{"", ".", "..", "../x", "a/b", "a..b", "-rf", "_x", "a b", "a;b", "a'b", strings.Repeat("a", 65)} {
		if ValidSlotID(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

func TestShellQuoteSurvivesShell(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no POSIX sh on PATH")
	}
	for _, s := range []string{"plain", "it's", "$(id)", "`id`", "a\"b", "semi;colon|pipe&", "two\nlines", "''", ""} {
		out, runErr := exec.Command(sh, "-c", "printf %s "+shellQuote(s)).Output()
		if runErr != nil {
			t.Fatalf("sh failed for %q: %v", s, runErr)
		}
		if string(out) != s {
			t.Fatalf("shellQuote(%q) round-tripped to %q", s, out)
		}
	}
}

func TestCleanSlotRelPath(t *testing.T) {
	for rel, want := range map[string]string{"": ".", ".": ".", "seed/proxy.env": "seed/proxy.env", "home/./runner/": "home/runner", "a/../b": "b"} {
		got, err := cleanSlotRelPath(rel)
		if err != nil || got != want {
			t.Errorf("cleanSlotRelPath(%q) = %q, %v; want %q", rel, got, err, want)
		}
	}
	for _, rel := range []string{"/etc/passwd", "..", "../etc", "a/../../etc", `\windows`, `a\..\b`} {
		if _, err := cleanSlotRelPath(rel); err == nil {
			t.Errorf("expected %q to be rejected", rel)
		}
	}
}

func TestNormalizeSSHHostKey(t *testing.T) {
	signer := newTestSigner(t)
	want := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))

	for _, raw := range []string{
		want,
		want + " root@node-1",
		"  " + want + "\n",
		"10.0.0.5 " + want,        // ssh-keyscan output
		"[10.0.0.5]:2222 " + want, // known_hosts with port
	} {
		got, err := NormalizeSSHHostKey(raw)
		if err != nil || got != want {
			t.Errorf("NormalizeSSHHostKey(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "not a key", "ssh-ed25519 !!!"} {
		if _, err := NormalizeSSHHostKey(raw); !errors.Is(err, ErrInvalidSSHHostKey) {
			t.Errorf("expected ErrInvalidSSHHostKey for %q, got %v", raw, err)
		}
	}
	if SSHHostKeyFingerprint(want) != ssh.FingerprintSHA256(signer.PublicKey()) {
		t.Fatal("fingerprint mismatch")
	}
}

func TestSSHHostKeyTrustOnFirstUseThenStrict(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryVmStore()
	driver := NewAgentlessSSHDriver(store.PinClusterNodeHostKey)

	hostA := newTestSigner(t)
	srvA := startRecordingSSHServer(t, hostA)
	node := ClusterNode{ID: "node-ssh", Name: "ssh", DriverKind: "ssh", SSHAddr: srvA.addr, SSHUser: "root", SSHKeyPEM: newClientKeyPEM(t)}
	if err := store.UpsertClusterNode(ctx, node); err != nil {
		t.Fatal(err)
	}

	// First connection pins host A.
	client, err := driver.dialSSH(node)
	if err != nil {
		t.Fatalf("first connect should trust and pin: %v", err)
	}
	client.Close()
	pinned, _ := store.GetClusterNode(ctx, node.ID)
	if pinned.SSHHostKey != authorizedKeyString(hostA.PublicKey()) {
		t.Fatalf("host key not pinned: %q", pinned.SSHHostKey)
	}
	if pinned.SSHHostKeyFingerprint != ssh.FingerprintSHA256(hostA.PublicKey()) {
		t.Fatalf("fingerprint not recorded: %q", pinned.SSHHostKeyFingerprint)
	}

	// Pinned node reconnects to the same host fine.
	if client, err = driver.dialSSH(pinned); err != nil {
		t.Fatalf("reconnect to pinned host failed: %v", err)
	}
	client.Close()

	// A different server behind the same node (MITM or rebuilt host) is refused.
	srvB := startRecordingSSHServer(t, newTestSigner(t))
	impostor := pinned
	impostor.SSHAddr = srvB.addr
	if _, err := driver.dialSSH(impostor); !errors.Is(err, ErrSSHHostKeyMismatch) {
		t.Fatalf("expected ErrSSHHostKeyMismatch, got %v", err)
	}

	// A connection that raced an earlier pin must still compare against the stored key.
	stale := pinned
	stale.SSHHostKey = ""
	stale.SSHAddr = srvB.addr
	if _, err := driver.dialSSH(stale); !errors.Is(err, ErrSSHHostKeyMismatch) {
		t.Fatalf("expected mismatch against the key pinned by an earlier connection, got %v", err)
	}
}

func TestSSHDriverQuotesInputAndSendsSecretsOverStdin(t *testing.T) {
	ctx := context.Background()
	host := newTestSigner(t)
	srv := startRecordingSSHServer(t, host)
	driver := NewAgentlessSSHDriver(nil)
	node := ClusterNode{
		ID: "node-ssh", DriverKind: "ssh", SSHAddr: srv.addr, SSHUser: "root", SSHKeyPEM: newClientKeyPEM(t),
		SSHHostKey: authorizedKeyString(host.PublicKey()),
	}
	slot := Slot{ID: "vm-1", RuntimeProfile: RuntimeAntigravity, Persona: HardwarePersona{GuestMachineID: "0123456789abcdef0123456789abcdef"}}
	target := &clashpool.DialTarget{SOCKSAddr: "127.0.0.1:20001", SocksUsername: "u", SocksPassword: "p'w$(reboot)"}

	if _, err := driver.MaterializeSlot(ctx, node, slot, SlotSeed{}, target); err != nil {
		t.Fatalf("MaterializeSlot: %v", err)
	}
	execs := srv.takeExecs()
	if len(execs) != 2 {
		t.Fatalf("expected setup script + proxy.env write, got %d: %+v", len(execs), execs)
	}
	for _, e := range execs {
		if strings.Contains(e.command, "p'w") || strings.Contains(e.command, "reboot") {
			t.Fatalf("SOCKS password leaked into a remote command line: %q", e.command)
		}
	}
	if !strings.Contains(execs[1].command, "cat > '/var/lib/slipgate/slots/vm-1/seed/proxy.env'") {
		t.Fatalf("proxy.env not written via stdin: %q", execs[1].command)
	}
	if execs[1].stdin != "ALL_PROXY=socks5h://u:p'w$(reboot)@127.0.0.1:20001" {
		t.Fatalf("unexpected proxy.env payload: %q", execs[1].stdin)
	}

	seed := SlotSeed{SettingsJSONRaw: `{"x":"$(id)"}`, CustomSettingRaw: "TOKEN='secret'"}
	if err := driver.SyncSeed(ctx, node, slot, seed, nil); err != nil {
		t.Fatalf("SyncSeed: %v", err)
	}
	execs = srv.takeExecs()
	if len(execs) != 2 || execs[0].stdin != seed.SettingsJSONRaw || execs[1].stdin != seed.CustomSettingRaw {
		t.Fatalf("seed files not streamed over stdin: %+v", execs)
	}
	for _, e := range execs {
		if strings.Contains(e.command, "secret") || strings.Contains(e.command, "$(id)") {
			t.Fatalf("seed content leaked into a remote command line: %q", e.command)
		}
	}
}

func TestSSHConsoleNeverRunsUserCommands(t *testing.T) {
	ctx := context.Background()
	host := newTestSigner(t)
	srv := startRecordingSSHServer(t, host)
	driver := NewAgentlessSSHDriver(nil)
	node := ClusterNode{
		ID: "node-ssh", DriverKind: "ssh", SSHAddr: srv.addr, SSHUser: "root", SSHKeyPEM: newClientKeyPEM(t),
		SSHHostKey: authorizedKeyString(host.PublicKey()),
	}
	slot := Slot{ID: "vm-1"}

	denied := map[string]int{
		`python3 -c "__import__('os').system('id')"`: 127,
		"rm -rf /":             127,
		"cat ../../etc/shadow": 1,
		"ls /root":             1,
		"cat a/../../../etc":   1,
		"uname -a; id":         1,
	}
	for cmd, wantCode := range denied {
		res, err := driver.ExecTerminalCommand(ctx, node, slot, SlotSeed{}, cmd)
		if err != nil || res.ExitCode != wantCode {
			t.Errorf("%q: exit %d err %v, want exit %d", cmd, res.ExitCode, err, wantCode)
		}
	}
	if execs := srv.takeExecs(); len(execs) != 0 {
		t.Fatalf("denied commands reached the node: %+v", execs)
	}

	if _, err := driver.ExecTerminalCommand(ctx, node, slot, SlotSeed{}, "cat seed/proxy.env"); err != nil {
		t.Fatal(err)
	}
	execs := srv.takeExecs()
	if len(execs) != 1 || !strings.Contains(execs[0].command, "'/var/lib/slipgate/slots/vm-1/seed/proxy.env'") {
		t.Fatalf("expected one jailed cat with a quoted path, got %+v", execs)
	}

	if err := driver.DestroySlot(ctx, node, Slot{ID: "../../.."}); !errors.Is(err, ErrInvalidSlotID) {
		t.Fatalf("expected ErrInvalidSlotID for traversal slot id, got %v", err)
	}
	if execs := srv.takeExecs(); len(execs) != 0 {
		t.Fatalf("DestroySlot with a bad id reached the node: %+v", execs)
	}
}

func TestRegisterClusterNodeHostKeyPinning(t *testing.T) {
	ctx := context.Background()
	coord := NewCoordinator(CoordinatorOptions{Store: NewMemoryVmStore(), VMDataDir: t.TempDir()})
	key := authorizedKeyString(newTestSigner(t).PublicKey())

	node, err := coord.RegisterClusterNode(ctx, RegisterClusterNodeInput{ID: "node-a", Name: "a", SSHAddr: "10.0.0.5:22", SSHHostKey: "10.0.0.5 " + key})
	if err != nil {
		t.Fatal(err)
	}
	if node.SSHHostKey != key || node.SSHHostKeyFingerprint == "" {
		t.Fatalf("supplied host key not normalized/stored: %+v", node)
	}

	node, err = coord.RegisterClusterNode(ctx, RegisterClusterNodeInput{ID: "node-a", Name: "a", SSHAddr: "10.0.0.5:22", MaxSlots: 8})
	if err != nil || node.SSHHostKey != key {
		t.Fatalf("re-register on the same address should keep the pin: %q, %v", node.SSHHostKey, err)
	}

	node, err = coord.RegisterClusterNode(ctx, RegisterClusterNodeInput{ID: "node-a", Name: "a", SSHAddr: "10.0.0.9:22"})
	if err != nil || node.SSHHostKey != "" {
		t.Fatalf("a new address should reset the pin: %q, %v", node.SSHHostKey, err)
	}

	if _, err := coord.RegisterClusterNode(ctx, RegisterClusterNodeInput{ID: "node-b", Name: "b", SSHAddr: "10.0.0.6", SSHHostKey: "garbage"}); !errors.Is(err, ErrInvalidSSHHostKey) {
		t.Fatalf("expected ErrInvalidSSHHostKey, got %v", err)
	}
}

func TestProvisionSlotRejectsUnsafeSlotID(t *testing.T) {
	coord := NewCoordinator(CoordinatorOptions{Store: NewMemoryVmStore(), VMDataDir: t.TempDir()})
	for _, id := range []string{".", "../escape", "-rf"} {
		if _, err := coord.ProvisionSlot(context.Background(), ProvisionSlotInput{ID: id, AccountID: "acc-1"}); !errors.Is(err, ErrInvalidSlotID) {
			t.Errorf("slot id %q: expected ErrInvalidSlotID, got %v", id, err)
		}
	}
}

/* ----------------------------- test helpers ----------------------------- */

func newTestSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func newClientKeyPEM(t *testing.T) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(block))
}

type recordedExec struct {
	command string
	stdin   string
}

// recordingSSHServer accepts any client key, records each exec request with its stdin, and
// answers exit status 0 without running anything.
type recordingSSHServer struct {
	addr  string
	mu    sync.Mutex
	execs []recordedExec
}

func (s *recordingSSHServer) takeExecs() []recordedExec {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.execs
	s.execs = nil
	return out
}

func startRecordingSSHServer(t *testing.T, hostKey ssh.Signer) *recordingSSHServer {
	t.Helper()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil },
	}
	cfg.AddHostKey(hostKey)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	srv := &recordingSSHServer{addr: ln.Addr().String()}

	go func() {
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			go srv.serveConn(conn, cfg)
		}
	}()
	return srv
}

func (s *recordingSSHServer) serveConn(conn net.Conn, cfg *ssh.ServerConfig) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		ch, chReqs, acceptErr := newCh.Accept()
		if acceptErr != nil {
			continue
		}
		go s.serveSession(ch, chReqs)
	}
}

func (s *recordingSSHServer) serveSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		if req.Type != "exec" {
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		var payload struct{ Command string }
		if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
			_ = req.Reply(false, nil)
			return
		}
		_ = req.Reply(true, nil)
		stdin, _ := io.ReadAll(ch)
		s.mu.Lock()
		s.execs = append(s.execs, recordedExec{command: payload.Command, stdin: string(stdin)})
		s.mu.Unlock()
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
		return
	}
}

func TestJailedRemoteScriptInShell(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no POSIX sh on PATH")
	}
	root := filepath.ToSlash(t.TempDir())
	slotDir := root + "/slots/vm-1"
	if err := os.MkdirAll(filepath.FromSlash(slotDir+"/seed"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.FromSlash(slotDir+"/seed/proxy.env"), []byte("ALL_PROXY=x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.FromSlash(root+"/outside.txt"), []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(rel string) (string, error) {
		out, runErr := exec.Command(sh, "-c", jailedRemoteScript(slotDir, rel, "cat")).CombinedOutput()
		return string(out), runErr
	}

	if out, err := run("seed/proxy.env"); err != nil || out != "ALL_PROXY=x" {
		t.Fatalf("jailed cat inside slot: %q, %v", out, err)
	}
	if out, err := run("missing"); err == nil || !strings.Contains(out, "no such file") {
		t.Fatalf("missing file should fail: %q, %v", out, err)
	}
	// cleanSlotRelPath blocks this before any script is built; the script must still hold alone.
	if out, err := run("../../outside.txt"); err == nil || strings.Contains(out, "host secret") || !strings.Contains(out, "escapes slot root") {
		t.Fatalf("traversal must be refused by the remote script itself: %q, %v", out, err)
	}
	if symErr := os.Symlink(filepath.FromSlash(root+"/outside.txt"), filepath.FromSlash(slotDir+"/escape")); symErr != nil {
		t.Logf("symlink escape check skipped: %v", symErr)
		return
	}
	if out, err := run("escape"); err == nil || strings.Contains(out, "host secret") || !strings.Contains(out, "escapes slot root") {
		t.Fatalf("symlink escape must be refused: %q, %v", out, err)
	}
}
