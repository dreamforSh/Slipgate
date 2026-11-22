package ingress

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
)

func TestAccountTestRouteStreamsProbeEvents(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		ListenAddr:    ":0",
		BFFAddr:       "127.0.0.1:19997",
		Mode:          "release",
		InternalToken: "acct-test-token",
	}
	srv, err := NewServer(cfg, "0.1.0-test", clashpool.NewManager(25000, 25999, 1), nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	handler := srv.Handler()

	// Without the internal token the route is closed.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/internal/net/accounts/acc_1/test", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without internal token, got %d", rec.Code)
	}

	// Without a data plane coordinator the route reports 503.
	req := httptest.NewRequest(http.MethodPost, "/internal/net/accounts/acc_1/test", strings.NewReader(`{}`))
	req.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without coordinator, got %d", rec.Code)
	}

	coord := dataplane.NewCoordinator(dataplane.CoordinatorOptions{VaultSecret: "acct-test-vault"})
	enc, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), dataplane.SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []dataplane.SyncAccountInput{
			{ID: "acc_1", GroupID: "grp", Platform: "anthropic", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc, MaxConcurrency: 1, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot failed: %v", err)
	}
	srv.WithDataPlaneCoordinator(coord)
	handler = srv.Handler()

	req = httptest.NewRequest(http.MethodPost, "/internal/net/accounts/acc_1/test", strings.NewReader(`{"model":"claude-haiku-4-5","prompt":"hello"}`))
	req.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 stream, got %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected SSE content type, got %q", ct)
	}

	var events []dataplane.ProbeEvent
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev dataplane.ProbeEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
			t.Fatalf("bad SSE payload %q: %v", line, err)
		}
		events = append(events, ev)
	}
	if len(events) < 3 || events[0].Type != "start" || events[0].Model != "claude-haiku-4-5" {
		t.Fatalf("unexpected event sequence: %+v", events)
	}
	if last := events[len(events)-1]; last.Type != "done" || !last.Success {
		t.Fatalf("expected successful done, got %+v", last)
	}
}
