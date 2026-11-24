package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestCoordinatorReportRequestErrorFlushesBatch(t *testing.T) {
	var (
		mu       sync.Mutex
		gotToken string
		batches  [][]RequestErrorReport
	)
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/internal/dataplane/request-errors" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var payload struct {
			Items []RequestErrorReport `json:"items"`
		}
		_ = json.Unmarshal(raw, &payload)
		mu.Lock()
		gotToken = r.Header.Get("X-Slipgate-Internal-Token")
		batches = append(batches, payload.Items)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()

	coord := NewCoordinator(CoordinatorOptions{
		BFFOrigin:     bff.URL,
		InternalToken: "internal-secret-token",
	})

	coord.reportRequestError(RequestErrorReport{
		RequestID:      "req_test_1",
		Platform:       "openai",
		Model:          "gpt-5.2",
		Phase:          "upstream_http",
		Kind:           "upstream_http_429",
		StatusCode:     429,
		UpstreamStatus: 429,
		ErrorType:      "rate_limit_error",
		ErrorCode:      "rate_limit_exceeded",
		ErrorMessage:   "Too many requests",
		UpstreamBody:   `{"error":{"message":"Too many requests"}}`,
		Attempt:        1,
		FailoverUsed:   true,
	})
	coord.reportRequestError(RequestErrorReport{
		RequestID:    "req_test_2",
		Phase:        "outbound",
		Kind:         "outbound_dispatch_failed",
		StatusCode:   502,
		ErrorMessage: "dial tcp timeout",
		Attempt:      2,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	coord.FlushRequestErrors(ctx)

	mu.Lock()
	defer mu.Unlock()
	if gotToken != "internal-secret-token" {
		t.Fatalf("expected internal token header, got %q", gotToken)
	}
	total := 0
	for _, b := range batches {
		total += len(b)
	}
	if total != 2 {
		t.Fatalf("expected 2 reported request errors, got %d (batches=%d)", total, len(batches))
	}
}

func TestTruncateUTF8PreservesRunes(t *testing.T) {
	input := "prefix-你好世界"
	cut := truncateUTF8(input, len("prefix-")+4)
	if cut != "prefix-你..." {
		t.Fatalf("unexpected utf8 truncation: %q", cut)
	}
}
