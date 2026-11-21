package ingress

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
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
	vmSlots    *vmslot.Manager
	sup        *supervisor.Supervisor
	updater    *hotupdate.Manager
	httpClient *http.Client
	bffProxy   *httputil.ReverseProxy
	uiDynamic  *webui.DynamicHandler
	uiHandler  http.Handler
	streamSeq  atomic.Uint32
}

// WithCommit sets the build commit hash reported in health/readiness endpoints.
func (s *Server) WithCommit(commit string) {
	s.commit = commit
}

// WithHotUpdater attaches the dev-mode hot-update manager exposed via internal endpoints.
func (s *Server) WithHotUpdater(updater *hotupdate.Manager) {
	s.updater = updater
}

// SetWebUIOverrideDir swaps the active frontend directory served by the embedded UI handler.
func (s *Server) SetWebUIOverrideDir(dir string) {
	if s.uiDynamic != nil {
		s.uiDynamic.SetOverrideDir(dir)
	}
}

// WithVmSlotManager attaches the VM full-emulation slot manager for readiness observability.
func (s *Server) WithVmSlotManager(vmSlots *vmslot.Manager) {
	s.vmSlots = vmSlots
}

// NewServer builds the unified ingress handler separating DataPlane (/v1/*) from ControlPlane (/api/*).
func NewServer(cfg config.Config, version string, pool *clashpool.Manager, sup *supervisor.Supervisor) (*Server, error) {
	bffURL, err := normalizeHTTPOrigin(cfg.BFFAddr)
	if err != nil {
		return nil, fmt.Errorf("ingress: invalid BFF address %q: %w", cfg.BFFAddr, err)
	}

	bffProxy := httputil.NewSingleHostReverseProxy(bffURL)
	bffProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":   "bff_unavailable",
			"message": proxyErr.Error(),
		})
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

	// Token-authenticated internal supervisor bridge for slipgate-bff admin actions.
	mux.HandleFunc("GET /internal/supervisor/update", s.handleInternalUpdateStatus)
	mux.HandleFunc("POST /internal/supervisor/update/sync", s.handleInternalUpdateSync)

	// DataPlane AI hot paths strictly bypass the TypeScript BFF.
	mux.HandleFunc("/v1/", s.handleDataPlane)
	mux.HandleFunc("/v1beta/", s.handleDataPlane)
	mux.HandleFunc("/mcp/", s.handleDataPlane)

	// ControlPlane management & commerce endpoints proxy to Bun BFF.
	mux.Handle("/api/", s.bffProxy)
	mux.Handle("/webhooks/", s.bffProxy)
	mux.Handle("/oauth/", s.bffProxy)

	// Embedded Vue SPA (or Vite HMR dev server).
	mux.Handle("/", s.uiHandler)
	return mux
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

	coreUp := dpbridge.Ping(ctx, s.cfg.CoreIPC) == nil
	bffUp := s.probeBFF(ctx)
	ready := coreUp && bffUp

	status := http.StatusOK
	if !ready && !s.cfg.AllowDegraded {
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

	writeJSON(w, status, map[string]any{
		"ready":    ready,
		"degraded": !ready,
		"version":  s.version,
		"commit":   s.commit,
		"mode":     s.cfg.Mode,
		"planes": map[string]string{
			"net":  "up",
			"core": upDown(coreUp),
			"bff":  upDown(bffUp),
		},
		"clash_nodes": clashNodes,
		"vm_slots":    vmSlotCount,
		"children":    children,
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
		CheckOnly bool `json:"checkOnly"`
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

	status, err := s.updater.Sync(r.Context(), body.CheckOnly, true)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":  err.Error(),
			"status": status,
		})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleDataPlane(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	conn, err := dpbridge.DialIPC(ctx, s.cfg.CoreIPC)
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
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	meta, _ := json.Marshal(map[string]string{
		"method": r.Method,
		"path":   r.URL.Path,
	})

	streamID := s.streamSeq.Add(1)
	if err := dpbridge.WriteFrame(conn, dpbridge.Frame{
		StreamID: streamID,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  meta,
	}); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]any{
				"type":    "ipc_write_failed",
				"message": err.Error(),
			},
		})
		return
	}

	reply, err := dpbridge.ReadFrame(conn)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]any{
				"type":    "ipc_read_failed",
				"message": err.Error(),
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
