package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func fastOutbox(post func(ctx context.Context, body []byte) (int, error), spoolDir string) *settlementOutbox {
	o := newSettlementOutbox(post, log.New(io.Discard, "", 0), spoolDir)
	o.baseBackoff = 5 * time.Millisecond
	o.maxBackoff = 20 * time.Millisecond
	o.attemptWait = time.Second
	return o
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestNewSettlementIDIsServerUnique(t *testing.T) {
	t.Parallel()
	seen := make(map[string]bool)
	for range 1000 {
		id := newSettlementID()
		if !isSettlementID(id) {
			t.Fatalf("malformed settlement id %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate settlement id %q", id)
		}
		seen[id] = true
	}
	if isSettlementID("abcd") || isSettlementID("stl_../../etc/passwd_______________") {
		t.Fatal("isSettlementID accepted a foreign value")
	}
}

func TestSettlementIDsAreTimeOrdered(t *testing.T) {
	t.Parallel()
	first := newSettlementID()
	time.Sleep(3 * time.Millisecond)
	second := newSettlementID()
	// Later ids sort after earlier ones, so the BFF's primary-key index grows at its right edge.
	if !(first < second) {
		t.Fatalf("settlement ids are not time-ordered: %s then %s", first, second)
	}
	// The random tail still differs within one millisecond.
	a, b := newSettlementID(), newSettlementID()
	if a == b || a[4:16] > b[4:16] {
		t.Fatalf("unexpected same-millisecond ids %s %s", a, b)
	}
}

func TestSettlementOutboxRetriesTransientFailuresUntilAccepted(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	var mu sync.Mutex
	var bodies [][]byte
	o := fastOutbox(func(_ context.Context, body []byte) (int, error) {
		mu.Lock()
		bodies = append(bodies, append([]byte(nil), body...))
		mu.Unlock()
		switch calls.Add(1) {
		case 1:
			return 0, errors.New("connection refused")
		case 2:
			return http.StatusServiceUnavailable, nil
		case 3:
			return http.StatusForbidden, nil // BFF restarting with a fresh token: still retried
		default:
			return http.StatusOK, nil
		}
	}, "")
	id := newSettlementID()
	<-o.deliver(id, []byte(`{"settlementId":"`+id+`"}`))
	waitFor(t, "delivery", func() bool { return o.delivered.Load() == 1 })
	if got := calls.Load(); got != 4 {
		t.Fatalf("expected 4 attempts, got %d", got)
	}
	if o.pendingCount() != 0 || o.dropped.Load() != 0 {
		t.Fatalf("expected empty queue and no drops, pending=%d dropped=%d", o.pendingCount(), o.dropped.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	for _, b := range bodies {
		if !bytes.Equal(b, bodies[0]) {
			t.Fatalf("redelivery changed the body (and with it the idempotency key): %s vs %s", b, bodies[0])
		}
	}
	// The worker exits once the queue is empty.
	waitFor(t, "idle worker", func() bool {
		o.mu.Lock()
		defer o.mu.Unlock()
		return !o.running
	})
}

func TestSettlementOutboxDropsPermanentRejectionsWithoutRetry(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		calls.Add(1)
		return http.StatusBadRequest, nil
	}, "")
	<-o.deliver(newSettlementID(), []byte(`{}`))
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 1 || o.dropped.Load() != 1 || o.pendingCount() != 0 {
		t.Fatalf("expected one attempt and a drop, calls=%d dropped=%d pending=%d", calls.Load(), o.dropped.Load(), o.pendingCount())
	}
}

func TestSettlementOutboxIsBoundedAndAgesOut(t *testing.T) {
	t.Parallel()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, "")
	o.maxPending = 2
	o.maxAge = 80 * time.Millisecond
	for range 3 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	if o.dropped.Load() != 1 {
		t.Fatalf("expected the third failure to overflow the bounded queue, dropped=%d", o.dropped.Load())
	}
	waitFor(t, "age-out", func() bool { return o.pendingCount() == 0 })
	if o.dropped.Load() != 3 {
		t.Fatalf("expected queued events to age out, dropped=%d", o.dropped.Load())
	}
}

