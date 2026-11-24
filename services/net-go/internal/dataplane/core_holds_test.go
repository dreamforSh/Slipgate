package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

const coreHoldsToken = "core-holds-token"

// recordingCore records every frame it receives; reply returns the answer to send, or false to
// drop the connection without answering (the reply is lost).
type recordingCore struct {
	addr   string
	mu     sync.Mutex
	frames []dpbridge.Frame
}

func newRecordingCore(t *testing.T, reply func(dpbridge.Frame) (dpbridge.Frame, bool)) *recordingCore {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	rc := &recordingCore{addr: ln.Addr().String()}
	go func() {
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, rErr := dpbridge.ReadFrame(c)
				if rErr != nil {
					return
				}
				inner, uErr := dpbridge.UnwrapAuthPayload(req.Flags, req.Payload, coreHoldsToken)
				if uErr != nil {
					return
				}
				req.Payload = inner
				rc.mu.Lock()
				rc.frames = append(rc.frames, req)
				rc.mu.Unlock()
				if ans, ok := reply(req); ok {
					ans.StreamID = req.StreamID
					ans.Flags = dpbridge.FlagEndStream
					_ = dpbridge.WriteFrame(c, ans)
				}
			}(conn)
		}
	}()
	return rc
}

func (rc *recordingCore) ofType(typ dpbridge.FrameType) []dpbridge.Frame {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	var out []dpbridge.Frame
	for _, f := range rc.frames {
		if f.Type == typ {
			out = append(out, f)
		}
	}
	return out
}

func dispatchReply(holdID uint64) dpbridge.Frame {
	payload, _ := json.Marshal(coreDispatchDirective{
		Action:        "dispatch",
		Status:        200,
		HoldID:        holdID,
		UserID:        "usr_1",
		APIKeyID:      "key_1",
		GroupID:       "grp_default",
		AccountID:     "acc_mock",
		Provider:      "anthropic",
		ExecutionMode: "direct_api",
		PublicModel:   "claude-sonnet-4-5",
		UpstreamModel: "claude-sonnet-4-5",
		HoldNanoUSD:   "1000",
	})
	return dpbridge.Frame{Type: dpbridge.FrameDispatchDirective, Payload: payload}
}

func coreTestCoordinator(t *testing.T, coreAddr, bffURL string) *Coordinator {
	t.Helper()
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: coreAddr, BFFOrigin: bffURL, InternalToken: coreHoldsToken, VaultSecret: "core-holds-vault"})
	enc, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		Accounts: []SyncAccountInput{{ID: "acc_mock", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "direct_api", CredentialsEncHex: enc, MaxConcurrency: 4, Status: "active"}},
		APIKeys:  []SyncApiKeyInput{{ID: "key_1", UserID: "usr_1", GroupID: "grp_default", KeyHashHex: sha256HexOf("sk-sg-test"), Enabled: true}},
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	return coord
}

