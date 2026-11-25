package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func TestMatchTempUnschedRule(t *testing.T) {
	t.Parallel()
	rules := []TempUnschedRule{
		{StatusCode: 400, Keywords: []string{"Organization has been disabled"}, DurationMinutes: 1440, Description: "org disabled"},
		{StatusCode: 0, Keywords: []string{"overloaded", "  "}, DurationMinutes: 10},
		{StatusCode: 403, DurationMinutes: 60},
		{StatusCode: 0, DurationMinutes: 0, Description: "ignored: no duration"},
	}
	cases := []struct {
		name   string
		status int
		body   string
		want   string
		hit    bool
	}{
		{"status and keyword (case-insensitive)", 400, `{"error":{"message":"This ORGANIZATION has been disabled."}}`, "temp_unsched:org disabled", true},
		{"status matches, keyword does not", 400, `{"error":"bad request"}`, "", false},
		{"any status with keyword", 529, `{"type":"overloaded_error"}`, "temp_unsched:upstream_http_529", true},
		{"status-only rule", 403, `forbidden`, "temp_unsched:upstream_http_403", true},
		{"success never matches", 200, `overloaded`, "", false},
	}
	for _, tc := range cases {
		rule, ok := matchTempUnschedRule(rules, tc.status, []byte(tc.body))
		if ok != tc.hit {
			t.Fatalf("%s: hit=%v, want %v", tc.name, ok, tc.hit)
		}
		if ok && rule.reason(tc.status) != tc.want {
			t.Fatalf("%s: reason=%q, want %q", tc.name, rule.reason(tc.status), tc.want)
		}
	}
	if got := (TempUnschedRule{DurationMinutes: 99999}).cooldownMs(); got != tempUnschedMaxMinutes*60_000 {
		t.Fatalf("cooldown not clamped to a week: %d", got)
	}
}

func TestPeekErrorBodyKeepsWholeBody(t *testing.T) {
	t.Parallel()
	body := strings.Repeat("x", 100) + "tail"
	resp := &http.Response{Body: io.NopCloser(strings.NewReader(body))}
	if got := string(peekErrorBody(resp, 10)); got != strings.Repeat("x", 10) {
		t.Fatalf("peek = %q", got)
	}
	rest, _ := io.ReadAll(resp.Body)
	if string(rest) != body {
		t.Fatalf("body after peek lost bytes: %d/%d", len(rest), len(body))
	}
}

// A 400 is not failover-eligible on its own; an account rule turns it into a cooldown + failover.
func TestTempUnschedRuleCooldownAndFailover(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "temp-unsched-vault-secret"
		internalToken = "temp-unsched-internal-token"
		apiKey        = "sk-sg-0123456789abcdef0123456789abcdef01234567"
	)

	var (
		cooldownMu     sync.Mutex
		cooldownBodies []map[string]any
		evalCount      atomic.Int32
		rebindMu       sync.Mutex
		rebindCooldown float64
		rebindAccount  string
	)

	upstreamDisabled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","message":"This organization has been disabled."}}`))
	}))
	defer upstreamDisabled.Close()

	upstreamOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_ok","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"rule failover"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`))
	}))
	defer upstreamOK.Close()

	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/acc_ruled/cooldown") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			cooldownMu.Lock()
			cooldownBodies = append(cooldownBodies, body)
			cooldownMu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()

	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core: %v", err)
	}
	defer coreLn.Close()
	go func() {
		for {
			conn, err := coreLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				rawPayload, authErr := dpbridge.UnwrapAuthPayload(f.Flags, f.Payload, internalToken)
				if authErr != nil {
					return
				}
				switch f.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
				case dpbridge.FrameReqHeaders:
					var ev map[string]any
					_ = json.Unmarshal(rawPayload, &ev)
					accID := "acc_ruled"
					if evalCount.Add(1) >= 2 {
						accID = "acc_ok"
						rebindMu.Lock()
						rebindCooldown, _ = ev["rebindCooldownMs"].(float64)
						rebindAccount, _ = ev["rebindCooldownAccountId"].(string)
						rebindMu.Unlock()
					}
					resp := `{"engine":"slipgate-core","action":"dispatch","status":200,"holdId":91,"userId":"u1","apiKeyId":"k1","groupId":"g1","accountId":"` + accID + `","provider":"openai","executionMode":"direct_api","authKind":"api_key","publicModel":"gpt-4o","upstreamModel":"gpt-4o"}`
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameDispatchDirective, Flags: dpbridge.FlagEndStream, Payload: []byte(resp)})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"100","balanceAfterNanoUsd":"999900"}`)})
				}
			}(conn)
		}
	}()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreLn.Addr().String(),
		BFFOrigin:             bff.URL,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})
	encRuled, _ := coord.Vault().EncryptHex(upstreamDisabled.URL + "/v1|sk-disabled")
	encOK, _ := coord.Vault().EncryptHex(upstreamOK.URL + "/v1|sk-good")
	_, _ = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{
				ID: "acc_ruled", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key",
				CredentialsEncHex: encRuled, MaxConcurrency: 4, Status: "active",
				TempUnschedRules: []TempUnschedRule{{StatusCode: 400, Keywords: []string{"organization has been disabled"}, DurationMinutes: 30, Description: "org disabled"}},
			},
			{ID: "acc_ok", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encOK, MaxConcurrency: 4, Status: "active"},
		},
		APIKeys: []SyncApiKeyInput{{ID: "key_1", UserID: "u1", GroupID: "g1", KeyHashHex: sha256HexOf(apiKey), Enabled: true}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+apiKey)
	coord.HandleHTTP(rec, req)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "rule failover") {
		t.Fatalf("expected the rule to fail the 400 over to acc_ok, got %d: %s", rec.Code, rec.Body.String())
	}
	rebindMu.Lock()
	gotMs, gotAcc := rebindCooldown, rebindAccount
	rebindMu.Unlock()
	if gotAcc != "acc_ruled" || int64(gotMs) != 30*60_000 {
		t.Fatalf("expected rebind cooldown 30m on acc_ruled, got %v on %q", gotMs, gotAcc)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		cooldownMu.Lock()
		n := len(cooldownBodies)
		cooldownMu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cooldownMu.Lock()
	defer cooldownMu.Unlock()
	if len(cooldownBodies) == 0 {
		t.Fatalf("expected the rule cooldown persisted to the BFF")
	}
	if reason, _ := cooldownBodies[0]["cooldownReason"].(string); reason != "temp_unsched:org disabled" {
		t.Fatalf("cooldown reason = %q", reason)
	}
}