func TestSettlementOutboxPausesWholeQueueWhileBFFIsDown(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	var up atomic.Bool
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		calls.Add(1)
		if up.Load() {
			return http.StatusOK, nil
		}
		return 0, errors.New("down")
	}, "")
	o.baseBackoff = 40 * time.Millisecond
	o.maxBackoff = 40 * time.Millisecond
	for range 20 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	time.Sleep(130 * time.Millisecond)
	// 20 first attempts plus roughly one retry per backoff period, not 20 per pass.
	if got := calls.Load(); got > 30 {
		t.Fatalf("retry loop hammered a down BFF: %d attempts", got)
	}
	up.Store(true)
	waitFor(t, "backlog drained", func() bool { return o.delivered.Load() == 20 })
}

func TestSettlementOutboxPoisonEventDoesNotBlockOthers(t *testing.T) {
	t.Parallel()
	poison := newSettlementID()
	var bffUp atomic.Bool
	o := fastOutbox(func(_ context.Context, body []byte) (int, error) {
		if bytes.Contains(body, []byte(poison)) {
			return http.StatusInternalServerError, nil
		}
		if !bffUp.Load() {
			return 0, errors.New("down")
		}
		return http.StatusOK, nil
	}, "")
	o.maxAge = 2 * time.Second // let the poison event age out once the test is done
	<-o.deliver(poison, []byte(`{"settlementId":"`+poison+`"}`))
	for range 3 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	bffUp.Store(true)
	waitFor(t, "healthy events delivered past the poison one", func() bool { return o.delivered.Load() == 3 })
	if o.pendingCount() != 1 {
		t.Fatalf("expected only the poison event to stay queued, got %d", o.pendingCount())
	}
}

func TestSettlementOutboxSpoolSurvivesRestart(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	down := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, dir)
	id := newSettlementID()
	body := []byte(`{"settlementId":"` + id + `","costNanoUsd":"42"}`)
	<-down.deliver(id, body)
	spooled := filepath.Join(dir, id+".json")
	waitFor(t, "spool file", func() bool {
		_, err := os.Stat(spooled)
		return err == nil
	})

	// A new process (new outbox) re-queues it and delivers the identical body.
	var got []byte
	var mu sync.Mutex
	up := fastOutbox(func(_ context.Context, b []byte) (int, error) {
		mu.Lock()
		got = append([]byte(nil), b...)
		mu.Unlock()
		return http.StatusOK, nil
	}, dir)
	if n := up.loadSpool(); n != 1 {
		t.Fatalf("expected 1 spooled settlement, got %d", n)
	}
	waitFor(t, "spooled delivery", func() bool { return up.delivered.Load() == 1 })
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(got, body) {
		t.Fatalf("spooled body changed: %s", got)
	}
	if _, err := os.Stat(spooled); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("delivered settlement still spooled: %v", err)
	}
}

func spoolFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestSettlementOutboxSpoolsBeforeTheFirstAttempt(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	id := newSettlementID()
	var onDiskDuringPost atomic.Bool
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		// A crash or restart right now must not lose the event.
		_, err := os.Stat(filepath.Join(dir, id+".json"))
		onDiskDuringPost.Store(err == nil)
		return http.StatusOK, nil
	}, dir)
	<-o.deliver(id, []byte(`{"settlementId":"`+id+`"}`))
	if !onDiskDuringPost.Load() {
		t.Fatal("settlement was not on disk while its first POST was in flight")
	}
	if names := spoolFiles(t, dir); len(names) != 0 {
		t.Fatalf("accepted settlement still spooled: %v", names)
	}
}

func TestSettlementOutboxSpillsToDiskInsteadOfDropping(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	var up atomic.Bool
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		if up.Load() {
			return http.StatusOK, nil
		}
		return 0, errors.New("down")
	}, dir)
	o.maxPending = 2
	for range 6 {
		id := newSettlementID()
		<-o.deliver(id, []byte(`{"settlementId":"`+id+`"}`))
	}
	if o.dropped.Load() != 0 {
		t.Fatalf("a full memory queue must spill to disk, not drop: dropped=%d", o.dropped.Load())
	}
	if got := o.pendingCount(); got != 2 {
		t.Fatalf("expected the memory queue to stay at its bound, got %d", got)
	}
	if got := o.undeliveredCount(); got != 6 {
		t.Fatalf("expected 6 undelivered (2 in memory, 4 on disk), got %d", got)
	}
	if names := spoolFiles(t, dir); len(names) != 6 {
		t.Fatalf("expected 6 spool files, got %v", names)
	}
	up.Store(true)
	waitFor(t, "memory and disk backlog drained", func() bool { return o.delivered.Load() == 6 })
	waitFor(t, "spool emptied", func() bool { return len(spoolFiles(t, dir)) == 0 && o.undeliveredCount() == 0 })
}

