package dataplane

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func TestVaultDecryptPlaintextHexRoundtrip(t *testing.T) {
	t.Parallel()

	vault := NewVault("test-vault-secret-0123456789abcdef")
	enc, err := vault.EncryptHex("sk-mod-secret-xyz")
	if err != nil {
		t.Fatalf("EncryptHex failed: %v", err)
	}
	got, err := vault.DecryptPlaintextHex(enc)
	if err != nil {
		t.Fatalf("DecryptPlaintextHex failed: %v", err)
	}
	if got != "sk-mod-secret-xyz" {
		t.Fatalf("expected decrypted plaintext, got %q", got)
	}
}

func TestModerationGateLocalRulesScopingAndPriority(t *testing.T) {
	t.Parallel()

	var gate moderationGate
	gate.Apply(&SyncModerationInput{
		Enabled: true,
		Rules: []SyncModerationRuleInput{
			{
				ID:            "r_log",
				Name:          "Log P2",
				Enabled:       true,
				Kind:          "keyword",
				Pattern:       "auditme, foo",
				CaseSensitive: false,
				Action:        "log_only",
				RejectMessage: "Logged only",
				Priority:      20,
			},
			{
				ID:             "r_block",
				Name:           "Block Secret",
				Enabled:        true,
				Kind:           "regex",
				Pattern:        `secret-[0-9]{4}`,
				CaseSensitive:  false,
				Action:         "block",
				ScopePlatforms: []string{"anthropic"},
				RejectMessage:  "Blocked by regex rule",
				Priority:       10,
			},
			{
				ID:            "r_strike",
				Name:          "Strike Case",
				Enabled:       true,
				Kind:          "keyword",
				Pattern:       "ExactBan",
				CaseSensitive: true,
				Action:        "strike",
				ScopeGroupIDs: []string{"grp_restricted"},
				RejectMessage: "Struck by exact keyword",
				Priority:      5,
			},
		},
	}, nil, false)

	// Priority + group scope match -> strike
	v := gate.Evaluate(context.Background(), "Contains ExactBan and secret-1234", "anthropic", "grp_restricted")
	if v == nil || v.Action != "strike" || v.RuleID != "r_strike" {
		t.Fatalf("expected strike verdict on ExactBan, got %#v", v)
	}

	// Case-sensitive miss in other group + regex platform match
	v = gate.Evaluate(context.Background(), "Contains exactban and SECRET-4242", "anthropic", "grp_default")
	if v == nil || v.Action != "block" || v.RuleID != "r_block" {
		t.Fatalf("expected block verdict for anthropic regex, got %#v", v)
	}

	// Non-matching platform skips anthropic rule and hits log_only rule
	v = gate.Evaluate(context.Background(), "Contains SECRET-4242 and auditme", "openai", "grp_default")
	if v == nil || v.Action != "log_only" || v.RuleID != "r_log" {
		t.Fatalf("expected log_only verdict for openai, got %#v", v)
	}

	// Clean prompt returns nil
	if v := gate.Evaluate(context.Background(), "completely harmless greeting", "openai", "grp_default"); v != nil {
		t.Fatalf("expected nil verdict on clean text, got %#v", v)
	}
}

func TestModerationGateExternalAPIFailOpenFailClosedAndSSRF(t *testing.T) {
	t.Parallel()

	vault := NewVault("moderation-ext-secret-0123456789")
	encKey, err := vault.EncryptHex("mod-bearer-123")
	if err != nil {
		t.Fatalf("EncryptHex failed: %v", err)
	}

	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		input, _ := body["input"].(string)
		w.Header().Set("Content-Type", "application/json")
		if input == "error-me" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"down"}`))
			return
		}
		flagged := input == "flagged content"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{{"flagged": flagged}},
		})
	}))
	defer srv.Close()

	// SSRF guard blocks loopback external moderation when allowPrivate=false
	var ssrfGate moderationGate
	ssrfGate.Apply(&SyncModerationInput{
		Enabled:          true,
		ExternalEnabled:  true,
		ExternalEndpoint: srv.URL,
		ExternalFailOpen: false,
	}, vault, false)
	if v := ssrfGate.Evaluate(context.Background(), "flagged content", "", ""); v == nil || v.Action != "block" {
		t.Fatalf("expected fail-closed SSRF block, got %#v", v)
	}

	// Private allowed -> flags matching response and sends Bearer token
	var gate moderationGate
	gate.Apply(&SyncModerationInput{
		Enabled:              true,
		ExternalEnabled:      true,
		ExternalEndpoint:     srv.URL,
		ExternalAPIKeyEncHex: encKey,
		ExternalModel:        "omni-moderation-latest",
		ExternalTimeoutMs:    2000,
		ExternalFailOpen:     true,
	}, vault, true)

	v := gate.Evaluate(context.Background(), "flagged content", "", "")
	if v == nil || v.Source != "external_api" || v.Action != "block" {
		t.Fatalf("expected external_api block, got %#v", v)
	}
	if gotAuth != "Bearer mod-bearer-123" {
		t.Fatalf("expected Authorization Bearer header, got %q", gotAuth)
	}

	// Upstream 500 with fail_open=true allows request
	if v := gate.Evaluate(context.Background(), "error-me", "", ""); v != nil {
		t.Fatalf("expected fail_open=true to allow on upstream 500, got %#v", v)
	}

	// Upstream 500 with fail_open=false blocks request
	gate.Apply(&SyncModerationInput{
		Enabled:           true,
		ExternalEnabled:   true,
		ExternalEndpoint:  srv.URL,
		ExternalTimeoutMs: 2000,
		ExternalFailOpen:  false,
	}, vault, true)
	if v := gate.Evaluate(context.Background(), "error-me", "", ""); v == nil || v.Action != "block" {
		t.Fatalf("expected fail_open=false to block on upstream 500, got %#v", v)
	}
}

func TestSyncSnapshotForwardsClearedRiskSubjectsAndClearAllToCoreIPC(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	var mu sync.Mutex
	var captured struct {
		ClearedRiskSubjects []string `json:"clearedRiskSubjects"`
		ClearAllRiskBans    bool     `json:"clearAllRiskBans"`
	}
	done := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		frame, err := dpbridge.ReadFrame(conn)
		if err == nil && frame.Type == dpbridge.FrameSyncState {
			inner, uerr := dpbridge.UnwrapAuthPayload(frame.Flags, frame.Payload, "tok-internal-test")
			if uerr == nil {
				mu.Lock()
				_ = json.Unmarshal(inner, &captured)
				mu.Unlock()
			}
			_ = dpbridge.WriteFrame(conn, dpbridge.Frame{
				StreamID: frame.StreamID,
				Type:     dpbridge.FrameSyncAck,
				Flags:    dpbridge.FlagEndStream,
				Payload:  []byte(`{"ok":true}`),
			})
		}
		close(done)
	}()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:       ln.Addr().String(),
		InternalToken: "tok-internal-test",
		VaultSecret:   "vault-secret-0123456789abcdef01",
	})
	_, err = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs:      123456,
		ClearedRiskSubjects: []string{"key_abc"},
		ClearAllRiskBans:    true,
	})
	if err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	<-done

	mu.Lock()
	defer mu.Unlock()
	if !captured.ClearAllRiskBans || !slices.Equal(captured.ClearedRiskSubjects, []string{"key_abc"}) {
		t.Fatalf("unexpected core payload risk unban fields: %+v", captured)
	}
}
