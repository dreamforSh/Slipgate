// Package lifecycle holds the edge's graceful-restart building blocks: a drain gate that lets
// in-flight requests finish while turning new ones away, and listening-socket handoff across a
// re-exec so clients queue in the kernel backlog instead of seeing "connection refused".
package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DrainSnapshot reports the drain gate state for status endpoints.
type DrainSnapshot struct {
	Draining  bool
	Inflight  int
	StartedAt time.Time
	Deadline  time.Time
}

// Drainer counts in-flight requests on the public listener. Once BeginDrain is called, new
// requests (except the exempt ones) get 503 + Retry-After so the in-flight set can only shrink.
type Drainer struct {
	mu         sync.Mutex
	inflight   int
	draining   bool
	startedAt  time.Time
	deadline   time.Time
	exempt     func(*http.Request) bool
	retryAfter int
}

// NewDrainer builds a drain gate. exempt (optional) lists requests still served while draining,
// e.g. liveness probes or the admin status poll that shows restart progress.
func NewDrainer(exempt func(*http.Request) bool) *Drainer {
	return &Drainer{exempt: exempt, retryAfter: 5}
}

// Middleware wraps the public handler with in-flight tracking and the drain gate.
func (d *Drainer) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upgraded connections (VM terminal WebSockets) hold no billing state and would pin the
		// drain to its full timeout; they are cut when the process stops.
		if isUpgrade(r) {
			d.mu.Lock()
			draining := d.draining
			d.mu.Unlock()
			if draining {
				d.reject(w)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		d.mu.Lock()
		if d.draining {
			if d.exempt == nil || !d.exempt(r) {
				d.mu.Unlock()
				d.reject(w)
				return
			}
			// Exempt requests (probes, the restart status poll) are short and served on purpose
			// while draining; counting them would show the poll itself as work the drain waits for.
			d.mu.Unlock()
			next.ServeHTTP(w, r)
			return
		}
		d.inflight++
		d.mu.Unlock()
		defer func() {
			d.mu.Lock()
			d.inflight--
			d.mu.Unlock()
		}()
		next.ServeHTTP(w, r)
	})
}

func (d *Drainer) reject(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Retry-After", strconv.Itoa(d.retryAfter))
	h.Set("Connection", "close")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	// Readable by both Anthropic-style (type/error.type) and OpenAI-style (error.message) clients,
	// which treat 503 as retryable.
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "overloaded_error",
			"code":    "service_restarting",
			"message": "Slipgate is restarting; retry shortly",
		},
	})
}

// BeginDrain switches the gate to draining. timeout only feeds the reported deadline.
func (d *Drainer) BeginDrain(timeout time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.draining {
		return
	}
	d.draining = true
	d.startedAt = time.Now()
	if timeout > 0 {
		d.deadline = d.startedAt.Add(timeout)
	}
}

// Draining reports whether new requests are being turned away.
func (d *Drainer) Draining() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.draining
}

// Inflight returns the number of tracked requests still running.
func (d *Drainer) Inflight() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.inflight
}

// Snapshot returns the gate state.
func (d *Drainer) Snapshot() DrainSnapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	return DrainSnapshot{Draining: d.draining, Inflight: d.inflight, StartedAt: d.startedAt, Deadline: d.deadline}
}

// Wait blocks until no tracked request is in flight or ctx ends, calling progress (if set) with
// the in-flight count whenever it changes. It returns the count still running.
func (d *Drainer) Wait(ctx context.Context, progress func(inflight int)) int {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	last := -1
	for {
		n := d.Inflight()
		if n != last && progress != nil {
			progress(n)
		}
		last = n
		if n == 0 {
			return 0
		}
		select {
		case <-ctx.Done():
			return d.Inflight()
		case <-ticker.C:
		}
	}
}

func isUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" && strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}
