package syslogfwd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/logx"
)

var fixedNow = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

func TestParseNetLine(t *testing.T) {
	cases := []struct {
		line, level, component, message string
	}{
		{"2026/11/22 12:00:00 [dataplane] warning: stream relay interrupted on req_1: EOF", "warn", "dataplane", "stream relay interrupted on req_1: EOF"},
		{"2026/11/22 12:00:00 [net] Slipgate unified edge listening on :8080", "info", "net", "Slipgate unified edge listening on :8080"},
		{"2026/11/22 12:00:00 [mihomo:error] dial failed", "error", "mihomo", "dial failed"},
		{"2026/11/22 12:00:00 [supervisor] child core degraded (continuing): exit 1", "warn", "supervisor", "child core degraded (continuing): exit 1"},
		{"2026/11/22 12:00:00 [net] http shutdown error: boom", "error", "net", "http shutdown error: boom"},
		{"2026/11/22 12:00:00 plain line level=error request_id=req_9 model=\"claude x\"", "error", "net", "plain line"},
	}
	for _, tc := range cases {
		e, ok := parseNetLine(tc.line, fixedNow)
		if !ok {
			t.Fatalf("%q: not parsed", tc.line)
		}
		if e.Level != tc.level || e.Component != tc.component || e.Message != tc.message || e.Source != "net" {
			t.Fatalf("%q: got level=%s component=%s message=%q", tc.line, e.Level, e.Component, e.Message)
		}
	}
	e, _ := parseNetLine("2026/11/22 12:00:00 plain line level=error request_id=req_9 model=\"claude x\"", fixedNow)
	if e.RequestID != "req_9" || e.Model != "claude x" {
		t.Fatalf("logfmt fields not lifted: %+v", e)
	}
	if _, ok := parseNetLine("2026/11/22 12:00:00 [net]   ", fixedNow); ok {
		t.Fatalf("an empty message must be skipped")
	}
}

func TestParseCoreLine(t *testing.T) {
	e := parseCoreLine("error: accept error: ConnectionResetByPeer", fixedNow)
	if e.Source != "core" || e.Level != "error" || e.Component != "core" || e.Message != "accept error: ConnectionResetByPeer" {
		t.Fatalf("zig error line: %+v", e)
	}
	e = parseCoreLine("warning(ipc): frame too large", fixedNow)
	if e.Level != "warn" || e.Component != "core.ipc" || e.Message != "frame too large" {
		t.Fatalf("zig scoped warning: %+v", e)
	}
	e = parseCoreLine("info: slipgate-core 0.1.0 listening on 127.0.0.1:19081", fixedNow)
	if e.Level != "info" {
		t.Fatalf("zig info line: %+v", e)
	}
	e = parseCoreLine("thread 42 panic: index out of bounds", fixedNow)
	if e.Level != "error" || e.Component != "core" {
		t.Fatalf("unstructured panic line: %+v", e)
	}
}

type ingestCapture struct {
	mu       sync.Mutex
	requests []ingestRequest
	// accepted are the requests answered 200 (their entries were stored).
	accepted []ingestRequest
	tokens   []string
	level    string
	status   int
	access   bool
}

func (c *ingestCapture) handler(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.URL.Path != ingestPath {
		http.NotFound(w, r)
		return
	}
	var req ingestRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	c.requests = append(c.requests, req)
	c.tokens = append(c.tokens, r.Header.Get("X-Slipgate-Internal-Token"))
	if c.status != 0 {
		w.WriteHeader(c.status)
		return
	}
	level := c.level
	if level == "" {
		level = "info"
	}
	c.accepted = append(c.accepted, req)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"accepted": len(req.Entries), "filtered": 0, "dropped": 0,
		"config": map[string]any{"level": level, "persistAccessLogs": c.access},
	})
}

func (c *ingestCapture) acceptedEntries() []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Entry
	for _, r := range c.accepted {
		out = append(out, r.Entries...)
	}
	return out
}

func (c *ingestCapture) setStatus(status int) {
	c.mu.Lock()
	c.status = status
	c.mu.Unlock()
}

func (c *ingestCapture) entries() []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Entry
	for _, r := range c.requests {
		out = append(out, r.Entries...)
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met in time")
}

