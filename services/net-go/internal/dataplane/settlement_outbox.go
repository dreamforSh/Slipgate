package dataplane

import (
	"container/heap"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Settlement delivery to slipgate-bff is at-least-once: Postgres (behind the BFF) is the only
// durable ledger, and slipgate-core's local wallet is overwritten by the BFF balance on every
// snapshot pull, so a settlement the BFF never commits is a turn nobody pays for. Every event
// carries a settlement id minted here (never the caller's X-Request-Id); the BFF dedupes on it, so
// redelivering after a timeout whose request did land is harmless.
//
// With a spool directory (the default in cmd/slipgate) each event is written to disk before its
// first POST and removed once the BFF accepts it, so a crash, restart or redeploy at any point
// redelivers it on the next start. When the in-memory retry queue is full, events stay on disk only
// and are reloaded as the queue drains, so a long BFF outage spills to disk instead of dropping.

const (
	defaultOutboxMaxPending = 100_000
	// defaultOutboxMaxSpilled bounds the events kept on disk only (beyond the memory queue). At
	// 300 turns/s that is close to an hour of BFF outage on top of the memory queue.
	defaultOutboxMaxSpilled   = 1_000_000
	defaultOutboxMaxAge       = 24 * time.Hour
	defaultOutboxBaseBackoff  = 500 * time.Millisecond
	defaultOutboxMaxBackoff   = 30 * time.Second
	defaultOutboxAttemptWait  = 5 * time.Second
	defaultOutboxDrainWorkers = 8
	// outboxPauseAfterFailures consecutive event failures in one pass read as a systemic BFF fault.
	outboxPauseAfterFailures = 5
	outboxLogEvery           = 10 * time.Second

	// SettlementSpoolDirEnv names a directory where undelivered settlements are kept across
	// slipgate-net restarts (one small JSON file each, removed once the BFF accepts it).
	// "off" disables the spool (in-memory retry queue only).
	SettlementSpoolDirEnv = "SLIPGATE_SETTLEMENT_SPOOL_DIR"

	// settlementDeadLetterDir (inside the spool) keeps settlements that left the retry queue
	// undelivered. refill never reads subdirectories, so they wait there until replayed.
	settlementDeadLetterDir = "dead-letter"
)

var errSettlementSpoolOff = errors.New("the settlement spool is off (" + SettlementSpoolDirEnv + ")")

// ResolveSettlementSpoolDir returns SLIPGATE_SETTLEMENT_SPOOL_DIR when it is set (including "off"),
// else fallback. cmd/slipgate passes a directory on its persistent volume as the fallback, so
// settlement durability is on unless an operator turns it off.
func ResolveSettlementSpoolDir(fallback string) string {
	if v := strings.TrimSpace(os.Getenv(SettlementSpoolDirEnv)); v != "" {
		return v
	}
	return strings.TrimSpace(fallback)
}

// normalizeSpoolDir maps the "off" spellings to "" (no spool).
func normalizeSpoolDir(dir string) string {
	dir = strings.TrimSpace(dir)
	switch strings.ToLower(dir) {
	case "off", "none", "disabled", "false":
		return ""
	}
	return dir
}

// newSettlementID mints a server-unique settlement id: 48 bits of Unix milliseconds followed by 80
// random bits (like UUIDv7). Time-ordered ids keep the BFF's core.settlement_ids primary key growing
// at its right edge (inserts hit cached pages, the prune removes whole pages on the left) instead of
// landing on random pages of an index far larger than memory.
func newSettlementID() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (8 * (5 - i)))
	}
	if _, err := crand.Read(b[6:]); err != nil {
		// crypto/rand does not fail on supported platforms; never fall back to a guessable id.
		panic(fmt.Sprintf("dataplane: crypto/rand failed: %v", err))
	}
	return "stl_" + hex.EncodeToString(b[:])
}

