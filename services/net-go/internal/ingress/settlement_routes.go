package ingress

import "net/http"

// registerSettlementInternalRoutes mounts the token-authenticated view and replay of settlements
// parked in the dead-letter spool (rejected by slipgate-bff or aged out undelivered).
func (s *Server) registerSettlementInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /internal/net/dataplane/settlements/dead-letter", s.handleSettlementDeadLetters)
	mux.HandleFunc("POST /internal/net/dataplane/settlements/dead-letter/replay", s.handleReplaySettlementDeadLetters)
}

func (s *Server) handleSettlementDeadLetters(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": s.dpCoord.SettlementDeadLetters()})
}

func (s *Server) handleReplaySettlementDeadLetters(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternalAuth(w, r) {
		return
	}
	if s.dpCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dataplane_coordinator_unavailable"})
		return
	}
	n, err := s.dpCoord.ReplaySettlementDeadLetters()
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "settlement_replay_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"replayed": n})
}
