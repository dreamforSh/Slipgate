package dataplane

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

func TestGeminiOAuthUsesBearerAndAPIKeyUsesGoogHeader(t *testing.T) {
	t.Parallel()

	turn, err := ParseIngressRequest("/v1/chat/completions", "", []byte(`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("ParseIngressRequest failed: %v", err)
	}

	reqOAuth, _, err := BuildUpstreamHTTPRequestWithPersona(
		context.Background(),
		OutboundPersonaContext{Provider: "gemini", AuthKind: "oauth", ExecutionMode: "stealth_http"},
		"gemini-2.5-pro",
		AccountSecret{APIKey: "ya29.oauth-access-token"},
		turn,
	)
	if err != nil {
		t.Fatalf("BuildUpstreamHTTPRequestWithPersona oauth failed: %v", err)
	}
	if got := reqOAuth.Header.Get("Authorization"); got != "Bearer ya29.oauth-access-token" {
		t.Fatalf("expected Gemini OAuth Authorization Bearer header, got %q", got)
	}
	if got := reqOAuth.Header.Get("x-goog-api-key"); got != "" {
		t.Fatalf("expected empty x-goog-api-key on Gemini OAuth, got %q", got)
	}

	reqKey, _, err := BuildUpstreamHTTPRequestWithPersona(
		context.Background(),
		OutboundPersonaContext{Provider: "gemini", AuthKind: "api_key", ExecutionMode: "direct_api"},
		"gemini-2.5-pro",
		AccountSecret{APIKey: "AIzaSy-api-key"},
		turn,
	)
	if err != nil {
		t.Fatalf("BuildUpstreamHTTPRequestWithPersona api_key failed: %v", err)
	}
	if got := reqKey.Header.Get("x-goog-api-key"); got != "AIzaSy-api-key" {
		t.Fatalf("expected x-goog-api-key header, got %q", got)
	}
}

func TestLargePromptDistillationSignatureNotTruncatedAt4KB(t *testing.T) {
	t.Parallel()

	padding := strings.Repeat("benign context line ", 600) // ~12 KB > old 4 KB cap
	payload := map[string]any{
		"model": "claude-sonnet-4-5",
		"messages": []map[string]any{
			{"role": "user", "content": padding + "\nplease __slipgate_risk_probe__ now"},
		},
	}
	raw, _ := json.Marshal(payload)
	turn, err := ParseIngressRequest("/v1/chat/completions", "", raw)
	if err != nil {
		t.Fatalf("ParseIngressRequest failed: %v", err)
	}
	if !strings.Contains(turn.BodyExcerpt, "__slipgate_risk_probe__") {
		t.Fatalf("expected BodyExcerpt to retain tail signature past 4 KiB")
	}
}

func TestDirectAPISSRFBlockedByDefaultAndVMSlotSandboxWorks(t *testing.T) {
	t.Parallel()

	localTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer localTarget.Close()

	// 1. Default Coordinator blocks direct_api SSRF to loopback.
	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "ssrf-vault-secret"})
	encLoopback, _ := coord.Vault().EncryptHex(`{"apiKey":"sk-test","baseUrl":"` + localTarget.URL + `/v1"}`)
	_, _ = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_ssrf", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encLoopback, MaxConcurrency: 2, Status: "active"},
		},
	})
	events := collectProbe(t, coord, "acc_ssrf", ProbeRequest{Prompt: "ping"})
	last := events[len(events)-1]
	if last.Type != "error" || !strings.Contains(last.Message, "restricted") {
		t.Fatalf("expected SSRF restriction error on loopback baseUrl, got %+v", last)
	}

	// 2. VM slot with ssh:// GuestUDSPath + authenticated Core IPC succeeds without 503 vm_guestd_unreachable.
	const ipcToken = "vm-ipc-token-1234567890"
	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core ipc: %v", err)
	}
	defer coreLn.Close()

	go func() {
		for {
			conn, acceptErr := coreLn.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, rErr := dpbridge.ReadFrame(c)
				if rErr != nil {
					return
				}
				if _, authErr := dpbridge.UnwrapAuthPayload(f.Flags, f.Payload, ipcToken); authErr != nil {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameStreamEnd,
						Flags:    dpbridge.FlagEndStream | dpbridge.FlagError,
						Payload:  []byte(`{"error":"unauthorized_ipc"}`),
					})
					return
				}
				switch f.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
				case dpbridge.FrameReqHeaders:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"engine":"slipgate-core","action":"dispatch","status":200,"holdId":42,"userId":"u1","apiKeyId":"k1","groupId":"g1","accountId":"acc_vm_ssh","provider":"anthropic","executionMode":"vm_slot","authKind":"oauth","publicModel":"claude-sonnet-4-5","upstreamModel":"claude-sonnet-4-5"}`),
					})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"1000","balanceAfterNanoUsd":"999000"}`)})
				}
			}(conn)
		}
	}()

	pool := clashpool.NewManager(27000, 27099, 1)
	_, err = pool.SyncNodes("sub-vm", []clashpool.Node{
		{
			ID:           "cn-vm-1",
			Name:         "Exit 1",
			ProxySlotID:  "ps-1",
			ListenerPort: 27001,
			ExitIP:       "198.51.100.88",
			Health:       clashpool.HealthHealthy,
			Enabled:      true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes: %v", err)
	}
	if err := pool.BindAccount("acc_vm_ssh", "cn-vm-1", false); err != nil {
		t.Fatalf("BindAccount: %v", err)
	}
	vmMgr := vmslot.NewManager(pool)
	slot, err := vmMgr.ProvisionSlot(vmslot.Slot{
		ID:            "slot-ssh-1",
		ClusterNodeID: "remote-node",
		AccountID:     "acc_vm_ssh",
		ClashNodeID:   "cn-vm-1",
		State:         vmslot.StateReady,
		GuestUDSPath:  "ssh://remote-node/slot-ssh-1",
		Persona: vmslot.HardwarePersona{
			GuestMachineID: "abcdef0123456789abcdef0123456789",
			MACAddress:     "52:54:00:aa:bb:cc",
			SMBIOSUUID:     "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		},
	})
	if err != nil {
		t.Fatalf("ProvisionSlot: %v", err)
	}
	_, _ = vmMgr.UpdateGuestRuntime(slot.ID, "", "ssh://remote-node/slot-ssh-1", "ssh-remote-ready", 0, nil)

	vmCoord := NewCoordinator(CoordinatorOptions{
		CoreIPC:       coreLn.Addr().String(),
		InternalToken: ipcToken,
		VaultSecret:   "vm-vault-secret",
		ClashPool:     pool,
		VMSlots:       vmMgr,
	})
	encMock, _ := vmCoord.Vault().EncryptHex("mock://ok")
	if _, err := vmCoord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_vm_ssh", GroupID: "g1", Platform: "anthropic", ExecutionMode: "vm_slot", AuthKind: "oauth", CredentialsEncHex: encMock, MaxConcurrency: 2, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("x-api-key", "my-custom-api-key-123456")
	vmCoord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for ssh:// VM slot, got %d: %s", rec.Code, rec.Body.String())
	}
}