// isSettlementID reports whether id is one this package minted (safe as a spool file name).
func isSettlementID(id string) bool {
	if len(id) != 36 || !strings.HasPrefix(id, "stl_") {
		return false
	}
	_, err := hex.DecodeString(id[4:])
	return err == nil
}

// settlementPermanentStatus reports BFF answers a retry cannot fix (the event itself is invalid).
// Everything else (transport errors, 5xx, 408/429, and 403/404 during a BFF restart or token
// rotation) is retried until the event ages out.
func settlementPermanentStatus(status int) bool {
	return status == http.StatusBadRequest || status == http.StatusRequestEntityTooLarge || status == http.StatusUnprocessableEntity
}

type outboxItem struct {
	id       string
	body     []byte
	firstAt  time.Time
	nextAt   time.Time
	attempts int
	onDisk   bool
	index    int // position in outboxQueue; -1 while out of it (being attempted)
}

// outboxQueue is a min-heap on nextAt, so the worker only ever looks at the head: an idle or
// paused queue costs nothing however long it is.
type outboxQueue []*outboxItem

func (q outboxQueue) Len() int           { return len(q) }
func (q outboxQueue) Less(i, j int) bool { return q[i].nextAt.Before(q[j].nextAt) }
func (q outboxQueue) Swap(i, j int) {
	q[i], q[j] = q[j], q[i]
	q[i].index = i
	q[j].index = j
}
func (q *outboxQueue) Push(x any) {
	it := x.(*outboxItem)
	it.index = len(*q)
	*q = append(*q, it)
}
func (q *outboxQueue) Pop() any {
	old := *q
	n := len(old)
	it := old[n-1]
	old[n-1] = nil
	it.index = -1
	*q = old[:n-1]
	return it
}

// settlementOutbox makes the first delivery attempt right away and keeps failed events in a
// bounded retry queue (spooled to disk when a spool directory is set) with exponential backoff.
type settlementOutbox struct {
	post         func(ctx context.Context, body []byte) (int, error)
	logger       *log.Logger
	spoolDir     string
	maxPending   int
	maxSpilled   int
	maxAge       time.Duration
	baseBackoff  time.Duration
	maxBackoff   time.Duration
	attemptWait  time.Duration
	drainWorkers int

	mu sync.Mutex
	// pending holds every event in the retry queue: waiting in queue or being retried by a pass.
	pending map[string]*outboxItem
	queue   outboxQueue
	// inflight holds events whose first attempt is still running (already on disk, if spooling).
	inflight map[string]struct{}
	// spilled counts events kept on disk only because the memory queue was full.
	spilled    int
	running    bool
	pauseUntil time.Time
	// sleepUntil is when the idle worker wakes on its own (zero while it works a pass).
	sleepUntil time.Time
	wake       chan struct{}

	delivered    atomic.Uint64
	dropped      atomic.Uint64
	deadLettered atomic.Uint64 // dropped events parked in the dead-letter directory
	wakeups      atomic.Uint64 // worker loop iterations (tests, diagnostics)
	logAt        sync.Map      // log key -> time.Time of its last line (rate limiting)
}

func newSettlementOutbox(post func(ctx context.Context, body []byte) (int, error), logger *log.Logger, spoolDir string) *settlementOutbox {
	if logger == nil {
		logger = log.New(os.Stderr, "", 0)
	}
	o := &settlementOutbox{
		post:         post,
		logger:       logger,
		spoolDir:     normalizeSpoolDir(spoolDir),
		maxPending:   defaultOutboxMaxPending,
		maxSpilled:   defaultOutboxMaxSpilled,
		maxAge:       defaultOutboxMaxAge,
		baseBackoff:  defaultOutboxBaseBackoff,
		maxBackoff:   defaultOutboxMaxBackoff,
		attemptWait:  defaultOutboxAttemptWait,
		drainWorkers: defaultOutboxDrainWorkers,
		pending:      make(map[string]*outboxItem),
		inflight:     make(map[string]struct{}),
		wake:         make(chan struct{}, 1),
	}
	if o.spoolDir != "" {
		if err := os.MkdirAll(o.spoolDir, 0o700); err != nil {
			o.logger.Printf("[dataplane] warning: settlement spool %s unavailable (%v); retrying on each write", o.spoolDir, err)
		}
	}
	return o
}

