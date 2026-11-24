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
	"time"

	"github.com/coder/websocket"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
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
	restartCh := make(chan string, 1)
	srv.WithHotUpdater(hotupdate.NewManager(hotupdate.Options{
		Config:        cfg,
		Version:       "0.1.0-test",
		InitialCommit: "c08e679",
		Logger:        log.New(io.Discard, "", 0),
		RestartDelay:  10 * time.Millisecond,
		ValidateEdgeBin: func(_ context.Context, _ string) error {
			return nil
		},
		OnEdgeRestart: func(target string) {
			restartCh <- target
		},
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

	// Restart endpoint enforces internal token and triggers OnEdgeRestart.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/internal/supervisor/update/restart", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on restart without internal token, got %d", rec.Code)
	}

	reqRestart := httptest.NewRequest(http.MethodPost, "/internal/supervisor/update/restart", nil)
	reqRestart.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqRestart)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on restart with internal token, got %d: %s", rec.Code, rec.Body.String())
	}
	var restartSnap hotupdate.StatusSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &restartSnap); err != nil {
		t.Fatalf("decode restart snapshot: %v", err)
	}
	if restartSnap.State != hotupdate.StateRestarting || !restartSnap.RestartScheduled {
		t.Fatalf("expected restarting snapshot, got %+v", restartSnap)
	}
	select {
	case <-restartCh:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for OnEdgeRestart callback")
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

func TestTLSProfileWireValidationAndPUT(t *testing.T) {
	t.Parallel()

	pool := clashpool.NewManager(20000, 24999, 1)
	dialer := stealth.NewAccountDialer(pool)
	coord := clashpool.NewCoordinator(clashpool.CoordinatorOptions{
		Manager: pool,
		Store:   clashpool.NewMemoryNetStore(),
		Stealth: stealth.NewCoordinatorAdapter(dialer),
		Logger:  log.Default(),
	})
	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatalf("Bootstrap failed: %v", err)
	}

	cfg := config.Config{
		ListenAddr:    "127.0.0.1:0",
		CoreIPC:       "127.0.0.1:0",
		BFFAddr:       "http://127.0.0.1:19082",
		InternalToken: "tok-tls",
		AllowDegraded: true,
	}
	srv, err := NewServer(cfg, "0.2.0", pool, nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	srv.WithClashCoordinator(coord)
	handler := srv.Handler()

	// 1. Reject invalid keyShareGroups absent from curves with structured 400 reason.
	badBody := `{"name":"InvalidPQ","curves":[23],"keyShareGroups":[29],"extensions":[0,10,16,43,51]}`
	reqBad := httptest.NewRequest(http.MethodPost, "/internal/net/tls-profiles", strings.NewReader(badBody))
	reqBad.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, reqBad)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "TLS_PROFILE_KEY_SHARE_NOT_IN_CURVES") {
		t.Fatalf("expected 400 TLS_PROFILE_KEY_SHARE_NOT_IN_CURVES, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Create custom wire profile -> PUT update -> DELETE lifecycle.
	goodBody := `{"id":"custom-wire-1","name":"CustomBunPQ","clientHelloPreset":"custom_wire","enableGrease":true,"curves":[4588,29,23],"keyShareGroups":[4588,29],"extensions":[0,23,65281,10,11,35,16,5,13,51,45,43,65037],"osHint":"linux"}`
	reqCreate := httptest.NewRequest(http.MethodPost, "/internal/net/tls-profiles", strings.NewReader(goodBody))
	reqCreate.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqCreate)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 create, got %d: %s", rec.Code, rec.Body.String())
	}

	putBody := `{"name":"CustomBunPQ-Updated","enableGrease":false,"curves":[4588,29],"keyShareGroups":[4588],"osHint":"darwin"}`
	reqPut := httptest.NewRequest(http.MethodPut, "/internal/net/tls-profiles/custom-wire-1", strings.NewReader(putBody))
	reqPut.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqPut)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "CustomBunPQ-Updated") {
		t.Fatalf("expected 200 update, got %d: %s", rec.Code, rec.Body.String())
	}

	// Built-in immutable lock -> 403.
	reqLock := httptest.NewRequest(http.MethodPut, "/internal/net/tls-profiles/claude-bun-21", strings.NewReader(putBody))
	reqLock.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqLock)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 updating built-in profile, got %d: %s", rec.Code, rec.Body.String())
	}

	reqDel := httptest.NewRequest(http.MethodDelete, "/internal/net/tls-profiles/custom-wire-1", nil)
	reqDel.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, reqDel)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 delete custom profile, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestVmFleetRoutesAndWebSocketTerminal(t *testing.T) {
	t.Parallel()

	pool := clashpool.NewManager(20000, 24999, 1)
	_, err := pool.SyncNodes("sub-vm", []clashpool.Node{
		{
			ID:            "node-vm-1",
			Name:          "Edge-VM-1",
			ProxySlotID:   "ps-1",
			ListenerPort:  20155,
			SocksUsername: "u",
			SocksPassword: "p",
			ExitIP:        "198.51.100.77",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	if err := pool.BindAccount("acc-vm-1", "node-vm-1", false); err != nil {
		t.Fatalf("BindAccount failed: %v", err)
	}

	vmMgr := vmslot.NewManager(pool)
	vmCoord := vmslot.NewCoordinator(vmslot.CoordinatorOptions{
		Manager:   vmMgr,
		ClashPool: pool,
		Store:     vmslot.NewMemoryVmStore(),
		VMDataDir: t.TempDir(),
	})
	if err := vmCoord.Bootstrap(context.Background()); err != nil {
		t.Fatalf("vmCoord Bootstrap failed: %v", err)
	}

	cfg := config.Config{
		ListenAddr:    "127.0.0.1:0",
		CoreIPC:       "127.0.0.1:0",
		BFFAddr:       "http://127.0.0.1:19082",
		InternalToken: "tok-vm",
		AllowDegraded: true,
	}
	srv, err := NewServer(cfg, "0.2.0", pool, nil)
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}
	srv.WithVmSlotManager(vmMgr)
	srv.WithVmCoordinator(vmCoord)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. Overview returns local-node.
	reqOv, _ := http.NewRequest(http.MethodGet, ts.URL+"/internal/net/vms/overview", nil)
	reqOv.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	resp, err := http.DefaultClient.Do(reqOv)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("overview failed: resp=%v err=%v", resp, err)
	}
	ovBytes, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(ovBytes), `"local-node"`) {
		t.Fatalf("expected local-node in overview, got %s", string(ovBytes))
	}

	// 2. Fail closed without bound clash node.
	reqFail, _ := http.NewRequest(http.MethodPost, ts.URL+"/internal/net/vms/slots", strings.NewReader(`{"accountId":"acc-none"}`))
	reqFail.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	resp, _ = http.DefaultClient.Do(reqFail)
	if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK {
		t.Fatalf("expected fail-closed provisioning rejection, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 3. Provision valid slot + PUT seed + issue terminal ticket + WebSocket session.
	reqProv, _ := http.NewRequest(http.MethodPost, ts.URL+"/internal/net/vms/slots", strings.NewReader(`{"slotId":"vm-ws-1","accountId":"acc-vm-1","hypervisorKind":"kvm_qemu"}`))
	reqProv.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	resp, err = http.DefaultClient.Do(reqProv)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("provision failed: resp=%v err=%v", resp, err)
	}
	_ = resp.Body.Close()

	reqSeed, _ := http.NewRequest(http.MethodPut, ts.URL+"/internal/net/vms/slots/vm-ws-1/seed", strings.NewReader(`{"settingsJsonRaw":"{\"cleanupPeriodDays\":7}"}`))
	reqSeed.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	resp, err = http.DefaultClient.Do(reqSeed)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("seed update failed: resp=%v err=%v", resp, err)
	}
	_ = resp.Body.Close()

	reqTicket, _ := http.NewRequest(http.MethodPost, ts.URL+"/internal/net/vms/slots/vm-ws-1/terminal-ticket", nil)
	reqTicket.Header.Set("X-Slipgate-Internal-Token", cfg.InternalToken)
	resp, err = http.DefaultClient.Do(reqTicket)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("ticket issue failed: resp=%v err=%v", resp, err)
	}
	var ticket vmslot.TerminalTicket
	_ = json.NewDecoder(resp.Body).Decode(&ticket)
	_ = resp.Body.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + ticket.WSPath
	wsCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsConn, _, err := websocket.Dial(wsCtx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial failed: %v", err)
	}
	defer wsConn.CloseNow()

	// Read welcome banner, send `status`, read output frame.
	_, bannerBytes, err := wsConn.Read(wsCtx)
	if err != nil || !strings.Contains(string(bannerBytes), "vm-ws-1") {
		t.Fatalf("unexpected WS banner: %q err=%v", string(bannerBytes), err)
	}
	if err := wsConn.Write(wsCtx, websocket.MessageText, []byte("status")); err != nil {
		t.Fatalf("ws write status failed: %v", err)
	}
	_, outBytes, err := wsConn.Read(wsCtx)
	if err != nil || !strings.Contains(string(outBytes), "198.51.100.77") {
		t.Fatalf("unexpected WS command output: %q err=%v", string(outBytes), err)
	}
	_ = wsConn.Close(websocket.StatusNormalClosure, "done")
}
