package ingress

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
	"github.com/dreamforSh/slipgate/services/net-go/internal/lifecycle"
	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
	"github.com/dreamforSh/slipgate/services/net-go/internal/webui"
)

// Server exposes the unified single-port Slipgate edge gateway.
type Server struct {
	cfg        config.Config
	version    string
	commit     string
	pool       *clashpool.Manager
	clashCoord *clashpool.Coordinator
	vmSlots    *vmslot.Manager
	vmCoord    *vmslot.Coordinator
	dpCoord    *dataplane.Coordinator
	sup        *supervisor.Supervisor
	updater    *hotupdate.Manager
	drainer    *lifecycle.Drainer
	httpClient *http.Client
	bffProxy   *httputil.ReverseProxy
	uiDynamic  *webui.DynamicHandler
	uiHandler  http.Handler
	streamSeq  atomic.Uint32
}

// WithClashCoordinator attaches the Clash mihomo pool + uTLS coordinator for /internal/net/clash/* endpoints.
func (s *Server) WithClashCoordinator(coord *clashpool.Coordinator) {
	s.clashCoord = coord
}

// WithCommit sets the build commit hash reported in health/readiness endpoints.
func (s *Server) WithCommit(commit string) {
	s.commit = commit
}

// WithHotUpdater attaches the dev-mode hot-update manager exposed via internal endpoints.
func (s *Server) WithHotUpdater(updater *hotupdate.Manager) {
	s.updater = updater
}

// WithDrainer attaches the public drain gate so readiness reports a restart in progress.
func (s *Server) WithDrainer(d *lifecycle.Drainer) {
	s.drainer = d
}

// SetWebUIOverrideDir swaps the active frontend directory served by the embedded UI handler.
func (s *Server) SetWebUIOverrideDir(dir string) {
	if s.uiDynamic != nil {
		s.uiDynamic.SetOverrideDir(dir)
	}
}

// WebUIOverrideDir returns the currently active hot-synced frontend directory, or empty string if none.
func (s *Server) WebUIOverrideDir() string {
	if s.uiDynamic == nil {
		return ""
	}
	return s.uiDynamic.OverrideDir()
}

// WithVmSlotManager attaches the VM full-emulation slot manager for readiness observability.
func (s *Server) WithVmSlotManager(vmSlots *vmslot.Manager) {
	s.vmSlots = vmSlots
}

// WithVmCoordinator attaches the VM fleet coordinator for /internal/net/vms/* and WebSocket terminal routes.
func (s *Server) WithVmCoordinator(coord *vmslot.Coordinator) {
	s.vmCoord = coord
}

// WithDataPlaneCoordinator attaches the L1/L2 AI DataPlane coordinator for /v1/*, /v1beta/*, /mcp/*, and /internal/net/dataplane/sync.
func (s *Server) WithDataPlaneCoordinator(coord *dataplane.Coordinator) {
	s.dpCoord = coord
}

// NewServer builds the unified ingress handler separating DataPlane (/v1/*) from ControlPlane (/api/*).
func NewServer(cfg config.Config, version string, pool *clashpool.Manager, sup *supervisor.Supervisor) (*Server, error) {
	bffURL, err := normalizeHTTPOrigin(cfg.BFFAddr)
	if err != nil {
		return nil, fmt.Errorf("ingress: invalid BFF address %q: %w", cfg.BFFAddr, err)
	}

	trustedProxies := netguard.ParseTrustedProxies(cfg.TrustedProxies)
	bffProxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(bffURL)
			pr.Out.Host = pr.In.Host
			trustedProxies.SanitizeForwardedHeaders(pr.In, pr.Out)
			// Only slipgate-net itself talks to the BFF with the internal token.
			pr.Out.Header.Del("X-Slipgate-Internal-Token")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "bff_unavailable",
				"message": proxyErr.Error(),
			})
		},
	}

	uiDynamic := webui.Handler()
	if cfg.WebUIDir != "" {
		uiDynamic.SetOverrideDir(cfg.WebUIDir)
	}

	var uiHandler http.Handler = uiDynamic
	if cfg.DevUIURL != "" {
		devURL, devErr := url.Parse(cfg.DevUIURL)
		if devErr != nil {
			return nil, fmt.Errorf("ingress: invalid dev UI URL %q: %w", cfg.DevUIURL, devErr)
		}
		uiHandler = httputil.NewSingleHostReverseProxy(devURL)
	}

	return &Server{
		cfg:     cfg,
		version: version,
		commit:  "dev",
		pool:    pool,
		sup:     sup,
		httpClient: &http.Client{
			Timeout: 2 * time.Second,
		},
		bffProxy:  bffProxy,
		uiDynamic: uiDynamic,
		uiHandler: uiHandler,
	}, nil
}