func runTurn(t *testing.T, coord *Coordinator) int {
	t.Helper()
	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()
	req, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("x-api-key", "sk-sg-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("turn: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestAcceptedSettlementIsConfirmedToTheCore(t *testing.T) {
	t.Parallel()
	const holdID = uint64(7_000_001)
	var gotHoldID, gotRate atomic.Uint64
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ev TurnSettlementEvent
		_ = json.NewDecoder(r.Body).Decode(&ev)
		gotHoldID.Store(ev.CoreHoldID)
		gotRate.Store(ev.CoreRateMultiplierMicros)
		_, _ = w.Write([]byte(`{"ok":true,"appliedAtUnixMs":1700000003000}`))
	}))
	defer bff.Close()
	core := newRecordingCore(t, func(f dpbridge.Frame) (dpbridge.Frame, bool) {
		switch f.Type {
		case dpbridge.FrameReqHeaders:
			return dispatchReply(holdID), true
		case dpbridge.FrameSettleReport:
			return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"500","balanceAfterNanoUsd":"999500","ordinaryUpstream400Exempted":false,"rateMultiplierMicros":2500000}`)}, true
		default:
			return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true}`)}, true
		}
	})
	coord := coreTestCoordinator(t, core.addr, bff.URL)

	if status := runTurn(t, coord); status != http.StatusOK {
		t.Fatalf("turn status %d", status)
	}
	waitFor(t, "settlement confirmation", func() bool { return len(core.ofType(dpbridge.FrameSettleConfirm)) == 1 })
	if gotHoldID.Load() != holdID {
		t.Fatalf("the settlement must carry the core hold id, got %d", gotHoldID.Load())
	}
	// The BFF must know the rate the core priced at, or it applies a custom user rate twice.
	if gotRate.Load() != 2_500_000 {
		t.Fatalf("the settlement must carry the core's rate multiplier, got %d", gotRate.Load())
	}
	var batch struct {
		Confirms []settleConfirm `json:"confirms"`
	}
	if err := json.Unmarshal(core.ofType(dpbridge.FrameSettleConfirm)[0].Payload, &batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.Confirms) != 1 || batch.Confirms[0] != (settleConfirm{HoldID: holdID, AppliedAtUnixMs: 1700000003000}) {
		t.Fatalf("unexpected confirmation %+v", batch.Confirms)
	}
}

func TestLostEvaluationReplyReleasesTheHoldByNonce(t *testing.T) {
	t.Parallel()
	core := newRecordingCore(t, func(f dpbridge.Frame) (dpbridge.Frame, bool) {
		if f.Type == dpbridge.FrameReqHeaders {
			return dpbridge.Frame{}, false // processed, but the reply never reaches the edge
		}
		return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"0"}`)}, true
	})
	coord := coreTestCoordinator(t, core.addr, "")

	if status := runTurn(t, coord); status != http.StatusServiceUnavailable {
		t.Fatalf("a lost core reply must fail the turn, got %d", status)
	}
	waitFor(t, "release by nonce", func() bool { return len(core.ofType(dpbridge.FrameSettleReport)) == 1 })
	var eval coreTurnEvalRequest
	_ = json.Unmarshal(core.ofType(dpbridge.FrameReqHeaders)[0].Payload, &eval)
	var release coreSettleReport
	_ = json.Unmarshal(core.ofType(dpbridge.FrameSettleReport)[0].Payload, &release)
	if eval.TurnNonce == "" || release.TurnNonce != eval.TurnNonce || !release.ReleaseOnly || release.HoldID != 0 {
		t.Fatalf("expected an uncharged release by the evaluation's nonce, eval=%q release=%+v", eval.TurnNonce, release)
	}
}

func TestFailedSettleReleasesTheHold(t *testing.T) {
	t.Parallel()
	const holdID = uint64(7_000_002)
	var settles atomic.Int32
	core := newRecordingCore(t, func(f dpbridge.Frame) (dpbridge.Frame, bool) {
		switch f.Type {
		case dpbridge.FrameReqHeaders:
			return dispatchReply(holdID), true
		case dpbridge.FrameSettleReport:
			if settles.Add(1) <= 2 {
				return dpbridge.Frame{}, false // both settle attempts lose their reply
			}
			return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"0"}`)}, true
		default:
			return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true}`)}, true
		}
	})
	coord := coreTestCoordinator(t, core.addr, "")

	if status := runTurn(t, coord); status != http.StatusOK {
		t.Fatalf("turn status %d", status)
	}
	waitFor(t, "release after the failed settle", func() bool { return len(core.ofType(dpbridge.FrameSettleReport)) == 3 })
	var release coreSettleReport
	_ = json.Unmarshal(core.ofType(dpbridge.FrameSettleReport)[2].Payload, &release)
	if release.HoldID != holdID || !release.ReleaseOnly || release.APIKeyID != "key_1" {
		t.Fatalf("expected an uncharged release of hold %d, got %+v", holdID, release)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(core.ofType(dpbridge.FrameSettleReport)); n != 3 {
		t.Fatalf("a successful release must not be retried, saw %d settle frames", n)
	}
}
