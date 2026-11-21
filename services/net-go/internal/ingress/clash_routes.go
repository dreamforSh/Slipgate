package ingress

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
)

func (s *Server) registerClashInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /internal/net/clash/overview", s.handleClashOverview)
	mux.HandleFunc("GET /internal/net/clash/nodes", s.handleClashNodes)
	mux.HandleFunc("POST /internal/net/clash/subscriptions", s.handleCreateClashSubscription)
	mux.HandleFunc("POST /internal/net/clash/subscriptions/{id}/sync", s.handleSyncClashSubscription)
	mux.HandleFunc("DELETE /internal/net/clash/subscriptions/{id}", s.handleDeleteClashSubscription)
	mux.HandleFunc("POST /internal/net/clash/nodes/probe", s.handleProbeClashNodes)
	mux.HandleFunc("POST /internal/net/clash/nodes/{id}/confirm-drift", s.handleConfirmClashDrift)
	mux.HandleFunc("PATCH /internal/net/clash/nodes/{id}", s.handlePatchClashNode)
	mux.HandleFunc("POST /internal/net/clash/bindings", s.handleBindAccountExit)
	mux.HandleFunc("DELETE /internal/net/clash/bindings/{accountId}", s.handleUnbindAccountExit)
	mux.HandleFunc("POST /internal/net/clash/test-outbound", s.handleTestClashOutbound)
	mux.HandleFunc("GET /internal/net/tls-profiles", s.handleListTLSProfiles)
	mux.HandleFunc("POST /internal/net/tls-profiles", s.handleCreateTLSProfile)
	mux.HandleFunc("DELETE /internal/net/tls-profiles/{id}", s.handleDeleteTLSProfile)
}

func (s *Server) requireClashCoordinator(w http.ResponseWriter, r *http.Request) *clashpool.Coordinator {
	if !s.requireInternalAuth(w, r) {
		return nil
	}
	if s.clashCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":   "clash_unavailable",
			"message": "Clash pool coordinator is not initialized",
		})
		return nil
	}
	return s.clashCoord
}

func (s *Server) handleClashOverview(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	overview, err := coord.Overview(r.Context())
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *Server) handleClashNodes(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	overview, err := coord.Overview(r.Context())
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"runtime": overview.Runtime,
		"nodes":   overview.Nodes,
		"policy":  overview.Policy,
	})
}

func (s *Server) handleCreateClashSubscription(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	var input clashpool.CreateSubscriptionInput
	if !decodeLimitedJSON(w, r, 1<<20, &input) {
		return
	}
	sub, syncRes, err := coord.CreateSubscription(r.Context(), input)
	if err != nil {
		writeJSON(w, mapClashErrorStatus(err), map[string]any{
			"error":        "subscription_sync_failed",
			"message":      err.Error(),
			"subscription": sub,
			"sync":         syncRes,
		})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"subscription": sub,
		"sync":         syncRes,
	})
}

func (s *Server) handleSyncClashSubscription(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	subID := r.PathValue("id")
	var req struct {
		Force bool `json:"force"`
	}
	_ = decodeOptionalJSON(r, 16<<10, &req)

	res, err := coord.SyncSubscription(r.Context(), subID, req.Force)
	if err != nil {
		writeJSON(w, mapClashErrorStatus(err), map[string]any{
			"error":   "sync_failed",
			"message": err.Error(),
			"sync":    res,
		})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleDeleteClashSubscription(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	subID := r.PathValue("id")
	if err := coord.DeleteSubscription(r.Context(), subID); err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":        true,
		"subscriptionId": subID,
	})
}

func (s *Server) handleProbeClashNodes(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	req := struct {
		NodeIDs      []string `json:"nodeIds"`
		VerifyExitIP bool     `json:"verifyExitIp"`
	}{
		VerifyExitIP: true,
	}
	if !decodeOptionalJSON(r, 64<<10, &req) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	results, err := coord.ProbeNodes(r.Context(), req.NodeIDs, req.VerifyExitIP, false)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"results": results,
	})
}

func (s *Server) handleConfirmClashDrift(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	nodeID := r.PathValue("id")
	node, err := coord.ConfirmDrift(r.Context(), nodeID)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodeId":           node.ID,
		"exitIp":           node.ExitIP,
		"healthStatus":     node.Health,
		"driftUnconfirmed": node.DriftUnconfirmed,
	})
}

