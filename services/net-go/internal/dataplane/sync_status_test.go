package dataplane

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

// Config publish confirmation: a snapshot counts as published only once slipgate-core has
// acknowledged it; a core that rejects or cannot be reached leaves it pending (visible in
// SyncStatus) until a resync lands; an older in-flight snapshot never replaces a newer one.

const syncStatusToken = "sync-status-internal-token-0123456789"

// syncRecorder is what fakeSyncCore saw: the revision of every payload sent to it.
type syncRecorder struct {
	mu   sync.Mutex
	revs []int64
}

func (r *syncRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.revs)
}

// fakeSyncCore answers FrameSyncState with `{"ok":true}` while accept is set, `{"ok":false}`
// otherwise.
func fakeSyncCore(t *testing.T, accept *atomic.Bool, rec *syncRecorder) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
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
				inner, authErr := dpbridge.UnwrapAuthPayload(req.Flags, req.Payload, syncStatusToken)
				if authErr != nil || req.Type != dpbridge.FrameSyncState {
					return
				}
				var p struct {
					RevisionUnixMs int64 `json:"revisionUnixMs"`
				}
				_ = json.Unmarshal(inner, &p)
				rec.mu.Lock()
				rec.revs = append(rec.revs, p.RevisionUnixMs)
				rec.mu.Unlock()
				ack := `{"ok":false}`
				if accept.Load() {
					ack = `{"ok":true}`
				}
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: req.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(ack)})
			}(conn)
		}
	}()
	return ln.Addr().String()
}

func syncSnapshotAt(rev int64) SyncSnapshot {
	return SyncSnapshot{
		RevisionUnixMs: rev,
		Groups:         []SyncGroupInput{{ID: "grp_default", Platform: "composite", SubscriptionType: "balance", RateMultiplier: 1.0, Enabled: true}},
	}
}

func TestSyncCountsAsPublishedOnlyOnceCoreAcknowledges(t *testing.T) {
	var accept atomic.Bool
	rec := &syncRecorder{}
	coreAddr := fakeSyncCore(t, &accept, rec)
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: coreAddr, InternalToken: syncStatusToken, VaultSecret: "sync-status-vault-secret-0123456789abcdef"})
	ctx := context.Background()

	// Core offline (rejects): applied on the edge, pending for the core, error kept.
	accept.Store(false)
	ack, err := coord.SyncSnapshot(ctx, syncSnapshotAt(1000))
	if err == nil || ack.CoreApplied || ack.RevisionUnixMs != 1000 || ack.CoreRevisionUnixMs != 0 {
		t.Fatalf("a rejected sync must not count as applied: ack=%+v err=%v", ack, err)
	}
	st := coord.SyncStatus()
	if !st.CorePending || st.RevisionUnixMs != 1000 || st.CoreRevisionUnixMs != 0 || !strings.Contains(st.LastCoreError, "rejected") || st.LastCoreAttemptAt == nil {
		t.Fatalf("status must show the revision pending for the core: %+v", st)
	}

	// Core back: a resync from the cache lands the applied revision.
	accept.Store(true)
	if err := coord.resyncCoreFromCache(ctx); err != nil {
		t.Fatalf("resync: %v", err)
	}
	st = coord.SyncStatus()
	if st.CorePending || st.CoreRevisionUnixMs != 1000 || st.LastCoreError != "" || st.LastCoreAckAt == nil {
		t.Fatalf("after the resync the core must confirm revision 1000: %+v", st)
	}

	// A newer snapshot is acknowledged directly.
	ack, err = coord.SyncSnapshot(ctx, syncSnapshotAt(2000))
	if err != nil || !ack.CoreApplied || ack.CoreRevisionUnixMs != 2000 {
		t.Fatalf("newer snapshot: ack=%+v err=%v", ack, err)
	}

	// An older straggler is ignored: nothing changes and it never reaches the core.
	before := rec.count()
	ack, err = coord.SyncSnapshot(ctx, syncSnapshotAt(1500))
	if err != nil || !ack.Stale || ack.CoreApplied || ack.RevisionUnixMs != 2000 {
		t.Fatalf("an older snapshot must be ignored as stale: ack=%+v err=%v", ack, err)
	}
	if rec.count() != before {
		t.Fatalf("a stale snapshot must not be sent to the core")
	}
	if st = coord.SyncStatus(); st.RevisionUnixMs != 2000 || st.CoreRevisionUnixMs != 2000 || st.CorePending {
		t.Fatalf("status after a stale snapshot: %+v", st)
	}

	// A step back far beyond the tolerance is a reset control plane clock: applied.
	far := int64(2000) + int64(staleRevisionTolerance/time.Millisecond) + 5000
	if _, err := coord.SyncSnapshot(ctx, syncSnapshotAt(far)); err != nil {
		t.Fatalf("far snapshot: %v", err)
	}
	ack, err = coord.SyncSnapshot(ctx, syncSnapshotAt(3000))
	if err != nil || ack.Stale || !ack.CoreApplied || ack.CoreRevisionUnixMs != 3000 {
		t.Fatalf("a revision far back must be taken as a clock reset and applied: ack=%+v err=%v", ack, err)
	}
}

func TestSyncWithoutCoreIsPublishedOnTheEdge(t *testing.T) {
	coord := NewCoordinator(CoordinatorOptions{InternalToken: syncStatusToken, VaultSecret: "sync-status-vault-secret-0123456789abcdef"})
	ack, err := coord.SyncSnapshot(context.Background(), syncSnapshotAt(42))
	if err != nil || !ack.CoreApplied || ack.CoreRevisionUnixMs != 42 {
		t.Fatalf("without a core the edge is the last hop: ack=%+v err=%v", ack, err)
	}
	if st := coord.SyncStatus(); st.CoreConfigured || st.CorePending || st.CoreRevisionUnixMs != 42 {
		t.Fatalf("status without a core: %+v", st)
	}
}