// logLimited prints at most one line per key every outboxLogEvery (outages produce one failure
// per turn; the log must not become the bottleneck).
func (o *settlementOutbox) logLimited(key, format string, args ...any) {
	now := time.Now()
	if last, ok := o.logAt.Load(key); ok && now.Sub(last.(time.Time)) < outboxLogEvery {
		return
	}
	o.logAt.Store(key, now)
	o.logger.Printf(format, args...)
}

// deliver spools the event, makes the first attempt in the background and returns a channel closed
// once that attempt has finished (whatever its outcome); failures continue in the retry queue.
func (o *settlementOutbox) deliver(id string, body []byte) <-chan struct{} {
	done := make(chan struct{})
	o.mu.Lock()
	o.inflight[id] = struct{}{}
	o.mu.Unlock()
	go func() {
		defer close(done)
		now := time.Now()
		item := &outboxItem{id: id, body: body, firstAt: now, nextAt: now, index: -1}
		// On disk before the first POST: a crash or restart while it is in flight redelivers it.
		item.onDisk = o.writeSpool(item)
		ok, permanent, _, reason := o.attemptDetailed(item)
		switch {
		case ok:
			o.delivered.Add(1)
			o.finishFirstAttempt(item)
		case permanent:
			o.deadLetter(item, "rejected by BFF ("+reason+")")
			o.finishFirstAttempt(item)
		default:
			o.logLimited("queued", "[dataplane] warning: settlement %s delivery failed (%s); queued for retry", id, reason)
			item.attempts = 1
			item.nextAt = time.Now().Add(o.backoff(1))
			o.enqueue(item)
		}
	}()
	return done
}

// finishFirstAttempt forgets a settlement whose first attempt settled it (the spool file goes
// first, so a concurrent refill never reloads a delivered event).
func (o *settlementOutbox) finishFirstAttempt(item *outboxItem) {
	if item.onDisk {
		o.deleteSpool(item.id)
	}
	o.mu.Lock()
	delete(o.inflight, item.id)
	o.mu.Unlock()
}

// attemptDetailed posts once. ok = accepted; permanent = rejected for good; unavailable = the BFF
// could not be reached or said it is unavailable (as opposed to failing this one event).
func (o *settlementOutbox) attemptDetailed(item *outboxItem) (ok, permanent, unavailable bool, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), o.attemptWait)
	defer cancel()
	status, err := o.post(ctx, item.body)
	if err != nil {
		return false, false, true, err.Error()
	}
	if status >= 200 && status < 300 {
		return true, false, false, ""
	}
	switch status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		unavailable = true
	}
	return false, settlementPermanentStatus(status), unavailable, fmt.Sprintf("status %d", status)
}

func (o *settlementOutbox) backoff(attempts int) time.Duration {
	d := o.baseBackoff
	for i := 1; i < attempts && d < o.maxBackoff; i++ {
		d *= 2
	}
	d = min(d, o.maxBackoff)
	// ±20% jitter so many edges do not retry in lockstep after a BFF restart.
	jitter := time.Duration(float64(d) * (mrand.Float64()*0.4 - 0.2))
	return max(time.Millisecond, d+jitter)
}

// startLocked marks the worker running; true when the caller must start it. o.mu must be held.
func (o *settlementOutbox) startLocked() bool {
	if o.running {
		return false
	}
	o.running = true
	return true
}

