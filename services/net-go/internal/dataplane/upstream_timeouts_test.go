package dataplane

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func upstreamTimeoutServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL
}

func sendWithTimeouts(t *testing.T, url string, timeouts UpstreamTimeouts) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return timeouts.do(req, http.DefaultClient.Do)
}

func TestUpstreamHeaderTimeoutFailsASilentUpstream(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	url := upstreamTimeoutServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	start := time.Now()
	_, err := sendWithTimeouts(t, url, UpstreamTimeouts{Header: 80 * time.Millisecond, Idle: time.Minute})
	if !errors.Is(err, errUpstreamHeaderTimeout) {
		t.Fatalf("expected the header timeout, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("the header timeout took %s", elapsed)
	}
}

func TestUpstreamIdleTimeoutCutsAStalledStream(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	url := upstreamTimeoutServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	resp, err := sendWithTimeouts(t, url, UpstreamTimeouts{Header: time.Minute, Idle: 80 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, err = io.ReadAll(resp.Body)
	if !errors.Is(err, errUpstreamIdleTimeout) {
		t.Fatalf("expected the stall to end the stream, got %v", err)
	}
}

func TestUpstreamTimeoutsNeverCapALiveStream(t *testing.T) {
	t.Parallel()
	url := upstreamTimeoutServer(t, func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i < 12; i++ {
			_, _ = io.WriteString(w, "data: chunk\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(25 * time.Millisecond)
		}
	})
	// The stream outlives both deadlines combined but never stalls.
	resp, err := sendWithTimeouts(t, url, UpstreamTimeouts{Header: 120 * time.Millisecond, Idle: 120 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || len(body) != 12*len("data: chunk\n\n") {
		t.Fatalf("a live stream was cut: %d bytes, %v", len(body), err)
	}
}

func TestUpstreamIdleTimeoutIgnoresASlowConsumer(t *testing.T) {
	t.Parallel()
	url := upstreamTimeoutServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "data: two\n\n")
	})
	resp, err := sendWithTimeouts(t, url, UpstreamTimeouts{Idle: 60 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 4)
	if _, err := resp.Body.Read(buf); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // e.g. writing to a slow client
	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatalf("time spent outside Read must not count as a stall: %v", err)
	}
}
