package ingress

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func TestHealthzAndDualPlaneIsolation(t *testing.T) {
	t.Parallel()

	// Mock Bun BFF server: must receive /api/* requests, MUST NEVER receive /v1/*.
	var bffHits atomic.Int32
	var bffSawDataPlane atomic.Bool
	bffServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bffHits.Add(1)
		if r.URL.Path == "/v1/chat/completions" {
			bffSawDataPlane.Store(true)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","plane":"bff"}`))
	}))
	defer bffServer.Close()

	// Mock Zig DataPlane IPC listener.
	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core ipc failed: %v", err)
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
				frame, readErr := dpbridge.ReadFrame(c)
				if readErr != nil {
					return
				}
				switch frame.Type {
				case dpbridge.FramePing:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: frame.StreamID,
						Type:     dpbridge.FramePong,
						Flags:    dpbridge.FlagEndStream,
						Payload:  frame.Payload,
					})
				case dpbridge.FrameReqHeaders:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: frame.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"target":"anthropic","passthrough":true}`),
					})
				}
			}(conn)
		}
	}()

	cfg := config.Config{
		ListenAddr: ":0",
		CoreIPC:    coreLn.Addr().String(),
		BFFAddr:    bffServer.URL,
	}
	srv, err := NewServer(cfg, "0.1.0-test", clashpool.NewManager(20000, 24999, 1), nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	handler := srv.Handler()

	// 1. /healthz
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /healthz, got %d", rec.Code)
	}

	// 2. /readyz checks both core IPC and BFF HTTP
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /readyz, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. /v1/chat/completions must go directly to Zig DataPlane and never touch BFF
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /v1/chat/completions, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Slipgate-Plane") != "dataplane-direct" {
		t.Fatalf("missing X-Slipgate-Plane header")
	}
	if bffSawDataPlane.Load() {
		t.Fatalf("BFF unexpectedly received /v1/* traffic")
	}

	// 4. /api/v1/health proxies to BFF
	beforeHits := bffHits.Load()
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /api/v1/health, got %d", rec.Code)
	}
	if bffHits.Load() <= beforeHits {
		t.Fatalf("expected /api/v1/health to proxy to BFF")
	}

	// 5. / renders embedded placeholder Vue SPA HTML
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/dashboard", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on SPA fallback route, got %d", rec.Code)
	}
	var dummy map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &dummy) == nil {
		t.Fatalf("expected HTML fallback, got JSON")
	}
}