// Handler returns the root HTTP multiplexer.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)

	// Token-authenticated internal supervisor & net-plane bridges for slipgate-bff admin actions.
	mux.HandleFunc("GET /internal/supervisor/update", s.handleInternalUpdateStatus)
	mux.HandleFunc("GET /internal/supervisor/update/releases", s.handleInternalUpdateReleases)
	mux.HandleFunc("POST /internal/supervisor/update/sync", s.handleInternalUpdateSync)
	mux.HandleFunc("PUT /internal/supervisor/update/config", s.handleInternalUpdateConfig)
	mux.HandleFunc("POST /internal/supervisor/update/rollback", s.handleInternalUpdateRollback)
	mux.HandleFunc("POST /internal/supervisor/update/restart", s.handleInternalUpdateRestart)
	mux.HandleFunc("POST /internal/net/dataplane/sync", s.handleInternalDataPlaneSync)
	s.registerClashInternalRoutes(mux)
	s.registerVmInternalRoutes(mux)
	s.registerAccountInternalRoutes(mux)
	s.registerUserLimitInternalRoutes(mux)
	s.registerSettlementInternalRoutes(mux)

	// DataPlane AI hot paths strictly bypass the TypeScript BFF.
	mux.HandleFunc("/v1/", s.handleDataPlane)
	mux.HandleFunc("/v1beta/", s.handleDataPlane)
	mux.HandleFunc("/mcp", s.handleDataPlane)
	mux.HandleFunc("/mcp/", s.handleDataPlane)
	for _, pattern := range dataPlaneAliasPatterns {
		mux.HandleFunc(pattern, s.handleDataPlaneAlias)
	}

	// ControlPlane management & commerce endpoints proxy to Bun BFF.
	mux.Handle("/api/", s.bffProxy)
	mux.Handle("/webhooks/", s.bffProxy)
	mux.Handle("/oauth/", s.bffProxy)

	// Single-use ticket-authenticated WebSocket terminal endpoint for VM slots.
	s.registerVmWebSocketRoutes(mux)

	// Embedded Vue SPA (or Vite HMR dev server).
	mux.Handle("/", s.uiHandler)
	return mux
}

// PublicHandler is Handler without the internal routes: what the public listener serves. Those
// routes (and the BFF's /api/v1/internal/*) are only reachable on the internal listener, so a
// reverse proxy on the same host cannot carry outside traffic to them.
func (s *Server) PublicHandler() http.Handler {
	full := s.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isInternalPath(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		full.ServeHTTP(w, r)
	})
}

func isInternalPath(p string) bool {
	clean := path.Clean("/" + p)
	for _, prefix := range []string{"/internal", "/api/v1/internal"} {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return false
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": "slipgate-net",
		"version": s.version,
		"commit":  s.commit,
		"mode":    s.cfg.Mode,
	})
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
	defer cancel()

	coreUp := dpbridge.PingAuth(ctx, s.cfg.CoreIPC, s.cfg.InternalToken) == nil
	bffUp := s.probeBFF(ctx)
	ready := coreUp && bffUp
	draining := s.drainer != nil && s.drainer.Draining()

	status := http.StatusOK
	if (!ready && !s.cfg.AllowDegraded) || draining {
		status = http.StatusServiceUnavailable
	}

	var children []supervisor.ChildSnapshot
	if s.sup != nil {
		children = s.sup.Snapshots()
	}

	var clashNodes int
	if s.pool != nil {
		clashNodes = len(s.pool.Snapshot())
	}

	var vmSlotCount int
	if s.vmSlots != nil {
		vmSlotCount = len(s.vmSlots.Snapshot())
	}

	var clashRuntime any
	if s.clashCoord != nil {
		clashRuntime = s.clashCoord.RuntimeStatusSnapshot()
	}

	writeJSON(w, status, map[string]any{
		"ready":         ready && !draining,
		"degraded":      !ready,
		"draining":      draining,
		"version":       s.version,
		"commit":        s.commit,
		"mode":          s.cfg.Mode,
		"planes": map[string]string{
			"net":  "up",
			"core": upDown(coreUp),
			"bff":  upDown(bffUp),
		},
		"clash_runtime": clashRuntime,
		"clash_nodes":   clashNodes,
		"vm_slots":      vmSlotCount,
		"children":      children,
	})
}