func (o *settlementOutbox) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// enqueue adds a settlement whose first attempt failed to the retry queue. When the memory queue is
// full, an event that is on disk stays there only and is reloaded once the queue has room.
func (o *settlementOutbox) enqueue(item *outboxItem) {
	if !item.onDisk {
		// The pre-POST write failed (full disk?) or there is no spool: one more try costs little.
		item.onDisk = o.writeSpool(item)
	}
	o.mu.Lock()
	delete(o.inflight, item.id)
	if _, exists := o.pending[item.id]; exists {
		o.mu.Unlock()
		return
	}
	if len(o.pending) >= o.maxPending {
		if item.onDisk && o.spilled < o.maxSpilled {
			o.spilled++
			spilled := o.spilled
			start := o.startLocked()
			o.mu.Unlock()
			o.logLimited("spill", "[dataplane] warning: settlement retry queue full (%d in memory); %d settlement(s) wait on disk only", o.maxPending, spilled)
			if start {
				go o.run()
			}
			return
		}
		o.mu.Unlock()
		o.dropped.Add(1)
		if item.onDisk {
			o.deleteSpool(item.id)
		}
		o.logLimited("full", "[dataplane] error: settlement retry queue full (%d in memory, %d on disk); settlement %s dropped", o.maxPending, o.maxSpilled, item.id)
		return
	}
	o.pending[item.id] = item
	heap.Push(&o.queue, item)
	start := o.startLocked()
	// Wake an idle worker only when this item is due before it would wake anyway; never while the
	// queue is paused for a down BFF (the pause ends on its own).
	wake := !start && !o.sleepUntil.IsZero() && item.nextAt.Before(o.sleepUntil) && !o.pauseUntil.After(time.Now())
	o.mu.Unlock()
	if start {
		go o.run()
	} else if wake {
		o.signal()
	}
}

// run retries due items until nothing is left in memory or on disk, then exits (no idle goroutine).
func (o *settlementOutbox) run() {
	for {
		o.wakeups.Add(1)
		o.refillIfRoom()
		o.mu.Lock()
		if len(o.pending) == 0 && o.spilled == 0 {
			o.running = false
			o.sleepUntil = time.Time{}
			o.mu.Unlock()
			return
		}
		now := time.Now()
		var wait time.Duration
		switch {
		case o.pauseUntil.After(now):
			wait = o.pauseUntil.Sub(now)
		case o.queue.Len() == 0:
			// Only on-disk events remain and none could be loaded yet.
			wait = time.Second
		case o.queue[0].nextAt.After(now):
			wait = o.queue[0].nextAt.Sub(now)
		}
		if wait > 0 {
			o.sleepUntil = now.Add(wait)
			o.mu.Unlock()
			o.sleep(wait)
			continue
		}
		o.sleepUntil = time.Time{}
		var due []*outboxItem
		for o.queue.Len() > 0 && !o.queue[0].nextAt.After(now) {
			due = append(due, heap.Pop(&o.queue).(*outboxItem))
		}
		o.mu.Unlock()
		o.drain(due)
	}
}

