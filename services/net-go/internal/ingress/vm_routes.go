package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

func (s *Server) registerVmInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /internal/net/vms/overview", s.handleVmOverview)
	mux.HandleFunc("GET /internal/net/vms/nodes", s.handleListVmNodes)
	mux.HandleFunc("POST /internal/net/vms/nodes", s.handleCreateVmNode)
	mux.HandleFunc("DELETE /internal/net/vms/nodes/{id}", s.handleDeleteVmNode)
	mux.HandleFunc("GET /internal/net/vms/slots", s.handleListVmSlots)
	mux.HandleFunc("POST /internal/net/vms/slots", s.handleProvisionVmSlot)
	mux.HandleFunc("DELETE /internal/net/vms/slots/{id}", s.handleDeleteVmSlot)
	mux.HandleFunc("POST /internal/net/vms/slots/{id}/start", s.handleStartVmSlot)
	mux.HandleFunc("POST /internal/net/vms/slots/{id}/stop", s.handleStopVmSlot)
	mux.HandleFunc("GET /internal/net/vms/slots/{id}/seed", s.handleGetVmSeed)
	mux.HandleFunc("PUT /internal/net/vms/slots/{id}/seed", s.handleUpdateVmSeed)
	mux.HandleFunc("PATCH /internal/net/vms/slots/{id}/telemetry", s.handleUpdateVmTelemetry)
	mux.HandleFunc("POST /internal/net/vms/slots/{id}/migrate", s.handleMigrateVmSlot)
	mux.HandleFunc("POST /internal/net/vms/slots/{id}/terminal-ticket", s.handleIssueVmTerminalTicket)
}

func (s *Server) registerVmWebSocketRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws/admin/vms/terminal/{ticket}", s.handleVmTerminalWebSocket)
}

func (s *Server) requireVmCoordinator(w http.ResponseWriter, r *http.Request) *vmslot.Coordinator {
	if !s.requireInternalAuth(w, r) {
		return nil
	}
	if s.vmCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":   "vm_coordinator_unavailable",
			"message": "VM fleet coordinator is not initialized",
		})
		return nil
	}
	return s.vmCoord
}

func (s *Server) handleVmOverview(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	ov, err := coord.Overview(r.Context())
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) handleListVmNodes(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	nodes, err := coord.ListClusterNodes(r.Context())
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (s *Server) handleCreateVmNode(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	var req vmslot.RegisterClusterNodeInput
	if !decodeLimitedJSON(w, r, 128<<10, &req) {
		return
	}
	node, err := coord.RegisterClusterNode(r.Context(), req)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"node": node})
}

func (s *Server) handleDeleteVmNode(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	if err := coord.DeleteClusterNode(r.Context(), id); err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id})
}

func (s *Server) handleListVmSlots(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	ov, err := coord.Overview(r.Context())
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"slots":      ov.Slots,
		"invariants": ov.Invariants,
	})
}

func (s *Server) handleProvisionVmSlot(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	var req vmslot.ProvisionSlotInput
	if !decodeLimitedJSON(w, r, 64<<10, &req) {
		return
	}
	slot, err := coord.ProvisionSlot(r.Context(), req)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"slot": slot})
}

func (s *Server) handleDeleteVmSlot(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	if err := coord.DeleteSlot(r.Context(), id); err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "slotId": id})
}

func (s *Server) handleStartVmSlot(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	slot, err := coord.StartSlot(r.Context(), id)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slot": slot})
}

func (s *Server) handleStopVmSlot(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	slot, err := coord.StopSlot(r.Context(), id)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slot": slot})
}

func (s *Server) handleGetVmSeed(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	seed, err := coord.GetSeed(r.Context(), id)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, seed)
}

func (s *Server) handleUpdateVmSeed(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	var req vmslot.UpdateSeedInput
	if !decodeLimitedJSON(w, r, 128<<10, &req) {
		return
	}
	actor := r.Header.Get("X-Slipgate-Actor")
	seed, err := coord.UpdateSeed(r.Context(), id, req, actor)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, seed)
}

func (s *Server) handleUpdateVmTelemetry(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	var req struct {
		TelemetryMode vmslot.TelemetryMode `json:"telemetryMode"`
		CleanseMode   string               `json:"cleanseMode"`
	}
	if !decodeLimitedJSON(w, r, 16<<10, &req) {
		return
	}
	slot, err := coord.UpdateTelemetry(r.Context(), id, req.TelemetryMode, req.CleanseMode)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slot": slot})
}

