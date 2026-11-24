package ingress

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func TestRootAliasesReachTheDataPlaneAsV1Routes(t *testing.T) {
	t.Parallel()
	const token = "alias-internal-token"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var (
		mu    sync.Mutex
		paths []string
	)
	go func() {
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, rErr := dpbridge.ReadFrame(c)
				if rErr != nil {
					return
				}
				payload, uErr := dpbridge.UnwrapAuthPayload(req.Flags, req.Payload, token)
				if uErr != nil {
					return
				}
				var eval struct {
					Path string `json:"path"`
				}
				_ = json.Unmarshal(payload, &eval)
				mu.Lock()
				paths = append(paths, eval.Path)
				mu.Unlock()
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{
					StreamID: req.StreamID,
					Type:     dpbridge.FrameDispatchDirective,
					Flags:    dpbridge.FlagEndStream,
					Payload:  []byte(`{"action":"reject","status":401,"errorType":"authentication_error","errorCode":"invalid_api_key","message":"refused by the test core"}`),
				})
			}(conn)
		}
	}()

	coord := dataplane.NewCoordinator(dataplane.CoordinatorOptions{CoreIPC: ln.Addr().String(), InternalToken: token, VaultSecret: "alias-vault"})
	srv, err := NewServer(config.Config{ListenAddr: ":0", CoreIPC: ln.Addr().String(), BFFAddr: "127.0.0.1:1", InternalToken: token}, "test", clashpool.NewManager(20000, 24999, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	srv.WithDataPlaneCoordinator(coord)
	h := srv.PublicHandler()

	for _, tc := range []struct{ method, path, body, want string }{
		{http.MethodPost, "/chat/completions", `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`, "/v1/chat/completions"},
		{http.MethodPost, "/responses", `{"model":"gpt-4o","input":"hi"}`, "/v1/responses"},
		{http.MethodPost, "/messages", `{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`, "/v1/messages"},
		{http.MethodPost, "/embeddings", `{"model":"text-embedding-3-small","input":"hi"}`, "/v1/embeddings"},
		{http.MethodGet, "/models", "", "/v1/models"},
		{http.MethodPost, "/backend-api/codex/responses", `{"model":"gpt-5-codex","input":"hi"}`, "/v1/responses"},
		{http.MethodGet, "/backend-api/codex/models", "", "/v1/models"},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer sk-sg-alias")
		h.ServeHTTP(rec, req)
		mu.Lock()
		last := ""
		if len(paths) > 0 {
			last = paths[len(paths)-1]
		}
		mu.Unlock()
		if rec.Code != http.StatusUnauthorized || last != tc.want {
			t.Fatalf("%s %s: status %d, core saw %q (want %q): %s", tc.method, tc.path, rec.Code, last, tc.want, rec.Body.String())
		}
	}

	// The console's own /models page: a browser navigation carries no API credentials.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/models", nil))
	if rec.Code != http.StatusOK || !strings.Contains(strings.ToLower(rec.Header().Get("Content-Type")), "text/html") {
		t.Fatalf("GET /models without a key must stay the SPA page: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}

	// POST /mcp is served in place instead of being redirected to /mcp/.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer sk-sg-alias")
	h.ServeHTTP(rec, req)
	if rec.Code >= 300 && rec.Code < 400 {
		t.Fatalf("POST /mcp was redirected (%d to %q)", rec.Code, rec.Header().Get("Location"))
	}
	if strings.Contains(strings.ToLower(rec.Header().Get("Content-Type")), "text/html") {
		t.Fatal("POST /mcp fell through to the SPA")
	}
}
