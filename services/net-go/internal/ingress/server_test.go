package ingress

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
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

func TestInternalSupervisorUpdateAuthAndStatus(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		ListenAddr:    ":0",
		CoreIPC:       "127.0.0.1:19999",
		BFFAddr:       "127.0.0.1:19998",
		Mode:          "dev",
		DevSyncMode:   "release",
		UpdateRepo:    "dreamforSh/Slipgate",
		UpdateBranch:  "main",
		InternalToken: "super-secret-internal-token",
	}
	srv, err := NewServer(cfg, "0.1.0-test", clashpool.NewManager(20000, 24999, 1), nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	srv.WithCommit("c08e679")
	srv.WithHotUpdater(hotupdate.NewManager(hotupdate.Options{
		Config:        cfg,
		Version:       "0.1.0-test",
		InitialCommit: "c08e679",
		Logger:        log.New(io.Discard, "", 0),
	}))
	handler := srv.Handler()

	// Missing token -> 403
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/internal/supervisor/update", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without internal token, got %d", rec.Code)
	}

	// Wrong token -> 403
	reqBad := httptest.NewRequest(http.MethodPost, "/internal/supervisor/update/sync", strings.NewReader(`{"checkOnly":true}`))
	reqBad.Header.Set("X-Slipgate-Internal-Token", "wrong-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqBad)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 with wrong internal token, got %d", rec.Code)
	}

	// Valid token -> 200 JSON status
	reqOk := httptest.NewRequest(http.MethodGet, "/internal/supervisor/update", nil)
	reqOk.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqOk)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with valid internal token, got %d: %s", rec.Code, rec.Body.String())
	}
	var snapshot hotupdate.StatusSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode update snapshot: %v", err)
	}
	if snapshot.Mode != "dev" || snapshot.ActiveCommit != "c08e679" {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestInternalClashAndTLSProfileRoutes(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		ListenAddr:    ":0",
		CoreIPC:       "127.0.0.1:19999",
		BFFAddr:       "127.0.0.1:19998",
		InternalToken: "clash-secret-token",
	}
	pool := clashpool.NewManager(22000, 22999, 1)
	dialer := stealth.NewAccountDialer(pool)
	coord := clashpool.NewCoordinator(clashpool.CoordinatorOptions{
		Manager: pool,
		Store:   clashpool.NewMemoryNetStore(),
		Stealth: stealth.NewCoordinatorAdapter(dialer),
		Logger:  log.New(io.Discard, "", 0),
	})
	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatalf("Bootstrap failed: %v", err)
	}

	srv, err := NewServer(cfg, "0.1.0-test", pool, nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	srv.WithClashCoordinator(coord)
	handler := srv.Handler()

	// Unauthenticated internal clash call -> 403
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/internal/net/clash/overview", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without internal token, got %d", rec.Code)
	}

	// Authenticated overview + built-in TLS profiles
	req := httptest.NewRequest(http.MethodGet, "/internal/net/clash/overview", nil)
	req.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on clash overview, got %d: %s", rec.Code, rec.Body.String())
	}
	var ov clashpool.PoolOverview
	if err := json.Unmarshal(rec.Body.Bytes(), &ov); err != nil {
		t.Fatalf("decode overview failed: %v", err)
	}
	if len(ov.Profiles) < 4 {
		t.Fatalf("expected built-in uTLS profiles, got %+v", ov.Profiles)
	}

	// Inline subscription create + sync via internal HTTP route
	subBody := `{"name":"InlineTest","sourceKind":"inline","sourceUrl":"proxies:\n  - name: Node1\n    type: socks5\n    server: 198.51.100.1\n    port: 1080","autoSync":true}`
	reqCreate := httptest.NewRequest(http.MethodPost, "/internal/net/clash/subscriptions", strings.NewReader(subBody))
	reqCreate.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqCreate)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on subscription create, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(coord.EnrichedNodes()) != 1 {
		t.Fatalf("expected 1 synced clash node, got %d", len(coord.EnrichedNodes()))
	}
}
