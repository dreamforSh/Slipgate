package dataplane

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

const (
	coreHoldReleaseAttempts = 3
	settleConfirmQueueSize  = 8192
	settleConfirmBatchSize  = 512
)

// newTurnNonce mints the token slipgate-core stores on the hold an evaluation creates, so the edge
// can release that hold even when the directive carrying its id never arrived.
func newTurnNonce() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("dataplane: crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// releaseCoreHold gives a hold back to slipgate-core uncharged, in the background: the edge lost
// track of it (the evaluation reply never arrived, or the settle report failed). A turn that did
// run is priced by the BFF instead (coreSettled=false). Name the hold by id when known, else by
// the nonce of the evaluation that created it. Holds this misses age out in the core.
func (c *Coordinator) releaseCoreHold(holdID uint64, nonce, apiKeyID string) {
	if c.coreIPC == "" || (holdID == 0 && nonce == "") {
		return
	}
	payload, err := json.Marshal(coreSettleReport{
		HoldID:      holdID,
		TurnNonce:   nonce,
		ReleaseOnly: true,
		APIKeyID:    apiKeyID,
		NowUnixMs:   time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}
	go func() {
		var lastErr error
		for attempt := range coreHoldReleaseAttempts {
			if attempt > 0 {
				time.Sleep(time.Duration(attempt) * 250 * time.Millisecond)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, lastErr = dpbridge.ExchangeAuth(ctx, c.coreIPC, c.internalToken, dpbridge.Frame{
				StreamID: c.streamSeq.Add(1),
				Type:     dpbridge.FrameSettleReport,
				Flags:    dpbridge.FlagEndStream,
				Payload:  payload,
			})
			cancel()
			if lastErr == nil {
				return
			}
		}
		c.settlements.logLimited("core-hold-release", "[dataplane] warning: slipgate-core hold not released (it is reclaimed when it ages out): %v", lastErr)
	}()
}

// settleConfirm tells slipgate-core the BFF had committed the settlement of a hold by
// AppliedAtUnixMs (BFF clock), so snapshots read after that carry its debit.
type settleConfirm struct {
	HoldID          uint64 `json:"holdId"`
	AppliedAtUnixMs int64  `json:"appliedAtUnixMs"`
}

// queueSettleConfirm hands a confirmation to the batching sender. When the queue is full the core
// keeps that debit until it ages out: it then under-admits the user, never over-admits.
func (c *Coordinator) queueSettleConfirm(sc settleConfirm) {
	if c.coreIPC == "" {
		return
	}
	c.confirmOnce.Do(func() {
		c.confirms = make(chan settleConfirm, settleConfirmQueueSize)
		go c.runSettleConfirmer()
	})
	select {
	case c.confirms <- sc:
	default:
		c.settlements.logLimited("settle-confirm-full", "[dataplane] warning: settlement confirmation queue full; hold %d stays unconfirmed in slipgate-core", sc.HoldID)
	}
}

func (c *Coordinator) runSettleConfirmer() {
	batch := make([]settleConfirm, 0, settleConfirmBatchSize)
	for sc := range c.confirms {
		batch = append(batch[:0], sc)
	fill:
		for len(batch) < settleConfirmBatchSize {
			select {
			case more := <-c.confirms:
				batch = append(batch, more)
			default:
				break fill
			}
		}
		c.sendSettleConfirms(batch)
	}
}

func (c *Coordinator) sendSettleConfirms(batch []settleConfirm) {
	payload, err := json.Marshal(map[string]any{"confirms": batch})
	if err != nil {
		return
	}
	for attempt := range 3 {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 200 * time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, err = dpbridge.ExchangeAuth(ctx, c.coreIPC, c.internalToken, dpbridge.Frame{
			StreamID: c.streamSeq.Add(1),
			Type:     dpbridge.FrameSettleConfirm,
			Flags:    dpbridge.FlagEndStream,
			Payload:  payload,
		})
		cancel()
		if err == nil {
			return
		}
	}
	c.settlements.logLimited("settle-confirm", "[dataplane] warning: %d settlement confirmation(s) not delivered to slipgate-core: %v", len(batch), err)
}

// confirmDeliveredSettlement reads the BFF's acceptance of a settlement body and queues the
// matching core confirmation.
func (c *Coordinator) confirmDeliveredSettlement(body, response []byte) {
	var ack struct {
		AppliedAtUnixMs int64 `json:"appliedAtUnixMs"`
	}
	if json.Unmarshal(response, &ack) != nil || ack.AppliedAtUnixMs <= 0 {
		return
	}
	var ev struct {
		CoreHoldID uint64 `json:"coreHoldId"`
	}
	if json.Unmarshal(body, &ev) != nil || ev.CoreHoldID == 0 {
		return
	}
	c.queueSettleConfirm(settleConfirm{HoldID: ev.CoreHoldID, AppliedAtUnixMs: ack.AppliedAtUnixMs})
}
