package vmslot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

// GuestDirective captures the JSON payload returned by slipgate-guestd for health and turn handoffs.
type GuestDirective struct {
	Daemon          string `json:"daemon"`
	Version         string `json:"version"`
	SlotID          string `json:"slot_id"`
	GuestMachineID  string `json:"guest_machine_id"`
	RuntimeProfile  string `json:"runtime_profile"`
	NativeHandoffV1 bool   `json:"native_handoff_v1"`
	MaxSubagents    uint32 `json:"max_subagents"`
	CleanseMode     string `json:"cleanse_mode"`
	TelemetryMode   string `json:"telemetry_mode"`
}

// ErrGuestMachineIDMismatch is returned when slipgate-guestd reports a different machine ID than expected.
var ErrGuestMachineIDMismatch = errors.New("vmslot: guest_machine_id mismatch")

// VerifyGuestExitHealth probes slipgate-guestd via FrameExitHealth and fails closed on identity mismatch.
func VerifyGuestExitHealth(ctx context.Context, endpoint, token, expectedMachineID string) (GuestDirective, error) {
	ep := strings.TrimSpace(endpoint)
	if ep == "" {
		return GuestDirective{}, errors.New("vmslot: empty guestd endpoint")
	}
	// Counted so a graceful restart never retires the daemon under this exchange.
	defer beginGuestCall(ep)()
	reply, err := dpbridge.ExchangeAuth(ctx, ep, token, dpbridge.Frame{
		StreamID: 1,
		Type:     dpbridge.FrameExitHealth,
		Flags:    dpbridge.FlagEndStream,
	})
	if err != nil {
		return GuestDirective{}, err
	}
	return parseAndVerifyGuestReply(reply, dpbridge.FrameExitHealth, expectedMachineID)
}

// HandoffGuestTurn delivers request metadata over FrameReqHeaders to slipgate-guestd and verifies its directive.
// Only when token is empty and a legacy ping-only guestd closes on EOF immediately does it fall back to Ping.
func HandoffGuestTurn(ctx context.Context, endpoint, token, expectedMachineID string, reqMeta []byte) (GuestDirective, bool, error) {
	ep := strings.TrimSpace(endpoint)
	if ep == "" {
		return GuestDirective{}, false, errors.New("vmslot: empty guestd endpoint")
	}
	// Counted so a graceful restart never retires the daemon under this exchange.
	defer beginGuestCall(ep)()
	reply, err := dpbridge.ExchangeAuth(ctx, ep, token, dpbridge.Frame{
		StreamID: 1,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  reqMeta,
	})
	if err != nil {
		if strings.TrimSpace(token) == "" && errors.Is(err, io.EOF) {
			if pingErr := dpbridge.Ping(ctx, ep); pingErr != nil {
				return GuestDirective{}, false, pingErr
			}
			return GuestDirective{}, false, nil
		}
		return GuestDirective{}, false, err
	}
	directive, err := parseAndVerifyGuestReply(reply, dpbridge.FrameDispatchDirective, expectedMachineID)
	if err != nil {
		return directive, false, err
	}
	return directive, true, nil
}

func parseAndVerifyGuestReply(reply dpbridge.Frame, expectedType dpbridge.FrameType, expectedMachineID string) (GuestDirective, error) {
	if (reply.Flags & dpbridge.FlagError) != 0 {
		msg := strings.TrimSpace(string(reply.Payload))
		if msg == "" {
			msg = "guestd returned error frame"
		}
		return GuestDirective{}, fmt.Errorf("vmslot: guestd error: %s", msg)
	}
	if reply.Type != expectedType {
		return GuestDirective{}, fmt.Errorf("vmslot: unexpected guestd frame type 0x%02x (want 0x%02x)", uint8(reply.Type), uint8(expectedType))
	}
	payload, err := dpbridge.UnwrapAuthPayload(reply.Flags, reply.Payload, "")
	if err != nil {
		return GuestDirective{}, err
	}
	var directive GuestDirective
	if err := json.Unmarshal(payload, &directive); err != nil {
		return GuestDirective{}, fmt.Errorf("vmslot: invalid guestd directive JSON: %w", err)
	}
	if exp := strings.TrimSpace(expectedMachineID); exp != "" {
		got := strings.TrimSpace(directive.GuestMachineID)
		if !strings.EqualFold(got, exp) {
			return directive, fmt.Errorf("%w: expected %s got %q", ErrGuestMachineIDMismatch, exp, got)
		}
	}
	return directive, nil
}