func (s *Server) requireInternalAuth(w http.ResponseWriter, r *http.Request) bool {
	expected := s.cfg.InternalToken
	provided := r.Header.Get("X-Slipgate-Internal-Token")
	if expected == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "forbidden",
			"message": "invalid or missing internal supervisor token",
		})
		return false
	}
	return true
}

func (s *Server) handleInternalUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}
	writeJSON(w, http.StatusOK, s.updater.Status())
}

func (s *Server) handleInternalUpdateReleases(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}
	refresh := r.URL.Query().Get("refresh") == "1" || strings.EqualFold(r.URL.Query().Get("refresh"), "true")
	res, err := s.updater.ListReleases(r.Context(), refresh)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":   "releases_fetch_failed",
			"message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleInternalUpdateSync(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}

	var body struct {
		CheckOnly         bool   `json:"checkOnly"`
		Channel           string `json:"channel"`
		TargetTag         string `json:"targetTag"`
		Force             bool   `json:"force"`
		AllowReleaseApply bool   `json:"allowReleaseApply"`
	}
	if r.Body != nil {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
		if len(strings.TrimSpace(string(raw))) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":   "invalid_request",
					"message": err.Error(),
				})
				return
			}
		}
	}

	status, err := s.updater.SyncWithOptions(r.Context(), hotupdate.SyncOptions{
		CheckOnly:         body.CheckOnly,
		AsyncRestart:      true,
		Channel:           body.Channel,
		TargetTag:         body.TargetTag,
		Force:             body.Force,
		AllowReleaseApply: body.AllowReleaseApply,
	})
	if err != nil {
		code := http.StatusBadGateway
		errCode := "update_sync_failed"
		if errors.Is(err, hotupdate.ErrInvalidUpdateConfig) {
			code = http.StatusBadRequest
			errCode = "invalid_request"
		} else if errors.Is(err, hotupdate.ErrUpdateBusy) {
			code = http.StatusConflict
			errCode = "update_in_progress"
		}
		writeJSON(w, code, map[string]any{
			"error":   errCode,
			"message": err.Error(),
			"status":  status,
		})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleInternalUpdateConfig(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}
	var patch hotupdate.ConfigPatch
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "invalid_request",
			"message": err.Error(),
		})
		return
	}
	status, err := s.updater.UpdateConfig(patch)
	if err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, hotupdate.ErrInvalidUpdateConfig) {
			code = http.StatusBadRequest
		}
		writeJSON(w, code, map[string]any{
			"error":   "invalid_update_config",
			"message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleInternalUpdateRollback(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}
	var body struct {
		ReleaseID string `json:"releaseId"`
	}
	if r.Body != nil {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
		if len(strings.TrimSpace(string(raw))) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":   "invalid_request",
					"message": err.Error(),
				})
				return
			}
		}
	}
	status, err := s.updater.Rollback(r.Context(), strings.TrimSpace(body.ReleaseID), true)
	if err != nil {
		code := http.StatusBadGateway
		errCode := "rollback_failed"
		if errors.Is(err, hotupdate.ErrRollbackUnavailable) || errors.Is(err, hotupdate.ErrUpdateBusy) {
			code = http.StatusConflict
			errCode = "rollback_unavailable"
		}
		writeJSON(w, code, map[string]any{
			"error":   errCode,
			"message": err.Error(),
			"status":  status,
		})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleInternalUpdateRestart(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.updater == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "hotupdate_unavailable",
		})
		return
	}
	status, err := s.updater.TriggerRestart(r.Context(), true)
	if err != nil {
		code := http.StatusBadGateway
		errCode := "restart_failed"
		if errors.Is(err, hotupdate.ErrRestartUnavailable) || errors.Is(err, hotupdate.ErrUpdateBusy) {
			code = http.StatusConflict
			errCode = "restart_unavailable"
		}
		writeJSON(w, code, map[string]any{
			"error":   errCode,
			"message": err.Error(),
			"status":  status,
		})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleInternalDataPlaneSync(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "dataplane_coordinator_unavailable",
		})
		return
	}
	var snap dataplane.SyncSnapshot
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&snap); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "invalid_request",
			"message": err.Error(),
		})
		return
	}
	ack, err := s.dpCoord.SyncSnapshot(r.Context(), snap)
	if err != nil {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"ok":               true,
			"degradedCoreSync": true,
			"warning":          err.Error(),
			"vaultAccounts":    ack.VaultAccounts,
			"revisionUnixMs":   ack.RevisionUnixMs,
		})
		return
	}
	writeJSON(w, http.StatusOK, ack)
}