func (s *Server) handlePatchClashNode(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	nodeID := r.PathValue("id")
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeLimitedJSON(w, r, 16<<10, &req) {
		return
	}
	node, err := coord.SetNodeEnabled(r.Context(), nodeID, req.Enabled)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodeId":       node.ID,
		"enabled":      node.Enabled,
		"healthStatus": node.Health,
	})
}

func (s *Server) handleBindAccountExit(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	var req struct {
		AccountID        string `json:"accountId"`
		NodeID           string `json:"nodeId"`
		UTLSProfileID    string `json:"utlsProfileId"`
		IsShadowFollower bool   `json:"isShadowFollower"`
	}
	if !decodeLimitedJSON(w, r, 32<<10, &req) {
		return
	}
	rec, err := coord.BindAccount(r.Context(), req.AccountID, req.NodeID, req.UTLSProfileID, req.IsShadowFollower)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": rec})
}

func (s *Server) handleUnbindAccountExit(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	accountID := r.PathValue("accountId")
	if err := coord.UnbindAccount(r.Context(), accountID); err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":   true,
		"accountId": accountID,
	})
}

func (s *Server) handleTestClashOutbound(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	var req struct {
		AccountID     string `json:"accountId"`
		UTLSProfileID string `json:"utlsProfileId"`
		TargetURL     string `json:"targetUrl"`
	}
	if !decodeLimitedJSON(w, r, 32<<10, &req) {
		return
	}
	meta, err := coord.TestAccountOutbound(r.Context(), req.AccountID, req.UTLSProfileID, req.TargetURL)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accountId":      req.AccountID,
		"nodeId":         meta.Target.NodeID,
		"proxySlotId":    meta.Target.ProxySlotID,
		"exitIp":         meta.Target.ExitIP,
		"statusCode":     meta.StatusCode,
		"tlsVersion":     meta.TLSVersion,
		"negotiatedAlpn": meta.NegotiatedALPN,
		"latencyMs":      meta.LatencyMS,
		"bodySnippet":    meta.BodySnippet,
	})
}

func (s *Server) handleListTLSProfiles(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	profiles := coord.ListTLSProfiles()
	if profiles == nil {
		profiles = []clashpool.TLSProfile{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": profiles})
}

func (s *Server) handleCreateTLSProfile(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	var req clashpool.TLSProfile
	if !decodeLimitedJSON(w, r, 64<<10, &req) {
		return
	}
	created, err := coord.CreateTLSProfile(r.Context(), req)
	if err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"profile": created})
}

func (s *Server) handleDeleteTLSProfile(w http.ResponseWriter, r *http.Request) {
	coord := s.requireClashCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	if err := coord.DeleteTLSProfile(r.Context(), id); err != nil {
		writeClashError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": true,
		"id":      id,
	})
}

func decodeLimitedJSON(w http.ResponseWriter, r *http.Request, limit int64, dest any) bool {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "empty request body"})
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "empty request body"})
		return false
	}
	if err := json.Unmarshal(raw, dest); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		return false
	}
	return true
}

func decodeOptionalJSON(r *http.Request, limit int64, dest any) bool {
	if r.Body == nil {
		return true
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit))
	if err != nil {
		return false
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return true
	}
	return json.Unmarshal(raw, dest) == nil
}

func mapClashErrorStatus(err error) int {
	switch {
	case errors.Is(err, clashpool.ErrNodeNotFound),
		errors.Is(err, clashpool.ErrSubscriptionNotFound),
		errors.Is(err, clashpool.ErrProfileNotFound),
		errors.Is(err, stealth.ErrUnknownProfile):
		return http.StatusNotFound
	case errors.Is(err, clashpool.ErrExitCapacityExceeded),
		errors.Is(err, clashpool.ErrDropGuardTriggered):
		return http.StatusConflict
	case errors.Is(err, stealth.ErrBuiltInProfileLock):
		return http.StatusForbidden
	case errors.Is(err, clashpool.ErrExitCircuitOpen):
		return http.StatusServiceUnavailable
	default:
		return http.StatusBadRequest
	}
}

func writeClashError(w http.ResponseWriter, err error) {
	writeJSON(w, mapClashErrorStatus(err), map[string]any{
		"error":   "clash_operation_failed",
		"message": err.Error(),
	})
}