func TestForwarderTeesAndForwardsWorthKeepingLines(t *testing.T) {
	capture := &ingestCapture{}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	var out bytes.Buffer
	var outMu sync.Mutex
	fwd := New(Options{Out: lockedWriter{&out, &outMu}, Host: "edge-a", FlushInterval: 20 * time.Millisecond})
	fwd.SetTarget(srv.URL, "tok")
	hook := fwd.ChildLineHook("core", "bff")
	logger := log.New(fwd, "", log.LstdFlags|log.Lmsgprefix)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)

	logger.Printf("[net] listening")                         // info: not forwarded
	logger.Printf("[dataplane] warning: relay interrupted")  // forwarded
	logger.Printf("[audit.vm] slot reassigned to %s", "acc") // audit: forwarded
	logger.Printf("[core] error: echoed child line")         // child echo: only the hook forwards core
	hook("core", "error(ipc): bad frame")
	hook("bff", "ERROR [http] the BFF persists its own lines")

	waitFor(t, func() bool { return fwd.Health().SentCount >= 3 })
	got := capture.entries()
	if len(got) != 3 {
		t.Fatalf("expected 3 forwarded entries, got %+v", got)
	}
	byMsg := map[string]Entry{}
	for _, e := range got {
		byMsg[e.Message] = e
	}
	if e := byMsg["relay interrupted"]; e.Source != "net" || e.Level != "warn" || e.Component != "dataplane" {
		t.Fatalf("net warning: %+v", e)
	}
	if e := byMsg["slot reassigned to acc"]; e.Level != "info" || e.Component != "audit.vm" {
		t.Fatalf("audit line: %+v", e)
	}
	if e := byMsg["bad frame"]; e.Source != "core" || e.Level != "error" || e.Component != "core.ipc" {
		t.Fatalf("core line: %+v", e)
	}
	capture.mu.Lock()
	if capture.tokens[0] != "tok" || capture.requests[0].Host != "edge-a" {
		t.Fatalf("request headers/host: %v %q", capture.tokens, capture.requests[0].Host)
	}
	capture.mu.Unlock()

	outMu.Lock()
	printed := out.String()
	outMu.Unlock()
	for _, want := range []string{"[net] listening", "[dataplane] warning: relay interrupted", "[core] error: echoed child line"} {
		if !bytes.Contains([]byte(printed), []byte(want)) {
			t.Fatalf("stdout tee lost %q:\n%s", want, printed)
		}
	}
	if h := fwd.Health(); h.SentCount != 3 || h.DroppedCount != 0 || h.LastError != "" {
		t.Fatalf("health: %+v", h)
	}
}

func TestForwarderAppliesTheRuntimeLevelFromTheResponse(t *testing.T) {
	capture := &ingestCapture{level: "error"}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	fwd := New(Options{Out: io.Discard, FlushInterval: 20 * time.Millisecond})
	fwd.SetTarget(srv.URL, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)

	// The first tick is a heartbeat: it fetches the config (level error).
	waitFor(t, func() bool {
		capture.mu.Lock()
		defer capture.mu.Unlock()
		return len(capture.requests) >= 1
	})
	waitFor(t, func() bool { return fwd.minRank.Load() == rank("error") })
	fwd.ChildLine("core", "warning: below the level")
	fwd.ChildLine("core", "error: kept")
	waitFor(t, func() bool { return len(capture.entries()) >= 1 })
	time.Sleep(60 * time.Millisecond)
	got := capture.entries()
	if len(got) != 1 || got[0].Message != "kept" {
		t.Fatalf("expected only the error entry, got %+v", got)
	}
}

