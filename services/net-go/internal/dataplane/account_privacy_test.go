package dataplane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestSetAccountPrivacy(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var seen []string
	chatgptStatus := http.StatusOK
	cfChallenge := false
	agTelemetryKept := false

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery+" auth="+r.Header.Get("Authorization")+" body="+string(body))
		status, cf, kept := chatgptStatus, cfChallenge, agTelemetryKept
		mu.Unlock()
		switch {
		case r.URL.Path == "/backend-api/settings/account_user_setting":
			if cf {
				w.Header().Set("cf-mitigated", "challenge")
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, "<html>Just a moment...</html>")
				return
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"success":true}`)
		case r.URL.Path == "/v1internal:setUserSettings":
			_, _ = io.WriteString(w, `{"userSettings":{}}`)
		case r.URL.Path == "/v1internal:fetchUserInfo":
			if kept {
				_, _ = io.WriteString(w, `{"userSettings":{"telemetryEnabled":true}}`)
				return
			}
			_, _ = io.WriteString(w, `{"regionCode":"US"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "privacy-vault-secret", AllowPrivateUpstreams: true})
	coord.privacyBaseURLForTest = upstream.URL
	enc := func(v map[string]any) string {
		raw, _ := json.Marshal(v)
		out, err := coord.Vault().EncryptHex(string(raw))
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		return out
	}
	codexCred := enc(map[string]any{"access_token": "eyJ-codex-at", "chatgpt_account_id": "acct_1"})
	agCred := enc(map[string]any{"access_token": "ya29.ag", "project_id": "proj-123"})
	agNoProject := enc(map[string]any{"access_token": "ya29.ag2"})
	keyCred := enc(map[string]any{"api_key": "sk-plain"})
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_codex", GroupID: "g", Platform: "codex", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: codexCred, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_ag", GroupID: "g", Platform: "antigravity", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: agCred, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_ag_noproj", GroupID: "g", Platform: "antigravity", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: agNoProject, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_key", GroupID: "g", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: keyCred, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_claude", GroupID: "g", Platform: "anthropic", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: codexCred, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_vm", GroupID: "g", Platform: "codex", ExecutionMode: "vm_slot", AuthKind: "oauth", CredentialsEncHex: codexCred, MaxConcurrency: 1, Status: "active"},
			{ID: "acc_stealth", GroupID: "g", Platform: "codex", ExecutionMode: "stealth_http", AuthKind: "oauth", CredentialsEncHex: codexCred, MaxConcurrency: 1, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	ctx := context.Background()

	res, err := coord.SetAccountPrivacy(ctx, "acc_codex")
	if err != nil || res.Mode != PrivacyModeTrainingOff {
		t.Fatalf("codex privacy = %+v, %v", res, err)
	}
	mu.Lock()
	first := seen[0]
	mu.Unlock()
	if !strings.HasPrefix(first, "PATCH /backend-api/settings/account_user_setting?") ||
		!strings.Contains(first, "feature=training_allowed") || !strings.Contains(first, "value=false") ||
		!strings.Contains(first, "auth=Bearer eyJ-codex-at") {
		t.Fatalf("unexpected ChatGPT privacy request: %s", first)
	}

	mu.Lock()
	cfChallenge = true
	mu.Unlock()
	if res, _ := coord.SetAccountPrivacy(ctx, "acc_codex"); res.Mode != PrivacyModeTrainingCFBlocked {
		t.Fatalf("cloudflare challenge -> %+v", res)
	}
	mu.Lock()
	cfChallenge, chatgptStatus = false, http.StatusUnauthorized
	mu.Unlock()
	if res, _ := coord.SetAccountPrivacy(ctx, "acc_codex"); res.Mode != PrivacyModeTrainingFailed || res.Status != http.StatusUnauthorized {
		t.Fatalf("401 -> %+v", res)
	}

	if res, err := coord.SetAccountPrivacy(ctx, "acc_ag"); err != nil || res.Mode != PrivacyModePrivacySet {
		t.Fatalf("antigravity privacy = %+v, %v", res, err)
	}
	mu.Lock()
	agCalls := strings.Join(seen, "\n")
	agTelemetryKept = true
	mu.Unlock()
	if !strings.Contains(agCalls, `POST /v1internal:setUserSettings? auth=Bearer ya29.ag body={"user_settings":{}}`) ||
		!strings.Contains(agCalls, `POST /v1internal:fetchUserInfo? auth=Bearer ya29.ag body={"project":"proj-123"}`) {
		t.Fatalf("unexpected Antigravity privacy calls:\n%s", agCalls)
	}
	if res, _ := coord.SetAccountPrivacy(ctx, "acc_ag"); res.Mode != PrivacyModePrivacyFailed {
		t.Fatalf("telemetry kept -> %+v", res)
	}
	if res, _ := coord.SetAccountPrivacy(ctx, "acc_ag_noproj"); res.Mode != PrivacyModePrivacyFailed || !strings.Contains(res.Message, "project") {
		t.Fatalf("missing project -> %+v", res)
	}

	for _, id := range []string{"acc_key", "acc_claude", "acc_vm"} {
		if _, err := coord.SetAccountPrivacy(ctx, id); !errors.Is(err, ErrPrivacyUnsupported) {
			t.Fatalf("%s: expected ErrPrivacyUnsupported, got %v", id, err)
		}
	}
	if _, err := coord.SetAccountPrivacy(ctx, "acc_missing"); !errors.Is(err, ErrPrivacyAccountNotSynced) {
		t.Fatalf("missing account: %v", err)
	}
	// stealth_http without a stealth dialer fails closed instead of going direct.
	if res, err := coord.SetAccountPrivacy(ctx, "acc_stealth"); err != nil || res.Mode != PrivacyModeTrainingFailed {
		t.Fatalf("stealth without dialer -> %+v, %v", res, err)
	}
}