func (s *Server) handleMigrateVmSlot(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	var req struct {
		TargetClusterNodeID string `json:"targetClusterNodeId"`
		TargetMemoryMiB     uint32 `json:"targetMemoryMiB"`
	}
	if !decodeLimitedJSON(w, r, 16<<10, &req) {
		return
	}
	slot, job, err := coord.MigrateOrResizeSlot(r.Context(), id, req.TargetClusterNodeID, req.TargetMemoryMiB)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slot": slot, "migration": job})
}

func (s *Server) handleIssueVmTerminalTicket(w http.ResponseWriter, r *http.Request) {
	coord := s.requireVmCoordinator(w, r)
	if coord == nil {
		return
	}
	id := r.PathValue("id")
	actor := r.Header.Get("X-Slipgate-Actor")
	ticket, err := coord.IssueTerminalTicket(id, actor)
	if err != nil {
		writeVmError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ticket)
}

func (s *Server) handleVmTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	if s.vmCoord == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "vm_coordinator_unavailable"})
		return
	}
	ticketID := r.PathValue("ticket")
	ticket, err := s.vmCoord.ConsumeTerminalTicket(ticketID)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error":   "invalid_terminal_ticket",
			"message": err.Error(),
		})
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Protected strictly by cryptographic single-use ticket in path.
	})
	if err != nil {
		return
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()

	_ = writeWSJSON(ctx, wsConn, map[string]any{
		"type":     "banner",
		"slotId":   ticket.SlotID,
		"stdout":   "Slipgate jailed VM diagnostic console connected to " + ticket.SlotID + ". Type 'help' for commands.\n",
		"exitCode": 0,
		"ts":       time.Now().UTC().Format(time.RFC3339),
	})

	for {
		msgType, raw, readErr := wsConn.Read(ctx)
		if readErr != nil {
			_ = wsConn.Close(websocket.StatusNormalClosure, "session closed")
			return
		}
		if msgType != websocket.MessageText && msgType != websocket.MessageBinary {
			continue
		}

		cmd := strings.TrimSpace(string(raw))
		if strings.HasPrefix(cmd, "{") {
			var envelope struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			}
			if json.Unmarshal(raw, &envelope) == nil && envelope.Command != "" {
				cmd = strings.TrimSpace(envelope.Command)
			}
		}
		if cmd == "" {
			continue
		}
		if cmd == "exit" || cmd == "quit" {
			_ = wsConn.Close(websocket.StatusNormalClosure, "bye")
			return
		}

		res, execErr := s.vmCoord.ExecSlotCommand(ctx, ticket.SlotID, ticket.Actor, cmd)
		payload := map[string]any{
			"type":     "output",
			"slotId":   ticket.SlotID,
			"command":  cmd,
			"stdout":   res.Stdout,
			"stderr":   res.Stderr,
			"exitCode": res.ExitCode,
			"ts":       time.Now().UTC().Format(time.RFC3339),
		}
		if execErr != nil && payload["stderr"] == "" {
			payload["stderr"] = execErr.Error()
			payload["exitCode"] = 1
		}
		if writeErr := writeWSJSON(ctx, wsConn, payload); writeErr != nil {
			return
		}
	}
}

func writeWSJSON(ctx context.Context, conn *websocket.Conn, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

func mapVmErrorStatus(err error) int {
	switch {
	case errors.Is(err, vmslot.ErrSlotNotFound),
		errors.Is(err, vmslot.ErrClusterNodeNotFound),
		errors.Is(err, vmslot.ErrSeedNotFound):
		return http.StatusNotFound
	case errors.Is(err, vmslot.ErrSharedSlotEgress),
		errors.Is(err, vmslot.ErrImmutableMachineID),
		errors.Is(err, vmslot.ErrSlotNotDrained),
		errors.Is(err, vmslot.ErrClusterNodeProtected):
		return http.StatusConflict
	case errors.Is(err, vmslot.ErrSlotEgressUnavailable):
		return http.StatusServiceUnavailable
	case errors.Is(err, vmslot.ErrInvalidHardwarePersona),
		errors.Is(err, vmslot.ErrMigrationUnsupported):
		return http.StatusBadRequest
	default:
		return http.StatusBadRequest
	}
}

func writeVmError(w http.ResponseWriter, err error) {
	writeJSON(w, mapVmErrorStatus(err), map[string]any{
		"error":   "vm_operation_failed",
		"message": err.Error(),
	})
}