// drain works one pass of due items: fewest attempts first, then oldest, so an event that keeps
// failing on its own sinks behind fresh ones. Attempts go one at a time until one succeeds (the BFF
// is evidently up), then drainWorkers at a time. A down BFF, or outboxPauseAfterFailures failures in
// a row, pauses the whole queue until the backoff passes, so a backlog is not hammered at it.
func (o *settlementOutbox) drain(due []*outboxItem) {
	sort.Slice(due, func(i, j int) bool {
		if due[i].attempts != due[j].attempts {
			return due[i].attempts < due[j].attempts
		}
		return due[i].firstAt.Before(due[j].firstAt)
	})
	var (
		wg          sync.WaitGroup
		sem         = make(chan struct{}, max(1, o.drainWorkers))
		consecutive atomic.Int32
		healthy     atomic.Bool
		stop        atomic.Bool
	)
	process := func(it *outboxItem) {
		ok, permanent, unavailable, reason := o.attemptDetailed(it)
		switch {
		case ok:
			healthy.Store(true)
			consecutive.Store(0)
			o.delivered.Add(1)
			o.remove(it)
		case permanent:
			o.deadLetter(it, "rejected by BFF ("+reason+")")
			o.remove(it)
		default:
			n := consecutive.Add(1)
			o.mu.Lock()
			it.attempts++
			it.nextAt = time.Now().Add(o.backoff(it.attempts))
			if unavailable || n >= outboxPauseAfterFailures {
				if it.nextAt.After(o.pauseUntil) {
					o.pauseUntil = it.nextAt
				}
				stop.Store(true)
			}
			heap.Push(&o.queue, it)
			o.mu.Unlock()
		}
	}
	var requeue []*outboxItem
	for _, it := range due {
		if time.Since(it.firstAt) > o.maxAge {
			o.deadLetter(it, fmt.Sprintf("undeliverable for %s after %d attempts", o.maxAge, it.attempts))
			o.remove(it)
			continue
		}
		if stop.Load() {
			requeue = append(requeue, it)
			continue
		}
		if !healthy.Load() {
			process(it)
			continue
		}
		sem <- struct{}{}
		if stop.Load() {
			<-sem
			requeue = append(requeue, it)
			continue
		}
		wg.Add(1)
		go func(it *outboxItem) {
			defer wg.Done()
			defer func() { <-sem }()
			process(it)
		}(it)
	}
	wg.Wait()
	if len(requeue) > 0 {
		o.mu.Lock()
		for _, it := range requeue {
			heap.Push(&o.queue, it)
		}
		o.mu.Unlock()
	}
}

func (o *settlementOutbox) sleep(d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-o.wake:
	}
}

// remove forgets a settlement that left the retry queue (the spool file goes first).
func (o *settlementOutbox) remove(it *outboxItem) {
	if it.onDisk {
		o.deleteSpool(it.id)
	}
	o.mu.Lock()
	delete(o.pending, it.id)
	o.mu.Unlock()
}

// pendingCount is the in-memory retry queue length (tests, diagnostics).
func (o *settlementOutbox) pendingCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.pending)
}

// undeliveredCount is everything not yet accepted by the BFF: first attempts in flight, the retry
// queue and the events waiting on disk only.
func (o *settlementOutbox) undeliveredCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.inflight) + len(o.pending) + o.spilled
}

// flush runs at shutdown, once the edge has stopped serving turns. It waits for first attempts in
// flight, then gives queued settlements one immediate pass against the (still running) BFF, and
// returns as soon as everything is delivered, the BFF turns out to be down, or ctx ends. Whatever is
// left is already in the spool for the next start. Returns how many settlements are undelivered.
func (o *settlementOutbox) flush(ctx context.Context) int {
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	nudged := false
	for {
		o.mu.Lock()
		inflight := len(o.inflight)
		left := inflight + len(o.pending) + o.spilled
		now := time.Now()
		if left == 0 {
			o.mu.Unlock()
			return 0
		}
		if nudged && inflight == 0 && o.pauseUntil.After(now) {
			// The pass found the BFF down: waiting out the backoff would only delay the exit.
			o.mu.Unlock()
			return left
		}
		if !nudged && inflight == 0 {
			nudged = true
			o.pauseUntil = time.Time{}
			for _, it := range o.queue {
				it.nextAt = now
			}
			heap.Init(&o.queue)
			start := o.startLocked()
			o.mu.Unlock()
			if start {
				go o.run()
			} else {
				o.signal()
			}
		} else {
			o.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return o.undeliveredCount()
		case <-tick.C:
		}
	}
}

func (o *settlementOutbox) spoolPath(id string) string {
	return filepath.Join(o.spoolDir, id+".json")
}

// writeSpool persists one event; false when there is no spool or the write failed. The file is
// written in place (no rename): it is written before the first POST, so a crash that leaves it
// half-written also means that POST never happened, and loading skips files that are not JSON.
func (o *settlementOutbox) writeSpool(it *outboxItem) bool {
	if o.spoolDir == "" || !isSettlementID(it.id) {
		return false
	}
	err := writeFileSynced(o.spoolPath(it.id), it.body)
	if errors.Is(err, os.ErrNotExist) {
		if mkErr := os.MkdirAll(o.spoolDir, 0o700); mkErr == nil {
			err = writeFileSynced(o.spoolPath(it.id), it.body)
		}
	}
	if err != nil {
		o.logLimited("spool-write", "[dataplane] warning: settlement %s not spooled (kept in memory only): %v", it.id, err)
		return false
	}
	return true
}