func TestSettlementOutboxSpillBoundStillDrops(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, dir)
	o.maxPending = 1
	o.maxSpilled = 1
	for range 3 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	if o.dropped.Load() != 1 || o.undeliveredCount() != 2 {
		t.Fatalf("expected 1 in memory, 1 on disk and 1 drop; dropped=%d undelivered=%d", o.dropped.Load(), o.undeliveredCount())
	}
	if names := spoolFiles(t, dir); len(names) != 2 {
		t.Fatalf("a dropped settlement must not stay spooled: %v", names)
	}
}

func TestSettlementOutboxPausedQueueDoesNotSpin(t *testing.T) {
	t.Parallel()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, "")
	o.baseBackoff = time.Second
	o.maxBackoff = time.Second
	<-o.deliver(newSettlementID(), []byte(`{}`))
	// Pause the queue as a failed pass would (the BFF is down).
	o.mu.Lock()
	o.pauseUntil = time.Now().Add(time.Minute)
	o.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	before := o.wakeups.Load()
	for range 300 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	time.Sleep(20 * time.Millisecond)
	if woke := o.wakeups.Load() - before; woke > 2 {
		t.Fatalf("each failed delivery woke the paused worker: %d wakeups for 300 enqueues", woke)
	}
	if got := o.pendingCount(); got != 301 {
		t.Fatalf("expected 301 queued, got %d", got)
	}
}

func TestSettlementOutboxFlushDeliversQueuedSettlements(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	var up atomic.Bool
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		if up.Load() {
			return http.StatusOK, nil
		}
		return http.StatusInternalServerError, nil
	}, dir)
	// Long backoff: without the flush these would wait an hour.
	o.baseBackoff = time.Hour
	o.maxBackoff = time.Hour
	for range 5 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	up.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if left := o.flush(ctx); left != 0 {
		t.Fatalf("flush left %d settlements behind a healthy BFF", left)
	}
	if o.delivered.Load() != 5 || len(spoolFiles(t, dir)) != 0 {
		t.Fatalf("expected 5 delivered and an empty spool, delivered=%d spool=%v", o.delivered.Load(), spoolFiles(t, dir))
	}
}

func TestSettlementOutboxFlushReturnsPromptlyWhenBFFIsDown(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, dir)
	o.baseBackoff = time.Hour
	o.maxBackoff = time.Hour
	for range 3 {
		<-o.deliver(newSettlementID(), []byte(`{}`))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if left := o.flush(ctx); left != 3 {
		t.Fatalf("expected 3 undelivered, got %d", left)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("flush waited %s on a down BFF", took)
	}
	// Still on disk for the next start.
	if names := spoolFiles(t, dir); len(names) != 3 {
		t.Fatalf("expected 3 spooled settlements, got %v", names)
	}
}

func TestSettlementOutboxSkipsTornSpoolFiles(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	torn := newSettlementID()
	if err := os.WriteFile(filepath.Join(dir, torn+".json"), []byte(`{"settlementId":"stl_`), 0o600); err != nil {
		t.Fatal(err)
	}
	o := fastOutbox(func(context.Context, []byte) (int, error) { return http.StatusOK, nil }, dir)
	if n := o.loadSpool(); n != 0 {
		t.Fatalf("a torn spool file must not be delivered, loaded %d", n)
	}
	if o.dropped.Load() != 1 || len(spoolFiles(t, dir)) != 0 {
		t.Fatalf("expected the torn file to be dropped and removed, dropped=%d", o.dropped.Load())
	}
}

func spooledSettlements(t *testing.T, dir string) []string {
	t.Helper()
	var names []string
	for _, name := range spoolFiles(t, dir) {
		if strings.HasSuffix(name, ".json") {
			names = append(names, name)
		}
	}
	return names
}

