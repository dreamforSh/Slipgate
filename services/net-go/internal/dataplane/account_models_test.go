package dataplane

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchAccountModels(t *testing.T) {
	t.Parallel()

	var codexQuery, codexAuth, agBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/models" && r.Header.Get("Authorization") == "Bearer sk-openai":
			_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4.1"},{"id":"gpt-4o-mini"},{"id":"gpt-4.1"}]}`))
		case r.URL.Path == "/v1/models" && r.Header.Get("x-api-key") == "sk-ant-key":
			_, _ = w.Write([]byte(`{"data":[{"id":"claude-sonnet-4-5"}]}`))
		case r.URL.Path == "/v1/models":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad key"}`))
		case r.URL.Path == "/codex/models":
			codexQuery = r.URL.RawQuery
			codexAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"models":[{"slug":"gpt-5-codex"},{"slug":"gpt-5.1-codex-max"}]}`))
		case r.URL.Path == "/v1internal:fetchAvailableModels":
			raw := make([]byte, 256)
			n, _ := r.Body.Read(raw)
			agBody = string(raw[:n])
			_, _ = w.Write([]byte(`{"models":{"gemini-2.5-pro":{},"claude-sonnet-4-5":{}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "models-vault-secret", AllowPrivateUpstreams: true})
	enc := func(v map[string]any) string {
		raw, _ := json.Marshal(v)
		out, err := coord.Vault().EncryptHex(string(raw))
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		return out
	}
	mock, _ := coord.Vault().EncryptHex("mock://ok")
	accounts := []SyncAccountInput{
		{ID: "acc_openai", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc(map[string]any{"api_key": "sk-openai", "base_url": upstream.URL + "/v1"})},
		{ID: "acc_bad", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc(map[string]any{"api_key": "sk-wrong", "base_url": upstream.URL + "/v1"})},
		{ID: "acc_claude", Platform: "anthropic", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc(map[string]any{"api_key": "sk-ant-key", "base_url": upstream.URL})},
		{ID: "acc_codex", Platform: "codex", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: enc(map[string]any{"access_token": "eyJ-codex", "base_url": upstream.URL + "/codex"})},
		{ID: "acc_ag", Platform: "antigravity", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: enc(map[string]any{"access_token": "ya29.ag", "project_id": "proj-9", "base_url": upstream.URL})},
		{ID: "acc_gemini_oauth", Platform: "gemini", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: enc(map[string]any{"access_token": "ya29.gem"})},
		{ID: "acc_bedrock", Platform: "bedrock", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc(map[string]any{"api_key": "x"})},
		{ID: "acc_mock", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: mock},
		{ID: "acc_vm", Platform: "codex", ExecutionMode: "vm_slot", AuthKind: "vm_cli_seed", CredentialsEncHex: mock},
	}
	for i := range accounts {
		accounts[i].GroupID, accounts[i].MaxConcurrency, accounts[i].Status = "g", 1, "active"
	}
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{RevisionUnixMs: 1, Accounts: accounts}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	ctx := context.Background()
	get := func(id string) AccountModelsResult {
		t.Helper()
		res, err := coord.FetchAccountModels(ctx, id)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		return res
	}

	if res := get("acc_openai"); res.Source != "upstream" || strings.Join(res.Models, ",") != "gpt-4.1,gpt-4o-mini" {
		t.Fatalf("openai models = %+v", res)
	}
	if res := get("acc_bad"); res.Source != "default" || !strings.Contains(res.Message, "HTTP 401") {
		t.Fatalf("401 should fall back with the reason, got %+v", res)
	}
	if res := get("acc_claude"); res.Source != "upstream" || strings.Join(res.Models, ",") != "claude-sonnet-4-5" {
		t.Fatalf("anthropic models = %+v", res)
	}
	if res := get("acc_codex"); res.Source != "upstream" || strings.Join(res.Models, ",") != "gpt-5-codex,gpt-5.1-codex-max" {
		t.Fatalf("codex models = %+v", res)
	}
	if !strings.HasPrefix(codexQuery, "client_version=") || codexAuth != "Bearer eyJ-codex" {
		t.Fatalf("codex listing request: query=%q auth=%q", codexQuery, codexAuth)
	}
	if res := get("acc_ag"); res.Source != "upstream" || strings.Join(res.Models, ",") != "claude-sonnet-4-5,gemini-2.5-pro" {
		t.Fatalf("antigravity models = %+v", res)
	}
	if !strings.Contains(agBody, `"project":"proj-9"`) {
		t.Fatalf("antigravity body = %s", agBody)
	}
	for _, id := range []string{"acc_gemini_oauth", "acc_bedrock", "acc_mock"} {
		if res := get(id); res.Source != "default" || len(res.Models) != 0 || res.Message == "" {
			t.Fatalf("%s should answer default with a reason, got %+v", id, res)
		}
	}
	if _, err := coord.FetchAccountModels(ctx, "acc_vm"); !errors.Is(err, ErrAccountModelsUnsupported) {
		t.Fatalf("vm slot: %v", err)
	}
	if _, err := coord.FetchAccountModels(ctx, "acc_missing"); !errors.Is(err, ErrAccountNotSynced) {
		t.Fatalf("missing: %v", err)
	}
}