// writeFileSynced is os.WriteFile (mode 0600) plus fsync, so a spooled settlement survives a power
// cut and not only a process crash. Spool writes run on the delivery goroutine, not the turn.
func writeFileSynced(name string, data []byte) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (o *settlementOutbox) deleteSpool(id string) {
	if o.spoolDir == "" || !isSettlementID(id) {
		return
	}
	if err := os.Remove(o.spoolPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		o.logLimited("spool-remove", "[dataplane] warning: spooled settlement %s not removed: %v", id, err)
	}
}

// loadSpool re-queues settlements a previous process did not get accepted (including ones whose
// first attempt was still in flight when it stopped). Returns how many were loaded into memory;
// any beyond the memory queue stay on disk and are loaded as it drains.
func (o *settlementOutbox) loadSpool() int {
	if o.spoolDir == "" {
		return 0
	}
	o.mu.Lock()
	o.spilled = max(o.spilled, 1) // unknown until the directory is read
	o.mu.Unlock()
	loaded := o.refill()
	o.mu.Lock()
	start := (len(o.pending) > 0 || o.spilled > 0) && o.startLocked()
	o.mu.Unlock()
	if start {
		go o.run()
	}
	if loaded > 0 {
		o.logger.Printf("[dataplane] re-queued %d spooled settlement(s) for delivery", loaded)
	}
	return loaded
}

// refillIfRoom reloads on-disk-only settlements once the memory queue has drained enough.
func (o *settlementOutbox) refillIfRoom() {
	o.mu.Lock()
	need := o.spilled > 0 && (len(o.pending) == 0 || o.maxPending-len(o.pending) >= max(1, o.maxPending/2))
	o.mu.Unlock()
	if need {
		o.refill()
	}
}

// refill loads spooled settlements that are neither queued nor in flight, up to the memory bound.
func (o *settlementOutbox) refill() int {
	f, err := os.Open(o.spoolDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			o.logLimited("spool-read", "[dataplane] warning: settlement spool unreadable: %v", err)
		}
		o.mu.Lock()
		o.spilled = 0
		o.mu.Unlock()
		return 0
	}
	defer f.Close()
	loaded := 0
	now := time.Now()
	for {
		entries, readErr := f.ReadDir(256)
		for _, e := range entries {
			id, isJSON := strings.CutSuffix(e.Name(), ".json")
			if e.IsDir() || !isJSON || !isSettlementID(id) {
				continue
			}
			o.mu.Lock()
			_, queued := o.pending[id]
			_, inflight := o.inflight[id]
			full := len(o.pending) >= o.maxPending
			o.mu.Unlock()
			if full {
				// More is left on disk than fits: keep counting it as spilled.
				o.mu.Lock()
				o.spilled = max(o.spilled, 1)
				o.mu.Unlock()
				return loaded
			}
			if queued || inflight {
				continue
			}
			item := o.readSpoolItem(e, id, now)
			if item == nil {
				continue
			}
			o.mu.Lock()
			if _, exists := o.pending[id]; !exists {
				o.pending[id] = item
				heap.Push(&o.queue, item)
				if o.spilled > 1 {
					o.spilled--
				}
				loaded++
			}
			o.mu.Unlock()
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				o.logLimited("spool-read", "[dataplane] warning: settlement spool unreadable: %v", readErr)
			}
			// The whole directory was read: whatever is on disk is now queued or in flight.
			o.mu.Lock()
			o.spilled = 0
			o.mu.Unlock()
			return loaded
		}
	}
}