func TestSettlementOutboxParksRejectedSettlementsForReplay(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	var accepted atomic.Bool
	var calls atomic.Int32
	o := fastOutbox(func(context.Context, []byte) (int, error) {
		calls.Add(1)
		if accepted.Load() {
			return http.StatusOK, nil
		}
		return http.StatusBadRequest, nil
	}, dir)
	id := newSettlementID()
	body := []byte(`{"settlementId":"` + id + `","costNanoUsd":"42"}`)
	<-o.deliver(id, body)
	if calls.Load() != 1 || o.pendingCount() != 0 || o.deadLetterCount() != 1 {
		t.Fatalf("a rejected settlement must be parked, not retried: calls=%d pending=%d parked=%d", calls.Load(), o.pendingCount(), o.deadLetterCount())
	}
	if names := spooledSettlements(t, dir); len(names) != 0 {
		t.Fatalf("a parked settlement must leave the retry spool: %v", names)
	}
	parked, err := os.ReadFile(filepath.Join(dir, settlementDeadLetterDir, id+".json"))
	if err != nil || !bytes.Equal(parked, body) {
		t.Fatalf("parked body differs from the original: %v %s", err, parked)
	}

	// After the cause is fixed, a replay delivers the identical body and empties the dead letters.
	accepted.Store(true)
	if n, err := o.replayDeadLetters(); err != nil || n != 1 {
		t.Fatalf("replay = %d, %v", n, err)
	}
	waitFor(t, "replayed delivery", func() bool { return o.delivered.Load() == 1 })
	waitFor(t, "spool emptied", func() bool { return o.deadLetterCount() == 0 && len(spooledSettlements(t, dir)) == 0 })
}

