package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
)

// accountProbeTimeout bounds one admin account test end to end (dial + first token + short completion,
// or a video task polled until it renders).
const accountProbeTimeout = 90 * time.Second

// accountProbeMaxBody caps a test request: the uploads (a source image or audio, up to 5 MiB each
// decoded) arrive as base64 data: URLs.
const accountProbeMaxBody = 16 << 20

func (s *Server) registerAccountInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/net/accounts/{id}/test", s.handleTestAccount)
	mux.HandleFunc("POST /internal/net/accounts/{id}/oauth/refresh", s.handleRefreshAccountOAuth)
	mux.HandleFunc("POST /internal/net/accounts/{id}/privacy", s.handleSetAccountPrivacy)
	mux.HandleFunc("POST /internal/net/accounts/{id}/models", s.handleFetchAccountModels)
	mux.HandleFunc("GET /internal/net/cli-fingerprint", s.handleCLIFingerprint)
	mux.HandleFunc("POST /internal/net/cli-fingerprint/sync", s.handleSyncCLIFingerprint)
	mux.HandleFunc("GET /internal/net/models/discovered", s.handleGetDiscoveredModels)
	mux.HandleFunc("POST /internal/net/models/sync", s.handleSyncDiscoveredModels)
}

func (s *Server) handleRefreshAccountOAuth(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	accountID := strings.TrimSpace(r.PathValue("id"))
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "account id is required"})
		return
	}
	sec, err := s.dpCoord.RefreshAccountOAuth(r.Context(), accountID, true)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "oauth_refresh_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"subscriptionTier": sec.SubscriptionTier,
		"expiresAtUnixMs":  sec.ExpiresAtUnixMs,
	})
}

// handleSetAccountPrivacy turns off provider-side data sharing for one OAuth account (ChatGPT
// training, Antigravity telemetry) and reports the resulting privacy mode.
func (s *Server) handleSetAccountPrivacy(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	accountID := strings.TrimSpace(r.PathValue("id"))
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "account id is required"})
		return
	}
	res, err := s.dpCoord.SetAccountPrivacy(r.Context(), accountID)
	switch {
	case errors.Is(err, dataplane.ErrPrivacyAccountNotSynced):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "account_not_synced", "message": err.Error()})
		return
	case errors.Is(err, dataplane.ErrPrivacyUnsupported):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "privacy_unsupported", "message": err.Error()})
		return
	case errors.Is(err, dataplane.ErrAccountSecretNotFound):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "account_secret_unavailable", "message": err.Error()})
		return
	case err != nil:
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "privacy_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": res.Mode, "status": res.Status, "message": res.Message})
}

// handleFetchAccountModels lists the models one account can use, asked over its own egress.
func (s *Server) handleFetchAccountModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	accountID := strings.TrimSpace(r.PathValue("id"))
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "account id is required"})
		return
	}
	res, err := s.dpCoord.FetchAccountModels(r.Context(), accountID)
	switch {
	case errors.Is(err, dataplane.ErrAccountNotSynced):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "account_not_synced", "message": err.Error()})
		return
	case errors.Is(err, dataplane.ErrAccountModelsUnsupported):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "models_unsupported", "message": err.Error()})
		return
	case errors.Is(err, dataplane.ErrAccountSecretNotFound):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "account_secret_unavailable", "message": err.Error()})
		return
	case err != nil:
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "models_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": res.Models, "source": res.Source, "message": res.Message})
}

// handleCLIFingerprint reports the client versions and User-Agents the data plane impersonates.
func (s *Server) handleCLIFingerprint(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, dataplane.DefaultCLIVersionSyncer.Report())
}

// handleSyncCLIFingerprint reads the latest client releases now (also when hourly sync is off).
func (s *Server) handleSyncCLIFingerprint(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, dataplane.DefaultCLIVersionSyncer.SyncOnce(ctx))
}

func (s *Server) handleGetDiscoveredModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusOK, map[string]any{"models": map[string][]string{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": s.dpCoord.DiscoveredModels()})
}

func (s *Server) handleSyncDiscoveredModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	models := s.dpCoord.RefreshUpstreamModelCatalog(r.Context(), true)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": models})
}

// handleTestAccount streams a ProbeEvent sequence as text/event-stream for one upstream account.
func (s *Server) handleTestAccount(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":   "dataplane_coordinator_unavailable",
			"message": "data plane coordinator is not attached",
		})
		return
	}
	accountID := strings.TrimSpace(r.PathValue("id"))
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "account id is required"})
		return
	}

	var req dataplane.ProbeRequest
	if r.Body != nil {
		if err := json.NewDecoder(io.LimitReader(r.Body, accountProbeMaxBody)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
			return
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	ctx, cancel := context.WithTimeout(r.Context(), accountProbeTimeout)
	defer cancel()

	s.dpCoord.ProbeAccount(ctx, accountID, req, func(ev dataplane.ProbeEvent) {
		raw, err := json.Marshal(ev)
		if err != nil {
			return
		}
		_, _ = w.Write([]byte("data: "))
		_, _ = w.Write(raw)
		_, _ = w.Write([]byte("\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	})
}
