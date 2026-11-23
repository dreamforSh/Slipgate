package vmslot

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestClusterNodeNeverSerializesSSHPrivateKey(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := NewMemoryVmStore()
	pem := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----"

	err := store.UpsertClusterNode(ctx, ClusterNode{
		ID:         "node-ssh-1",
		Name:       "Worker 1",
		DriverKind: "ssh",
		SSHAddr:    "203.0.113.10:22",
		SSHUser:    "root",
		SSHKeyPEM:  pem,
		Arch:       "amd64",
		MaxSlots:   8,
	})
	if err != nil {
		t.Fatalf("UpsertClusterNode failed: %v", err)
	}

	listed, err := store.ListClusterNodes(ctx)
	if err != nil || len(listed) != 1 {
		t.Fatalf("ListClusterNodes failed: %v len=%d", err, len(listed))
	}
	if listed[0].SSHKeyPEM != "" {
		t.Fatalf("ListClusterNodes leaked SSHKeyPEM in struct")
	}
	if !listed[0].HasSSHKey {
		t.Fatalf("expected HasSSHKey=true")
	}

	single, err := store.GetClusterNode(ctx, "node-ssh-1")
	if err != nil {
		t.Fatalf("GetClusterNode failed: %v", err)
	}
	if single.SSHKeyPEM != pem {
		t.Fatalf("expected GetClusterNode to retain SSHKeyPEM in memory for SSH driver")
	}
	rawJSON, err := json.Marshal(single)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	if strings.Contains(string(rawJSON), "PRIVATE KEY") || strings.Contains(string(rawJSON), "sshKeyPem") {
		t.Fatalf("json.Marshal(ClusterNode) leaked SSH private key: %s", string(rawJSON))
	}
}

func TestRedactSeedForAPIAndRestoredSlotReset(t *testing.T) {
	t.Parallel()

	seed := SlotSeed{
		SlotID:           "slot-1",
		RuntimeProfile:   RuntimeClaudeCode,
		SettingsJSONRaw:  `{"cleanupPeriodDays":30}`,
		AuthJSONRaw:      `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-secret"}}`,
		ProxyEnvRaw:      "HTTP_PROXY=socks5h://sguser:supersecret@127.0.0.1:20001\n",
		SyncedAtUnixMs:   1700000000000,
	}
	redacted := RedactSeedForAPI(seed)
	if redacted.AuthJSONRaw != "" || !redacted.HasAuthJSON {
		t.Fatalf("expected AuthJSONRaw stripped and HasAuthJSON=true, got %+v", redacted)
	}
	if strings.Contains(redacted.ProxyEnvRaw, "supersecret") || !strings.Contains(redacted.ProxyEnvRaw, "sguser:***@") {
		t.Fatalf("expected ProxyEnvRaw password redacted, got %q", redacted.ProxyEnvRaw)
	}

	mgr := NewManager(nil)
	mgr.UpsertRestoredSlot(Slot{
		ID:              "slot-wedged",
		AccountID:       "acc-1",
		ClashNodeID:     "node-1",
		State:           StateReady,
		ActiveSubagents: 20,
		MaxSubagents:    20,
		GuestPID:        99999,
		GuestUDSPath:    "tcp://127.0.0.1:59999",
		Persona: HardwarePersona{
			GuestMachineID: "0123456789abcdef0123456789abcdef",
			MACAddress:     "52:54:00:12:34:56",
			SMBIOSUUID:     "11111111-2222-3333-4444-555555555555",
		},
	})
	restored, ok := mgr.GetSlot("slot-wedged")
	if !ok {
		t.Fatalf("expected restored slot")
	}
	if restored.ActiveSubagents != 0 || restored.GuestPID != 0 || restored.GuestUDSPath != "sandbox://slot-wedged" {
		t.Fatalf("expected stale ActiveSubagents and dead tcp GuestPID reset, got %+v", restored)
	}
}