func TestForwarderDropsWhenFullAndCountsFailedBatches(t *testing.T) {
	capture := &ingestCapture{status: http.StatusBadRequest}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	now := fixedNow
	var nowMu sync.Mutex
	clock := func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return now
	}
	fwd := New(Options{Out: io.Discard, Capacity: 2, BatchSize: 10, FlushInterval: 10 * time.Millisecond, BackoffBase: time.Second, BackoffMax: 4 * time.Second, Now: clock})
	fwd.SetTarget(srv.URL, "tok")

	// Not running yet: the queue holds 2, the third is dropped.
	for i := 0; i < 3; i++ {
		fwd.ChildLine("core", "error: queued")
	}
	if h := fwd.Health(); h.QueueDepth != 2 || h.DroppedCount != 1 {
		t.Fatalf("back-pressure: %+v", h)
	}
	if got := []time.Duration{fwd.backoffFor(1), fwd.backoffFor(2), fwd.backoffFor(3), fwd.backoffFor(4)}; got[0] != time.Second || got[1] != 2*time.Second || got[2] != 4*time.Second || got[3] != 4*time.Second {
		t.Fatalf("backoff: %v", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)
	advance := func(d time.Duration) {
		nowMu.Lock()
		now = now.Add(d)
		nowMu.Unlock()
	}
	// The BFF refuses the batch (400). Each refusal opens a backoff window (the clock is moved past
	// it); after three attempts the batch counts as failed.
	for i := 1; i <= 8 && fwd.Health().FailedCount == 0; i++ {
		want := uint64(i)
		waitFor(t, func() bool { return fwd.posts.Load() >= want })
		advance(5 * time.Second)
	}
	waitFor(t, func() bool { return fwd.Health().FailedCount == 2 })
	capture.mu.Lock()
	attempts := len(capture.requests)
	capture.mu.Unlock()
	if attempts < 3 {
		t.Fatalf("expected at least 3 attempts before giving up, got %d", attempts)
	}
	if h := fwd.Health(); h.LastError == "" || h.SentCount != 0 {
		t.Fatalf("failure accounting: %+v", h)
	}
}

// Warnings net logs before the BFF listens (no target yet, then 503 while it boots) are kept
// across any number of backoff windows and delivered once the BFF accepts them.
func TestForwarderKeepsTheBatchWhileTheBFFIsUnreachable(t *testing.T) {
	capture := &ingestCapture{status: http.StatusServiceUnavailable}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	now := fixedNow
	var nowMu sync.Mutex
	clock := func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		nowMu.Lock()
		now = now.Add(d)
		nowMu.Unlock()
	}
	fwd := New(Options{Out: io.Discard, FlushInterval: 5 * time.Millisecond, BackoffBase: time.Second, BackoffMax: 4 * time.Second, Now: clock})
	logger := log.New(fwd, "", log.LstdFlags|log.Lmsgprefix)
	logger.Printf("[security] WARNING: running with weak secrets")
	logger.Printf("[clash] bootstrap degraded (continuing): no nodes")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)

	// No target configured yet: several windows pass without giving the batch up.
	for i := 1; i <= 4; i++ {
		want := uint64(i)
		waitFor(t, func() bool { return fwd.posts.Load() >= want })
		advance(5 * time.Second)
	}
	// The BFF answers but is not ready (503) for more windows than the refusal limit.
	fwd.SetTarget(srv.URL, "tok")
	base := fwd.posts.Load()
	for i := 1; i <= 4; i++ {
		want := base + uint64(i)
		waitFor(t, func() bool { return fwd.posts.Load() >= want })
		advance(5 * time.Second)
	}
	if h := fwd.Health(); h.FailedCount != 0 || h.SentCount != 0 || h.LastError == "" {
		t.Fatalf("an unreachable BFF must not fail the batch: %+v", h)
	}

	capture.setStatus(0)
	advance(5 * time.Second)
	waitFor(t, func() bool { return len(capture.acceptedEntries()) >= 2 })
	got := capture.acceptedEntries()
	if got[0].Component != "security" || got[0].Message != "running with weak secrets" || got[1].Component != "clash" {
		t.Fatalf("early warnings: %+v", got)
	}
	waitFor(t, func() bool { return fwd.Health().SentCount == 2 })
	if h := fwd.Health(); h.FailedCount != 0 || h.LastError != "" {
		t.Fatalf("health after recovery: %+v", h)
	}
}