// dataPlaneAliasPatterns are the routes SDKs reach when their base URL omits /v1, plus Codex CLI
// pointed at a ChatGPT-backend style base URL (.../backend-api/codex).
var dataPlaneAliasPatterns = []string{
	"/chat/completions", "/responses", "/responses/", "/messages", "/messages/", "/models", "/models/",
	"/embeddings", "/images/", "/videos", "/videos/", "/backend-api/codex/",
}

// dataPlaneAliasPath maps an alias onto its /v1 data-plane route.
func dataPlaneAliasPath(p string) (string, bool) {
	if rest, ok := strings.CutPrefix(p, "/backend-api/codex"); ok {
		for _, root := range []string{"/responses", "/models"} {
			if rest == root || strings.HasPrefix(rest, root+"/") {
				return "/v1" + rest, true
			}
		}
		return "", false
	}
	for _, root := range []string{"/chat/completions", "/responses", "/messages", "/models", "/embeddings", "/images", "/videos"} {
		if p == root || strings.HasPrefix(p, root+"/") {
			return "/v1" + p, true
		}
	}
	return "", false
}

// handleDataPlaneAlias serves an alias as its /v1 route. A GET without API credentials is a
// browser navigating the console (its /models page), so it keeps getting the SPA.
func (s *Server) handleDataPlaneAlias(w http.ResponseWriter, r *http.Request) {
	target, ok := dataPlaneAliasPath(r.URL.Path)
	readOnly := r.Method == http.MethodGet || r.Method == http.MethodHead
	if !ok || (readOnly && !carriesAPICredentials(r)) {
		s.uiHandler.ServeHTTP(w, r)
		return
	}
	aliased := r.Clone(r.Context())
	aliased.URL.Path = target
	aliased.URL.RawPath = ""
	s.handleDataPlane(w, aliased)
}

func carriesAPICredentials(r *http.Request) bool {
	return r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "" || r.Header.Get("x-goog-api-key") != ""
}

func (s *Server) handleDataPlane(w http.ResponseWriter, r *http.Request) {
	if s.dpCoord != nil {
		s.dpCoord.HandleHTTP(w, r)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	meta, _ := json.Marshal(map[string]string{
		"method": r.Method,
		"path":   r.URL.Path,
	})

	streamID := s.streamSeq.Add(1)
	reply, err := dpbridge.ExchangeAuth(ctx, s.cfg.CoreIPC, s.cfg.InternalToken, dpbridge.Frame{
		StreamID: streamID,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  meta,
	})
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]any{
				"type":    "core_unavailable",
				"message": "slipgate-core dataplane unreachable",
				"detail":  err.Error(),
			},
		})
		return
	}

	w.Header().Set("X-Slipgate-Plane", "dataplane-direct")
	writeJSON(w, http.StatusOK, map[string]any{
		"object":    "slipgate.dataplane.dispatch",
		"stream_id": reply.StreamID,
		"frame":     fmt.Sprintf("0x%02x", reply.Type),
		"directive": json.RawMessage(fallbackJSON(reply.Payload)),
	})
}

func (s *Server) probeBFF(ctx context.Context) bool {
	origin, err := normalizeHTTPOrigin(s.cfg.BFFAddr)
	if err != nil {
		return false
	}
	probeURL := origin.String() + "/api/v1/health"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
	if err != nil {
		return false
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func normalizeHTTPOrigin(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		trimmed = "http://" + trimmed
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, err
	}
	if u.Host == "" {
		return nil, fmt.Errorf("missing host in %q", raw)
	}
	return u, nil
}

func upDown(ok bool) string {
	if ok {
		return "up"
	}
	return "down"
}

func fallbackJSON(b []byte) []byte {
	if json.Valid(b) {
		return b
	}
	quoted, _ := json.Marshal(string(b))
	return quoted
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// ListenAndServeDualStack configures HTTP/1.1 and cleartext HTTP/2 (h2c) support.
func NewHTTPServer(addr string, handler http.Handler) *http.Server {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)

	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		Protocols:         protocols,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(_ net.Listener) context.Context {
			return context.Background()
		},
	}
}