func TestSettlementOutboxParksAgedOutSettlements(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return 0, errors.New("down") }, dir)
	o.maxAge = 60 * time.Millisecond
	id := newSettlementID()
	<-o.deliver(id, []byte(`{"settlementId":"`+id+`"}`))
	waitFor(t, "age-out", func() bool { return o.pendingCount() == 0 })
	if o.deadLetterCount() != 1 || o.deadLettered.Load() != 1 {
		t.Fatalf("an aged-out settlement must be parked, parked=%d", o.deadLetterCount())
	}

	// A spooled settlement found at start that is already too old is parked, not re-queued.
	stale := newSettlementID()
	path := filepath.Join(dir, stale+".json")
	if err := os.WriteFile(path, []byte(`{"settlementId":"`+stale+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if n := o.loadSpool(); n != 0 {
		t.Fatalf("a stale spooled settlement must not be re-queued, loaded %d", n)
	}
	if o.deadLetterCount() != 2 || len(spooledSettlements(t, dir)) != 0 {
		t.Fatalf("expected both settlements parked, parked=%d spooled=%v", o.deadLetterCount(), spooledSettlements(t, dir))
	}
}

func TestSettlementOutboxReplayNeedsASpool(t *testing.T) {
	t.Parallel()
	o := fastOutbox(func(context.Context, []byte) (int, error) { return http.StatusBadRequest, nil }, "")
	<-o.deliver(newSettlementID(), []byte(`{}`))
	if o.dropped.Load() != 1 || o.deadLetterCount() != 0 {
		t.Fatalf("without a spool a rejected settlement cannot be parked: dropped=%d", o.dropped.Load())
	}
	if _, err := o.replayDeadLetters(); !errors.Is(err, errSettlementSpoolOff) {
		t.Fatalf("expected errSettlementSpoolOff, got %v", err)
	}
}

func TestSettlementStatusCodeStaysInTheHTTPRange(t *testing.T) {
	t.Parallel()
	for in, want := range map[int]int{0: 502, 99: 502, 100: 100, 200: 200, 429: 429, 599: 599, 600: 502, 999: 502} {
		if got := settlementStatusCode(in); got != want {
			t.Fatalf("settlementStatusCode(%d) = %d, want %d", in, got, want)
		}
	}
}

// The service tier is billed on and recorded with the settlement; a caller-chosen string (which the
// BFF used to reject, dropping the whole settlement) must not survive parsing on any protocol.
func TestIngressServiceTierIsNormalizedOnEveryProtocol(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("x", 64)
	cases := map[string]string{
		"/v1/chat/completions": `{"model":"m","messages":[{"role":"user","content":"hi"}],"service_tier":%q}`,
		"/v1/responses":        `{"model":"m","input":"hi","service_tier":%q}`,
		"/v1/messages":         `{"model":"m","max_tokens":16,"messages":[{"role":"user","content":"hi"}],"service_tier":%q}`,
	}
	for path, tmpl := range cases {
		for tier, want := range map[string]string{long: "", "Priority ": "priority", "flex": "flex", "standard_only": "standard_only"} {
			turn, err := ParseIngressRequest(path, "", []byte(fmt.Sprintf(tmpl, tier)))
			if err != nil {
				t.Fatalf("%s: %v", path, err)
			}
			if turn.ServiceTier != want {
				t.Fatalf("%s: service_tier %q parsed as %q, want %q", path, tier, turn.ServiceTier, want)
			}
		}
	}
}

func TestSettlementSpoolDirResolution(t *testing.T) {
	t.Setenv(SettlementSpoolDirEnv, "")
	if got := ResolveSettlementSpoolDir("/var/run/slipgate/hotupdate/settlement-spool"); got != "/var/run/slipgate/hotupdate/settlement-spool" {
		t.Fatalf("the spool must be on by default, got %q", got)
	}
	t.Setenv(SettlementSpoolDirEnv, "/data/spool")
	if got := ResolveSettlementSpoolDir("/fallback"); got != "/data/spool" {
		t.Fatalf("the environment overrides the default, got %q", got)
	}
	t.Setenv(SettlementSpoolDirEnv, "off")
	coord := NewCoordinator(CoordinatorOptions{SettlementSpoolDir: ResolveSettlementSpoolDir("/fallback"), VaultSecret: "v"})
	if coord.settlements.spoolDir != "" {
		t.Fatalf(`"off" must disable the spool, got %q`, coord.settlements.spoolDir)
	}
}

// fakeCore answers eval with a direct_api dispatch and settle reports with settleAck.
func fakeCore(t *testing.T, settleAck string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var hold atomic.Uint64
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
				var payload []byte
				typ := dpbridge.FrameSyncAck
				switch req.Type {
				case dpbridge.FrameReqHeaders:
					typ = dpbridge.FrameDispatchDirective
					payload, _ = json.Marshal(coreDispatchDirective{
						Action:        "dispatch",
						Status:        200,
						HoldID:        hold.Add(1),
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
				case dpbridge.FrameSettleReport:
					typ = dpbridge.FrameSettleAck
					payload = []byte(settleAck)
				default:
					payload = []byte(`{"ok":true}`)
				}
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: req.StreamID, Type: typ, Flags: dpbridge.FlagEndStream, Payload: payload})
			}(conn)
		}
	}()
	return ln.Addr().String()
}

