package ingress

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
)

func TestUserLimitStatsRouteAuthAndShape(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		ListenAddr:    ":0",
		BFFAddr:       "127.0.0.1:19996",
		Mode:          "release",
		InternalToken: "user-limits-token",
	}
	srv, err := NewServer(cfg, "0.1.0-test", clashpool.NewManager(26000, 26999, 1), nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	handler := srv.Handler()
	post := func(body string, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/internal/net/dataplane/user-limits/stats", strings.NewReader(body))
		if token != "" {
			req.Header.Set("X-Slipgate-Internal-Token", token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	if rec := post(`{"userIds":["u1"]}`, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without internal token, got %d", rec.Code)
	}
	if rec := post(`{"userIds":["u1"]}`, cfg.InternalToken); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without coordinator, got %d", rec.Code)
	}

	srv.WithDataPlaneCoordinator(dataplane.NewCoordinator(dataplane.CoordinatorOptions{VaultSecret: "v"}))
	if rec := post(`{"userIds":`, cfg.InternalToken); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed JSON, got %d", rec.Code)
	}
	tooMany := make([]string, maxUserLimitStatsIDs+1)
	for i := range tooMany {
		tooMany[i] = "u"
	}
	raw, _ := json.Marshal(map[string]any{"userIds": tooMany})
	if rec := post(string(raw), cfg.InternalToken); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for too many ids, got %d", rec.Code)
	}

	rec := post(`{"userIds":["u1"," ","u2"]}`, cfg.InternalToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Live  bool                       `json:"live"`
		Items []dataplane.UserLimitStats `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.Live || len(payload.Items) != 2 || payload.Items[0].UserID != "u1" || payload.Items[1].UserID != "u2" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}
