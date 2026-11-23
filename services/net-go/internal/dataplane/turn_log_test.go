package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Split(strings.TrimSpace(b.buf.String()), "\n")
}

// turnLogCore answers eval with a dispatch directive and every settle report with ok:false (the
// core "lost" the hold), so the coordinator logs a turn-scoped warning.
func turnLogCore(t *testing.T) string {
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
				typ := dpbridge.FrameSettleAck
				payload := []byte(`{"ok":false,"settledCostNanoUsd":"0"}`)
				if req.Type == dpbridge.FrameReqHeaders {
					typ = dpbridge.FrameDispatchDirective
					payload, _ = json.Marshal(coreDispatchDirective{
						Action: "dispatch", Status: 200, HoldID: 7,
						UserID: "usr_1", APIKeyID: "key_1", GroupID: "grp_1", AccountID: "acc_mock",
						Provider: "anthropic", ExecutionMode: "direct_api",
						PublicModel: "claude-sonnet-4-5", UpstreamModel: "claude-sonnet-4-5", HoldNanoUSD: "1000",
					})
				}
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: req.StreamID, Type: typ, Flags: dpbridge.FlagEndStream, Payload: payload})
			}(conn)
		}
	}()
	return ln.Addr().String()
}

func findLine(lines []string, prefix string) string {
	for _, l := range lines {
		if i := strings.Index(l, prefix); i >= 0 {
			return l[i:]
		}
	}
	return ""
}

func TestTurnWarningsAndAccessLinesCarryCorrelationFields(t *testing.T) {
	out := &syncBuffer{}
	var accessOn atomic.Bool
	accessOn.Store(true)
	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:          turnLogCore(t),
		VaultSecret:      "turn-log-vault",
		Logger:           log.New(out, "", log.LstdFlags|log.Lmsgprefix),
		AccessLogEnabled: accessOn.Load,
	})
	enc, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		Accounts: []SyncAccountInput{{ID: "acc_mock", GroupID: "grp_1", Platform: "anthropic", ExecutionMode: "direct_api", CredentialsEncHex: enc, MaxConcurrency: 4, Status: "active"}},
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()

	turn := func(path, requestID string) int {
		req, _ := http.NewRequest(http.MethodPost, edge.URL+path, strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("x-api-key", "sk-sg-test")
		req.Header.Set("X-Request-Id", requestID)
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("turn: %v", err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	if status := turn("/v1/messages", "req_tl_1"); status != http.StatusOK {
		t.Fatalf("turn status %d", status)
	}
	lines := out.lines()
	corr := "request_id=req_tl_1 user_id=usr_1 api_key_id=key_1 account_id=acc_mock platform=anthropic model=claude-sonnet-4-5"

	warn := findLine(lines, "[dataplane] warning: slipgate-core did not settle hold 7")
	if warn == "" || !strings.Contains(warn, corr) || !strings.HasSuffix(warn, "hold_id=7") {
		t.Fatalf("turn warning without its correlation fields:\n%s", strings.Join(lines, "\n"))
	}
	access := findLine(lines, "[http.access] info: POST /v1/messages 200")
	if access == "" || !strings.Contains(access, corr) ||
		!strings.Contains(access, "method=POST path=/v1/messages status=200 latency_ms=") || !strings.HasSuffix(access, "client_ip=203.0.113.9") {
		t.Fatalf("access line:\n%s", strings.Join(lines, "\n"))
	}

	// Rejected before slipgate-core answers: the access line still records the status.
	if status := turn("/v2/unknown", "req_tl_2"); status != http.StatusNotFound {
		t.Fatalf("unsupported route status %d", status)
	}
	if l := findLine(out.lines(), "[http.access] info: POST /v2/unknown 404"); l == "" || !strings.Contains(l, "request_id=req_tl_2") || strings.Contains(l, "user_id=") {
		t.Fatalf("404 access line: %q", l)
	}

	// Access logs off: no access line, warnings still logged.
	accessOn.Store(false)
	before := len(out.lines())
	if status := turn("/v1/messages", "req_tl_3"); status != http.StatusOK {
		t.Fatalf("turn status %d", status)
	}
	after := out.lines()[before:]
	if findLine(after, "[http.access]") != "" || findLine(after, "request_id=req_tl_3") == "" {
		t.Fatalf("access logs off:\n%s", strings.Join(after, "\n"))
	}
}
