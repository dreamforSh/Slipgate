package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestDrainerLetsInflightFinishAndRejectsNewRequests(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	started := make(chan struct{})
	d := NewDrainer(func(r *http.Request) bool { return r.URL.Path == "/healthz" })
	h := d.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			close(started)
			<-release
		}
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	slow := httptest.NewRecorder()
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(slow, httptest.NewRequest(http.MethodPost, "/slow", nil))
	}()
	<-started
	if got := d.Inflight(); got != 1 {
		t.Fatalf("expected 1 in-flight request, got %d", got)
	}

	d.BeginDrain(time.Second)

	rejected := httptest.NewRecorder()
	h.ServeHTTP(rejected, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
	if rejected.Code != http.StatusServiceUnavailable || rejected.Header().Get("Retry-After") == "" {
		t.Fatalf("expected 503 with Retry-After while draining, got %d %v", rejected.Code, rejected.Header())
	}
	var body struct {
		Error struct {
			Type string `json:"type"`
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rejected.Body.Bytes(), &body); err != nil || body.Error.Code != "service_restarting" {
		t.Fatalf("unexpected drain rejection body %q (err=%v)", rejected.Body.String(), err)
	}

	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("exempt request must still be served while draining, got %d", health.Code)
	}

	// Wait returns the remaining count on timeout, then 0 once the slow request completes.
	shortCtx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	if remaining := d.Wait(shortCtx, nil); remaining != 1 {
		t.Fatalf("expected Wait to time out with 1 request left, got %d", remaining)
	}
	cancel()

	close(release)
	var seen []int
	if remaining := d.Wait(context.Background(), func(n int) { seen = append(seen, n) }); remaining != 0 {
		t.Fatalf("expected drain to complete, %d left", remaining)
	}
	wg.Wait()
	if slow.Code != http.StatusOK {
		t.Fatalf("in-flight request must complete normally, got %d", slow.Code)
	}
	if len(seen) == 0 || seen[len(seen)-1] != 0 {
		t.Fatalf("expected progress callback to end at 0, got %v", seen)
	}
	if snap := d.Snapshot(); !snap.Draining || snap.Deadline.IsZero() {
		t.Fatalf("unexpected snapshot %+v", snap)
	}
}

func TestDrainerDoesNotTrackUpgradedConnections(t *testing.T) {
	t.Parallel()

	d := NewDrainer(nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	h := d.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
	}))
	req := httptest.NewRequest(http.MethodGet, "/internal/net/vms/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	go h.ServeHTTP(httptest.NewRecorder(), req)
	<-entered
	if got := d.Inflight(); got != 0 {
		t.Fatalf("websocket upgrades must not hold the drain, inflight=%d", got)
	}
	close(release)
}
