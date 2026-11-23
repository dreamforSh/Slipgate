package ingress

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// maxUserLimitStatsIDs bounds one stats request (slipgate-bff asks for one page of users).
const maxUserLimitStatsIDs = 500

// registerUserLimitInternalRoutes mounts the token-authenticated live counters of the per-user
// caps (lane U1) that slipgate-bff's admin user views read.
func (s *Server) registerUserLimitInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/net/dataplane/user-limits/stats", s.handleUserLimitStats)
}

// handleUserLimitStats returns {"live":true,"items":[{userId,rpmUsed,inFlight,groups:[...]}]}.
func (s *Server) handleUserLimitStats(w http.ResponseWriter, r *http.Request) {
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
	var req struct {
		UserIDs []string `json:"userIds"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		return
	}
	ids := make([]string, 0, len(req.UserIDs))
	for _, id := range req.UserIDs {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) > maxUserLimitStatsIDs {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "too many user ids"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"live": true, "items": s.dpCoord.UserLimitStats(ids)})
}
