package ingress

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
)

func TestPublicListenerNeverServesInternalRoutes(t *testing.T) {
	t.Parallel()
	var (
		hits      atomic.Int32
		mu        sync.Mutex
		bffTokens []string
	)
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		mu.Lock()
		bffTokens = append(bffTokens, r.Header.Get("X-Slipgate-Internal-Token"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer bff.Close()
	const token = "internal-token-for-public-test"
	srv, err := NewServer(config.Config{ListenAddr: ":0", CoreIPC: "127.0.0.1:19999", BFFAddr: bff.URL, InternalToken: token}, "test", clashpool.NewManager(20000, 24999, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	public := srv.PublicHandler()

	for _, p := range []string{
		"/internal",
		"/internal/supervisor/update",
		"/internal/supervisor/update/restart",
		"/internal/net/dataplane/settlements/dead-letter",
		"/api/v1/internal/dataplane/snapshot",
		"/api/v1/../v1/internal/dataplane/snapshot",
		"/api//v1/internal/dataplane/snapshot",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Header.Set("X-Slipgate-Internal-Token", token)
		public.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("public listener answered %s with %d", p, rec.Code)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("an internal BFF route was proxied from the public listener (%d hits)", hits.Load())
	}

	// The internal listener keeps serving them.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/internal/net/dataplane/settlements/dead-letter", nil)
	req.Header.Set("X-Slipgate-Internal-Token", token)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatal("the internal listener must serve the internal routes")
	}

	// Ordinary control-plane calls still reach the BFF, minus any caller-supplied internal token.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Slipgate-Internal-Token", token)
	public.ServeHTTP(rec, req)
	mu.Lock()
	defer mu.Unlock()
	if rec.Code != http.StatusOK || len(bffTokens) != 1 || bffTokens[0] != "" {
		t.Fatalf("expected the health call proxied without the token: code=%d tokens=%q", rec.Code, bffTokens)
	}
}