// readSpoolItem reads one spooled event, dropping (and deleting) aged-out or unreadable ones.
func (o *settlementOutbox) readSpoolItem(e os.DirEntry, id string, now time.Time) *outboxItem {
	info, statErr := e.Info()
	if statErr != nil {
		return nil // removed meanwhile (delivered by another path)
	}
	firstAt := info.ModTime()
	body, readErr := os.ReadFile(filepath.Join(o.spoolDir, e.Name()))
	if readErr != nil {
		return nil
	}
	if !json.Valid(body) {
		// Only a crash during the pre-POST write leaves this, and then that POST never happened.
		o.dropped.Add(1)
		o.logger.Printf("[dataplane] error: spooled settlement %s is not valid JSON (interrupted write); dropped", id)
		o.deleteSpool(id)
		return nil
	}
	item := &outboxItem{id: id, body: body, firstAt: firstAt, nextAt: now, onDisk: true, index: -1}
	if now.Sub(firstAt) > o.maxAge {
		o.deadLetter(item, fmt.Sprintf("spooled for longer than %s", o.maxAge))
		o.deleteSpool(id)
		return nil
	}
	return item
}

func (o *settlementOutbox) deadLetterDir() string {
	return filepath.Join(o.spoolDir, settlementDeadLetterDir)
}

// deadLetter records a settlement that leaves the retry queue undelivered. It is still a turn
// somebody owes, so with a spool it is parked for replayDeadLetters instead of being deleted. The
// caller removes the spool file afterwards, so a crash in between redelivers rather than loses it.
func (o *settlementOutbox) deadLetter(it *outboxItem, reason string) {
	o.dropped.Add(1)
	if o.spoolDir == "" || !isSettlementID(it.id) {
		o.logLimited("dead-letter", "[dataplane] error: settlement %s %s; lost: %v", it.id, reason, errSettlementSpoolOff)
		return
	}
	dir := o.deadLetterDir()
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = writeFileSynced(filepath.Join(dir, it.id+".json"), it.body)
	}
	if err != nil {
		o.logger.Printf("[dataplane] error: settlement %s %s; dead-letter write failed, lost: %v", it.id, reason, err)
		return
	}
	n := o.deadLettered.Add(1)
	o.logLimited("dead-letter", "[dataplane] error: settlement %s %s; parked in %s for replay (%d parked since start)", it.id, reason, dir, n)
}

// deadLetterCount is the number of settlements waiting in the dead-letter directory.
func (o *settlementOutbox) deadLetterCount() int {
	if o.spoolDir == "" {
		return 0
	}
	entries, err := os.ReadDir(o.deadLetterDir())
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if id, isJSON := strings.CutSuffix(e.Name(), ".json"); isJSON && !e.IsDir() && isSettlementID(id) {
			n++
		}
	}
	return n
}

// replayDeadLetters moves parked settlements back into the spool and queues them for delivery.
// Their age restarts at the replay, so maxAge does not park them again straight away; the BFF still
// dedupes on the settlement id, so replaying an event it did accept charges nothing twice.
func (o *settlementOutbox) replayDeadLetters() (int, error) {
	if o.spoolDir == "" {
		return 0, errSettlementSpoolOff
	}
	dir := o.deadLetterDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	now := time.Now()
	moved := 0
	for _, e := range entries {
		id, isJSON := strings.CutSuffix(e.Name(), ".json")
		if e.IsDir() || !isJSON || !isSettlementID(id) {
			continue
		}
		dst := o.spoolPath(id)
		if err := os.Rename(filepath.Join(dir, e.Name()), dst); err != nil {
			o.logLimited("dead-letter-replay", "[dataplane] warning: dead-lettered settlement %s not replayed: %v", id, err)
			continue
		}
		if err := os.Chtimes(dst, now, now); err != nil {
			o.logLimited("dead-letter-replay", "[dataplane] warning: replayed settlement %s keeps its old age: %v", id, err)
		}
		moved++
	}
	if moved > 0 {
		o.loadSpool()
	}
	return moved, nil
}
