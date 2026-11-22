package dataplane

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

func collectProbe(t *testing.T, coord *Coordinator, accountID string, req ProbeRequest) []ProbeEvent {
	t.Helper()
	var events []ProbeEvent
	coord.ProbeAccount(context.Background(), accountID, req, func(ev ProbeEvent) {
		events = append(events, ev)
	})
	if len(events) == 0 {
		t.Fatalf("probe %s emitted no events", accountID)
	}
	return events
}

func probeText(events []ProbeEvent) string {
	var sb strings.Builder
	for _, ev := range events {
		if ev.Type == "delta" {
			sb.WriteString(ev.Text)
		}
	}
	return sb.String()
}

func TestProbeAccountStreamsThroughOutboundPath(t *testing.T) {
	var gotAuth, gotModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		w.Header().Set("Content-Type", "text/event-stream")
		for _, piece := range []string{"Hel", "lo"} {
			fmt.Fprintf(w, "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}]}\n\n", piece)
		}
		fmt.Fprint(w, "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "probe-vault-secret"})
	encReal, _ := coord.Vault().EncryptHex(fmt.Sprintf(`{"apiKey":"sk-probe-real","baseUrl":%q}`, upstream.URL+"/v1"))
	encOK, _ := coord.Vault().EncryptHex("mock://ok")
	enc400, _ := coord.Vault().EncryptHex("mock://400")
	encStealth, _ := coord.Vault().EncryptHex(`{"apiKey":"sk-ant-x","baseUrl":"https://api.anthropic.com"}`)
	encVM, _ := coord.Vault().EncryptHex("mock://ok")

	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp", Platform: "composite", SubscriptionType: "balance", RateMultiplier: 1, Enabled: true}},
		Accounts: []SyncAccountInput{
			{ID: "acc_real", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encReal, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_ok", GroupID: "grp", Platform: "anthropic", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encOK, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_400", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc400, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_stealth", GroupID: "grp", Platform: "anthropic", ExecutionMode: "stealth_http", AuthKind: "oauth", CredentialsEncHex: encStealth, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_vm", GroupID: "grp", Platform: "antigravity", ExecutionMode: "vm_slot", AuthKind: "vm_cli_seed", CredentialsEncHex: encVM, MaxConcurrency: 2, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot failed: %v", err)
	}

	t.Run("real upstream over direct_api streams deltas and usage", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_real", ProbeRequest{Prompt: "ping"})
		if events[0].Type != "start" || events[0].Model != DefaultProbeModel("openai") {
			t.Fatalf("expected start with default model, got %+v", events[0])
		}
		if got := probeText(events); got != "Hello" {
			t.Fatalf("expected streamed text %q, got %q (events %+v)", "Hello", got, events)
		}
		done := events[len(events)-1]
		if done.Type != "done" || !done.Success || done.Status != http.StatusOK {
			t.Fatalf("expected successful done, got %+v", done)
		}
		if done.TTFTMs <= 0 {
			t.Fatalf("expected TTFT to be recorded, got %+v", done)
		}
		if gotAuth != "Bearer sk-probe-real" {
			t.Fatalf("upstream did not receive the account credential, got %q", gotAuth)
		}
		if gotModel != DefaultProbeModel("openai") {
			t.Fatalf("upstream got model %q", gotModel)
		}
	})

	t.Run("custom model is forwarded", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_real", ProbeRequest{Model: "gpt-4.1-mini"})
		if events[0].Model != "gpt-4.1-mini" || gotModel != "gpt-4.1-mini" {
			t.Fatalf("custom model not used: start=%+v upstream=%q", events[0], gotModel)
		}
	})

	t.Run("mock success", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_ok", ProbeRequest{})
		done := events[len(events)-1]
		if !done.Success || !strings.Contains(probeText(events), "Slipgate verified response") {
			t.Fatalf("expected mock success, got %+v", events)
		}
	})

	t.Run("upstream error is reported in done", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_400", ProbeRequest{})
		done := events[len(events)-1]
		if done.Type != "done" || done.Success || done.Status != http.StatusBadRequest {
			t.Fatalf("expected failed done with 400, got %+v", done)
		}
		if !strings.Contains(done.Message, "mock ordinary upstream 400") {
			t.Fatalf("expected upstream error message, got %q", done.Message)
		}
	})

	t.Run("stealth account without dialer fails closed", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_stealth", ProbeRequest{})
		last := events[len(events)-1]
		if last.Type != "error" || last.Code != "outbound_dispatch_failed" {
			t.Fatalf("expected outbound_dispatch_failed, got %+v", events)
		}
	})

	t.Run("stealth account without an exit binding reports egress_unavailable", func(t *testing.T) {
		pooled := NewCoordinator(CoordinatorOptions{
			VaultSecret: "probe-vault-secret",
			ClashPool:   clashpool.NewManager(26000, 26999, 1),
		})
		enc, _ := pooled.Vault().EncryptHex(`{"apiKey":"sk-ant-x","baseUrl":"https://api.anthropic.com"}`)
		if _, err := pooled.SyncSnapshot(context.Background(), SyncSnapshot{
			RevisionUnixMs: 1,
			Accounts: []SyncAccountInput{
				{ID: "acc_unbound", GroupID: "grp", Platform: "anthropic", ExecutionMode: "stealth_http", AuthKind: "oauth", CredentialsEncHex: enc, MaxConcurrency: 1, Status: "active"},
			},
		}); err != nil {
			t.Fatalf("SyncSnapshot failed: %v", err)
		}
		events := collectProbe(t, pooled, "acc_unbound", ProbeRequest{})
		last := events[len(events)-1]
		if last.Type != "error" || last.Code != "egress_unavailable" {
			t.Fatalf("expected egress_unavailable, got %+v", events)
		}
	})

	t.Run("vm slot and unknown accounts are rejected", func(t *testing.T) {
		if ev := collectProbe(t, coord, "acc_vm", ProbeRequest{}); ev[0].Type != "error" || ev[0].Code != "vm_slot_unsupported" {
			t.Fatalf("expected vm_slot_unsupported, got %+v", ev)
		}
		if ev := collectProbe(t, coord, "acc_missing", ProbeRequest{}); ev[0].Type != "error" || ev[0].Code != "account_not_synced" {
			t.Fatalf("expected account_not_synced, got %+v", ev)
		}
	})
}