// A structured (logx) line reaches the ingest with its correlation columns and context.
func TestStructuredLineFieldsReachTheIngest(t *testing.T) {
	capture := &ingestCapture{}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	fwd := New(Options{Out: io.Discard, FlushInterval: 10 * time.Millisecond})
	fwd.SetTarget(srv.URL, "tok")
	logger := log.New(fwd, "", log.LstdFlags|log.Lmsgprefix)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)

	logx.Event(logger, "dataplane", "warn", "stream relay interrupted: unexpected EOF",
		"request_id", "req_42", "user_id", "u_7", "api_key_id", "key_3", "account_id", "acc_9",
		"platform", "anthropic", "model", "claude sonnet", "upstream_status", "200", "hold_id", "")

	waitFor(t, func() bool { return len(capture.acceptedEntries()) >= 1 })
	e := capture.acceptedEntries()[0]
	if e.Level != "warn" || e.Component != "dataplane" || e.Message != "stream relay interrupted: unexpected EOF" {
		t.Fatalf("entry: %+v", e)
	}
	if e.RequestID != "req_42" || e.UserID != "u_7" || e.APIKeyID != "key_3" || e.AccountID != "acc_9" || e.Platform != "anthropic" || e.Model != "claude sonnet" {
		t.Fatalf("correlation fields: %+v", e)
	}
	if v, ok := e.Context["upstreamStatus"].(float64); !ok || v != 200 {
		t.Fatalf("context: %#v", e.Context)
	}
	if _, ok := e.Context["holdId"]; ok {
		t.Fatalf("empty values are left out: %#v", e.Context)
	}
}

func TestAccessLinesFollowTheRuntimeConfig(t *testing.T) {
	capture := &ingestCapture{access: true}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	defer srv.Close()

	fwd := New(Options{Out: io.Discard, FlushInterval: 10 * time.Millisecond})
	if fwd.AccessLogsEnabled() {
		t.Fatalf("access lines are off until the BFF says otherwise")
	}
	fwd.SetTarget(srv.URL, "tok")
	logger := log.New(fwd, "", log.LstdFlags|log.Lmsgprefix)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fwd.Run(ctx)
	waitFor(t, fwd.AccessLogsEnabled)

	logx.Event(logger, "http.access", "info", "POST /v1/messages 200",
		"request_id", "req_1", "method", "POST", "path", "/v1/messages", "status", "200", "latency_ms", "35", "client_ip", "10.0.0.1")
	waitFor(t, func() bool { return len(capture.acceptedEntries()) >= 1 })
	e := capture.acceptedEntries()[0]
	if e.Level != "info" || e.Component != "http.access" || e.Message != "POST /v1/messages 200" || e.RequestID != "req_1" {
		t.Fatalf("access entry: %+v", e)
	}
	if e.Context["method"] != "POST" || e.Context["path"] != "/v1/messages" || e.Context["status"] != float64(200) || e.Context["latencyMs"] != float64(35) || e.Context["clientIp"] != "10.0.0.1" {
		t.Fatalf("access context: %#v", e.Context)
	}

	// A warn level silences info, access lines included.
	fwd.ApplyConfig("warn", true)
	if fwd.AccessLogsEnabled() {
		t.Fatalf("access lines must stop below the runtime level")
	}
}

func TestLogfmtTailOnlyTakesWellFormedPairs(t *testing.T) {
	e, _ := parseNetLine("2026/11/22 12:00:00 [net] Slipgate unified edge listening on :8080 (mode=dev bff=127.0.0.1:19082)", fixedNow)
	if e.Message != "Slipgate unified edge listening on :8080 (mode=dev bff=127.0.0.1:19082)" || len(e.Context) != 0 {
		t.Fatalf("prose with '=' must stay in the message: %+v", e)
	}
	e, _ = parseNetLine(`2026/11/22 12:00:00 [dataplane] error: dial failed: refused account_id=acc_1 note="a \"b\" c"`, fixedNow)
	if e.AccountID != "acc_1" || e.Level != "error" {
		t.Fatalf("pair before a malformed quoted value: %+v", e)
	}
	if got := logx.Format("x", "warn", "m", "note", `say "hi"`, "Bad", "k"); got != `[x] warning: m note="say 'hi'"` {
		t.Fatalf("format: %q", got)
	}
}

func TestForwarderDisabledOnlyTees(t *testing.T) {
	var out bytes.Buffer
	fwd := New(Options{Out: &out, Disabled: true})
	logger := log.New(fwd, "", 0)
	logger.Printf("[net] error: something")
	fwd.ChildLine("core", "error: x")
	if out.String() != "[net] error: something\n" {
		t.Fatalf("tee: %q", out.String())
	}
	if h := fwd.Health(); h.QueueDepth != 0 || h.DroppedCount != 0 {
		t.Fatalf("disabled forwarder queued: %+v", h)
	}
}

type lockedWriter struct {
	w  io.Writer
	mu *sync.Mutex
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