func TestSettlementUsesServerMintedIDAndFlagsUnsettledTurns(t *testing.T) {
	t.Parallel()
	const token = "outbox-internal-token"
	var (
		mu     sync.Mutex
		posts  []TurnSettlementEvent
		failed atomic.Int32
	)
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/internal/dataplane/settlement" || r.Header.Get("X-Slipgate-Internal-Token") != token {
			http.NotFound(w, r)
			return
		}
		var ev TurnSettlementEvent
		_ = json.NewDecoder(r.Body).Decode(&ev)
		mu.Lock()
		posts = append(posts, ev)
		mu.Unlock()
		// The BFF is briefly unavailable (deploy, failover): the first two deliveries fail.
		if failed.Add(1) <= 2 {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()

	// The core lost the hold (restarted mid-turn): ok:false with a zero cost.
	coreAddr := fakeCore(t, `{"ok":false,"settledCostNanoUsd":"0","balanceAfterNanoUsd":"0","ordinaryUpstream400Exempted":false}`)
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: coreAddr, BFFOrigin: bff.URL, InternalToken: token, VaultSecret: "outbox-vault"})
	coord.settlements.baseBackoff = 10 * time.Millisecond
	coord.settlements.maxBackoff = 20 * time.Millisecond
	enc, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		Accounts: []SyncAccountInput{{ID: "acc_mock", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "direct_api", CredentialsEncHex: enc, MaxConcurrency: 4, Status: "active"}},
		APIKeys:  testSnapshotKeys,
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()

	for range 2 {
		req, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("x-api-key", "sk-sg-test")
		req.Header.Set("X-Request-Id", "abcd") // a client reusing its request id
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("turn: %v", err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Request-Id") != "abcd" {
			t.Fatalf("unexpected turn response %d (request id %q)", resp.StatusCode, resp.Header.Get("X-Request-Id"))
		}
	}

	waitFor(t, "both settlements delivered", func() bool { return coord.settlements.delivered.Load() == 2 })
	mu.Lock()
	defer mu.Unlock()
	ids := make(map[string]int)
	for _, ev := range posts {
		if ev.RequestID != "abcd" {
			t.Fatalf("request id must stay the caller's for correlation, got %q", ev.RequestID)
		}
		if !isSettlementID(ev.SettlementID) {
			t.Fatalf("settlement id %q is not server-minted", ev.SettlementID)
		}
		if ev.CoreSettled || ev.CostNanoUSD != "0" || ev.InputTokens == 0 {
			t.Fatalf("an unsettled turn must say so and keep its tokens: %+v", ev)
		}
		ids[ev.SettlementID]++
	}
	if len(ids) != 2 {
		t.Fatalf("two turns with the same X-Request-Id need two settlement ids, got %v", ids)
	}
	if len(posts) != 4 {
		t.Fatalf("expected 2 failed + 2 accepted deliveries, got %d", len(posts))
	}
}

func TestSettlementReportsCoreSettledWhenTheCoreAcks(t *testing.T) {
	t.Parallel()
	const token = "outbox-internal-token-2"
	got := make(chan TurnSettlementEvent, 1)
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ev TurnSettlementEvent
		_ = json.NewDecoder(r.Body).Decode(&ev)
		got <- ev
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()
	coreAddr := fakeCore(t, `{"ok":true,"settledCostNanoUsd":"210000","balanceAfterNanoUsd":"1","ordinaryUpstream400Exempted":false}`)
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: coreAddr, BFFOrigin: bff.URL, InternalToken: token, VaultSecret: "outbox-vault"})
	enc, _ := coord.Vault().EncryptHex("mock://ok")
	_, _ = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		Accounts: []SyncAccountInput{{ID: "acc_mock", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "direct_api", CredentialsEncHex: enc, MaxConcurrency: 4, Status: "active"}},
		APIKeys:  testSnapshotKeys,
	})
	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()
	req, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("x-api-key", "sk-sg-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("turn: %v", err)
	}
	_ = resp.Body.Close()
	select {
	case ev := <-got:
		if !ev.CoreSettled || ev.CostNanoUSD != "210000" || !isSettlementID(ev.SettlementID) {
			t.Fatalf("unexpected settlement %+v", ev)
		}
		if !strings.HasPrefix(ev.RequestID, "req_") {
			t.Fatalf("expected an edge-generated request id, got %q", ev.RequestID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("settlement not posted")
	}
}

func TestSyncSnapshotForwardsPriceRulesToCore(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	payloads := make(chan []byte, 1)
	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		req, _ := dpbridge.ReadFrame(conn)
		payloads <- req.Payload
		_ = dpbridge.WriteFrame(conn, dpbridge.Frame{StreamID: req.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
	}()
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: ln.Addr().String(), VaultSecret: "v"})
	rule := SyncPriceRuleInput{Pattern: "o3*", InputNanoPerMTok: "10000000000", OutputNanoPerMTok: "40000000000", CacheReadNanoPerMTok: "1000000000", CacheWriteNanoPerMTok: "12500000000"}
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{PriceRules: []SyncPriceRuleInput{rule}}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	var core struct {
		PriceRules []SyncPriceRuleInput `json:"priceRules"`
	}
	if err := json.Unmarshal(<-payloads, &core); err != nil {
		t.Fatalf("core payload: %v", err)
	}
	if len(core.PriceRules) != 1 || core.PriceRules[0] != rule {
		t.Fatalf("price rules not forwarded: %+v", core.PriceRules)
	}
}
