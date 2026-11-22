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

// accountProbeTimeout bounds one admin account test end to end (dial + first token + short completion).
const accountProbeTimeout = 90 * time.Second

func (s *Server) registerAccountInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/net/accounts/{id}/test", s.handleTestAccount)
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
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
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
