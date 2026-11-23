// Package syslogfwd ships slipgate-net's own log lines and slipgate-core's (handed over by the
// supervisor) to the BFF's internal ingest endpoint, which stores them in the persisted system
// logs (admin → Ops → System logs).
//
// The Forwarder is the io.Writer of net's *log.Logger: every line still goes to stdout unchanged,
// and lines worth keeping (warnings and errors, audit components, access lines while the BFF
// persists them) are parsed into structured entries and queued. Structured lines written with
// internal/logx ("[component] level: message key=value ...") carry their correlation fields
// (request_id, user_id, api_key_id, account_id, platform, model) and context. The queue is
// bounded: when it is full the entry is dropped and counted, so logging never blocks. A background
// loop posts batches (and a heartbeat every 30 s with the forwarder's health), keeping a batch
// while the BFF is not reachable yet; the response carries the BFF's runtime log config, whose
// level then applies to what is forwarded from net and core.
//
// slipgate-bff lines are never forwarded: the BFF persists its own entries.
package syslogfwd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Entry is one forwarded log entry (contracts SystemLogIngestEntrySchema).
type Entry struct {
	Source          string         `json:"source"`
	TimeISO         string         `json:"timeIso,omitempty"`
	Level           string         `json:"level"`
	Component       string         `json:"component,omitempty"`
	Message         string         `json:"message"`
	RequestID       string         `json:"requestId,omitempty"`
	ClientRequestID string         `json:"clientRequestId,omitempty"`
	UserID          string         `json:"userId,omitempty"`
	APIKeyID        string         `json:"apiKeyId,omitempty"`
	AccountID       string         `json:"accountId,omitempty"`
	Platform        string         `json:"platform,omitempty"`
	Model           string         `json:"model,omitempty"`
	Context         map[string]any `json:"context,omitempty"`
}

// Health is the forwarder's delivery state, reported with every batch (contracts SystemLogForwarderHealthSchema).
type Health struct {
	QueueDepth    int    `json:"queueDepth"`
	QueueCapacity int    `json:"queueCapacity"`
	DroppedCount  uint64 `json:"droppedCount"`
	SentCount     uint64 `json:"sentCount"`
	FailedCount   uint64 `json:"failedCount"`
	LastError     string `json:"lastError"`
}

type ingestRequest struct {
	Host    string  `json:"host"`
	Entries []Entry `json:"entries"`
	Health  Health  `json:"health"`
}

type ingestResponse struct {
	Config *struct {
		Level             string `json:"level"`
		PersistAccessLogs bool   `json:"persistAccessLogs"`
	} `json:"config"`
}

const (
	DefaultCapacity          = 2000
	DefaultBatchSize         = 200
	DefaultFlushInterval     = 2 * time.Second
	DefaultHeartbeatInterval = 30 * time.Second
	DefaultBackoffBase       = 2 * time.Second
	DefaultBackoffMax        = 60 * time.Second
	// A batch the BFF refuses (a 4xx other than 408/429) is retried this many times, then counted
	// as failed. While the BFF is unreachable or not ready (no target yet, connection refused,
	// timeout, 5xx) the batch is kept and retried with backoff until it is accepted.
	maxBatchAttempts = 3
	// Trailing logfmt pairs read from one line, and context fields kept from them.
	maxTailPairs     = 24
	maxContextFields = 24
	maxMessageBytes  = 16 * 1024
	ingestPath       = "/api/v1/internal/system-logs"
)

// Options configures a Forwarder. Zero values take the defaults above.
type Options struct {
	// Out receives every line unchanged (os.Stdout when nil).
	Out io.Writer
	// Host names this process in the stored entries (os.Hostname when empty).
	Host              string
	Capacity          int
	BatchSize         int
	FlushInterval     time.Duration
	HeartbeatInterval time.Duration
	BackoffBase       time.Duration
	BackoffMax        time.Duration
	Client            *http.Client
	// Disabled keeps the stdout tee but never queues or sends anything.
	Disabled bool
	// Now is the clock (tests).
	Now func() time.Time
}

// Forwarder implements io.Writer for net's logger and the supervisor's child-line hook.
type Forwarder struct {
	out      io.Writer
	outMu    sync.Mutex
	host     string
	queue    chan Entry
	batch    int
	flush    time.Duration
	beat     time.Duration
	backBase time.Duration
	backMax  time.Duration
	client   *http.Client
	disabled bool
	now      func() time.Time

	targetMu sync.RWMutex
	origin   string
	token    string

	childMu   sync.RWMutex
	childTags map[string]bool

	minRank       atomic.Int32
	persistAccess atomic.Bool

	dropped atomic.Uint64
	sent    atomic.Uint64
	failed  atomic.Uint64
	lastErr atomic.Value
	running atomic.Bool
	// posts counts finished delivery attempts (outcome applied), for tests.
	posts atomic.Uint64
}

// New builds a Forwarder. Nothing is sent until SetTarget and Run.
func New(opts Options) *Forwarder {
	f := &Forwarder{
		out:       opts.Out,
		host:      strings.TrimSpace(opts.Host),
		batch:     opts.BatchSize,
		flush:     opts.FlushInterval,
		beat:      opts.HeartbeatInterval,
		backBase:  opts.BackoffBase,
		backMax:   opts.BackoffMax,
		client:    opts.Client,
		disabled:  opts.Disabled,
		now:       opts.Now,
		childTags: map[string]bool{},
	}
	if f.out == nil {
		f.out = os.Stdout
	}
	if f.host == "" {
		if h, err := os.Hostname(); err == nil && strings.TrimSpace(h) != "" {
			f.host = strings.TrimSpace(h)
		} else {
			f.host = "unknown"
		}
	}
	capacity := opts.Capacity
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	f.queue = make(chan Entry, capacity)
	if f.batch <= 0 {
		f.batch = DefaultBatchSize
	}
	if f.flush <= 0 {
		f.flush = DefaultFlushInterval
	}
	if f.beat <= 0 {
		f.beat = DefaultHeartbeatInterval
	}
	if f.backBase <= 0 {
		f.backBase = DefaultBackoffBase
	}
	if f.backMax < f.backBase {
		f.backMax = DefaultBackoffMax
		if f.backMax < f.backBase {
			f.backMax = f.backBase
		}
	}
	if f.client == nil {
		f.client = &http.Client{Timeout: 5 * time.Second}
	}
	if f.now == nil {
		f.now = time.Now
	}
	f.minRank.Store(rank("info"))
	f.lastErr.Store("")
	return f
}

// SetTarget points the forwarder at the BFF (origin like "127.0.0.1:19082" or "http://host:port").
func (f *Forwarder) SetTarget(origin, token string) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin != "" && !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
		origin = "http://" + origin
	}
	f.targetMu.Lock()
	f.origin = origin
	f.token = strings.TrimSpace(token)
	f.targetMu.Unlock()
}

func (f *Forwarder) target() (string, string) {
	f.targetMu.RLock()
	defer f.targetMu.RUnlock()
	return f.origin, f.token
}

// ChildLineHook returns the supervisor hook for the given children's output. Their lines, which
// the supervisor also echoes through net's logger as "[name] line", are then forwarded only from
// the hook (core with source "core"; bff never).
func (f *Forwarder) ChildLineHook(children ...string) func(child, line string) {
	f.childMu.Lock()
	for _, c := range children {
		f.childTags[strings.ToLower(c)] = true
	}
	f.childMu.Unlock()
	return f.ChildLine
}

func (f *Forwarder) isChildTag(tag string) bool {
	f.childMu.RLock()
	defer f.childMu.RUnlock()
	return f.childTags[tag]
}

// Write tees one logger write to Out and queues its parsed entry when it is worth keeping.
// It never blocks on the network and never fails because of forwarding.
func (f *Forwarder) Write(p []byte) (int, error) {
	f.outMu.Lock()
	n, err := f.out.Write(p)
	f.outMu.Unlock()
	if f.disabled {
		return n, err
	}
	line := strings.TrimRight(string(p), "\r\n")
	if line != "" {
		if e, ok := parseNetLine(line, f.now()); ok && !f.isChildTag(e.Component) {
			f.offer(e)
		}
	}
	return n, err
}

// ChildLine handles one output line of a supervised child.
func (f *Forwarder) ChildLine(child, line string) {
	if f.disabled {
		return
	}
	child = strings.ToLower(strings.TrimSpace(child))
	line = strings.TrimRight(line, "\r\n")
	if child == "bff" || strings.TrimSpace(line) == "" {
		return // slipgate-bff persists its own entries
	}
	var e Entry
	if child == "core" {
		e = parseCoreLine(line, f.now())
	} else {
		e = parseChildLine(child, line, f.now())
	}
	f.offer(e)
}

func (f *Forwarder) offer(e Entry) {
	if !f.shouldForward(e) {
		return
	}
	if len(e.Message) > maxMessageBytes {
		e.Message = e.Message[:maxMessageBytes]
	}
	select {
	case f.queue <- e:
	default:
		f.dropped.Add(1)
	}
}

func isAudit(component string) bool { return strings.Contains(strings.ToLower(component), "audit") }
func isAccess(component string) bool {
	return strings.Contains(strings.ToLower(component), "http.access")
}

// shouldForward mirrors the BFF's rules: the runtime level (audit exempt), then warnings/errors,
// audit components, and access lines only while access logs are persisted.
func (f *Forwarder) shouldForward(e Entry) bool {
	audit := isAudit(e.Component)
	r := rank(e.Level)
	if !audit && r < f.minRank.Load() {
		return false
	}
	if r >= rank("warn") || audit {
		return true
	}
	return isAccess(e.Component) && f.persistAccess.Load()
}

// ApplyConfig sets the minimum level and access-log flag (from the BFF's ingest response).
func (f *Forwarder) ApplyConfig(level string, persistAccess bool) {
	if norm := normalizeLevel(level); norm != "" {
		f.minRank.Store(rank(norm))
	}
	f.persistAccess.Store(persistAccess)
}

// AccessLogsEnabled reports whether per-request http.access lines are forwarded right now (the
// BFF persists access logs and the runtime level lets info through). Callers skip building those
// lines while it is false.
func (f *Forwarder) AccessLogsEnabled() bool {
	return !f.disabled && f.persistAccess.Load() && f.minRank.Load() <= rank("info")
}

// Health reports the forwarder's queue and delivery counters.
func (f *Forwarder) Health() Health {
	last, _ := f.lastErr.Load().(string)
	return Health{
		QueueDepth:    len(f.queue),
		QueueCapacity: cap(f.queue),
		DroppedCount:  f.dropped.Load(),
		SentCount:     f.sent.Load(),
		FailedCount:   f.failed.Load(),
		LastError:     last,
	}
}

func (f *Forwarder) backoffFor(failures int) time.Duration {
	d := f.backBase
	for i := 1; i < failures && d < f.backMax; i++ {
		d *= 2
	}
	if d > f.backMax {
		d = f.backMax
	}
	return d
}

// Run delivers queued entries until ctx ends, then makes one last attempt with what is queued.
func (f *Forwarder) Run(ctx context.Context) {
	if f.disabled || !f.running.CompareAndSwap(false, true) {
		return
	}
	defer f.running.Store(false)
	ticker := time.NewTicker(f.flush)
	defer ticker.Stop()

	batch := make([]Entry, 0, f.batch)
	attempts := 0
	failures := 0
	var suppressedUntil time.Time
	var lastSend time.Time

	send := func() {
		err := f.post(ctx, batch)
		lastSend = f.now()
		defer f.posts.Add(1)
		if err == nil {
			f.sent.Add(uint64(len(batch)))
			f.lastErr.Store("")
			batch = batch[:0]
			attempts, failures = 0, 0
			suppressedUntil = time.Time{}
			return
		}
		failures++
		suppressedUntil = f.now().Add(f.backoffFor(failures))
		f.lastErr.Store(truncate(err.Error(), 500))
		if len(batch) == 0 {
			return
		}
		// Only a refusal of the batch itself counts toward giving up. While the BFF is starting or
		// restarting (or not reachable at all) the batch is kept, so the warnings net logs before
		// the BFF listens still arrive; it is bounded, since the queue behind it drops when full.
		var refused *refusedError
		if !errors.As(err, &refused) {
			return
		}
		attempts++
		if attempts >= maxBatchAttempts {
			f.failed.Add(uint64(len(batch)))
			batch = batch[:0]
			attempts = 0
		}
	}

	for {
		var in <-chan Entry
		if len(batch) < f.batch {
			in = f.queue
		}
		select {
		case <-ctx.Done():
			f.finalFlush(batch)
			return
		case e := <-in:
			batch = append(batch, e)
			if len(batch) >= f.batch && !f.now().Before(suppressedUntil) {
				send()
			}
		case <-ticker.C:
			if f.now().Before(suppressedUntil) {
				continue
			}
			if len(batch) > 0 || lastSend.IsZero() || f.now().Sub(lastSend) >= f.beat {
				send()
			}
		}
	}
}

func (f *Forwarder) finalFlush(batch []Entry) {
	for len(batch) < 2*f.batch {
		select {
		case e := <-f.queue:
			batch = append(batch, e)
			continue
		default:
		}
		break
	}
	if len(batch) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.post(ctx, batch); err != nil {
		f.failed.Add(uint64(len(batch)))
		f.lastErr.Store(truncate(err.Error(), 500))
		return
	}
	f.sent.Add(uint64(len(batch)))
}

var errNoTarget = errors.New("system log forwarding target not configured")

// refusedError is a definitive answer about the batch (a 4xx other than 408/429): resending the
// same body will not help.
type refusedError struct {
	status int
	body   string
}

func (e *refusedError) Error() string {
	return fmt.Sprintf("ingest status %d: %s", e.status, e.body)
}

func (f *Forwarder) post(ctx context.Context, batch []Entry) error {
	origin, token := f.target()
	if origin == "" || token == "" {
		return errNoTarget
	}
	entries := batch
	if entries == nil {
		entries = []Entry{}
	}
	body, err := json.Marshal(ingestRequest{Host: f.host, Entries: entries, Health: f.Health()})
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, origin+ingestPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slipgate-Internal-Token", token)
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body := truncate(strings.TrimSpace(string(raw)), 200)
		if res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != http.StatusRequestTimeout && res.StatusCode != http.StatusTooManyRequests {
			return &refusedError{status: res.StatusCode, body: body}
		}
		return fmt.Errorf("ingest status %d: %s", res.StatusCode, body)
	}
	var parsed ingestResponse
	if json.Unmarshal(raw, &parsed) == nil && parsed.Config != nil {
		f.ApplyConfig(parsed.Config.Level, parsed.Config.PersistAccessLogs)
	}
	return nil
}

/* ------------------------------------------------------------------------------------------ */
/* Parsing                                                                                     */
/* ------------------------------------------------------------------------------------------ */

var (
	stdTimestamp = regexp.MustCompile(`^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})? `)
	leadingTag   = regexp.MustCompile(`^\[([^\]\s]{1,64})\]\s*`)
	zigLine      = regexp.MustCompile(`^(error|warning|info|debug)(?:\(([^)\s]{1,64})\))?: (.*)$`)
	logfmtLevel  = regexp.MustCompile(`(?:^|\s)level=("?)([A-Za-z]{3,8})("?)(?:\s|$)`)
	logfmtField  = regexp.MustCompile(`(?:^|\s)(request_id|client_request_id|user_id|api_key_id|account_id|platform|model)=("[^"]{0,256}"|[^\s"]{1,256})`)
	wordLevel    = regexp.MustCompile(`^(?i)(fatal|panic|error|err|warning|warn|info|debug)\b[:\s]`)
	// "warning: message" — the level word logx (and most net lines) put first; it becomes the level.
	levelPrefix = regexp.MustCompile(`^(?i)(fatal|panic|error|err|warning|warn|info|debug):\s*`)
	// One logfmt pair at the end of a line. Bare values are limited to the characters logx writes
	// unquoted, so prose such as "(mode=dev core=x)" is not mistaken for fields.
	tailPair = regexp.MustCompile(`(?:^|\s)([a-z][a-z0-9_]{0,39})=("[^"]{0,256}"|[A-Za-z0-9._:/@+\-]{1,256})$`)
)

func rank(level string) int32 {
	switch level {
	case "debug":
		return 10
	case "info":
		return 20
	case "warn":
		return 30
	case "error":
		return 40
	}
	return 20
}

// normalizeLevel maps common spellings onto debug/info/warn/error ("" when unknown).
func normalizeLevel(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "trace", "debug":
		return "debug"
	case "info", "information", "notice":
		return "info"
	case "warn", "warning":
		return "warn"
	case "err", "error", "fatal", "panic", "dpanic", "critical", "crit":
		return "error"
	}
	return ""
}

// inferLevel reads a level from unstructured text: an explicit logfmt `level=`, a leading level
// word, then keywords (fatal/panic/error → error; warning/failed/degraded/… → warn), else info.
func inferLevel(msg string) string {
	if m := logfmtLevel.FindStringSubmatch(msg); m != nil {
		if l := normalizeLevel(m[2]); l != "" {
			return l
		}
	}
	if m := wordLevel.FindStringSubmatch(msg); m != nil {
		if l := normalizeLevel(m[1]); l != "" {
			return l
		}
	}
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "fatal"), strings.Contains(lower, "panic"), strings.Contains(lower, "error"):
		return "error"
	case strings.Contains(lower, "warn"), strings.Contains(lower, "failed"), strings.Contains(lower, "failure"),
		strings.Contains(lower, "degraded"), strings.Contains(lower, "unable to"), strings.Contains(lower, "cannot"),
		strings.Contains(lower, "refused"), strings.Contains(lower, "timeout"), strings.Contains(lower, "timed out"):
		return "warn"
	}
	return "info"
}

// setCorrelation fills a correlation column from a logfmt key; false for any other key.
func setCorrelation(e *Entry, key, v string, overwrite bool) bool {
	var dst *string
	switch key {
	case "request_id":
		dst = &e.RequestID
	case "client_request_id":
		dst = &e.ClientRequestID
	case "user_id":
		dst = &e.UserID
	case "api_key_id":
		dst = &e.APIKeyID
	case "account_id":
		dst = &e.AccountID
	case "platform":
		dst = &e.Platform
	case "model":
		dst = &e.Model
	default:
		return false
	}
	if overwrite || *dst == "" {
		*dst = v
	}
	return true
}

// splitLogfmtTail separates the trailing run of logfmt pairs from the text before it. The pairs
// come back in line order.
func splitLogfmtTail(text string) (string, [][2]string) {
	rest := strings.TrimRight(text, " \t")
	var pairs [][2]string
	for len(pairs) < maxTailPairs {
		m := tailPair.FindStringSubmatchIndex(rest)
		if m == nil {
			break
		}
		val := rest[m[4]:m[5]]
		if len(val) >= 2 && val[0] == '"' {
			val = val[1 : len(val)-1]
		}
		pairs = append(pairs, [2]string{rest[m[2]:m[3]], val})
		rest = strings.TrimRight(rest[:m[0]], " \t")
	}
	for i, j := 0, len(pairs)-1; i < j; i, j = i+1, j-1 {
		pairs[i], pairs[j] = pairs[j], pairs[i]
	}
	return rest, pairs
}

// camelKey turns a logfmt key into the context's spelling ("latency_ms" → "latencyMs").
func camelKey(k string) string {
	if !strings.Contains(k, "_") {
		return k
	}
	parts := strings.Split(k, "_")
	var b strings.Builder
	b.WriteString(parts[0])
	for _, p := range parts[1:] {
		if p == "" {
			continue
		}
		b.WriteString(strings.ToUpper(p[:1]))
		b.WriteString(p[1:])
	}
	return b.String()
}

// contextValue keeps whole numbers as numbers (status, latency) and everything else as text.
func contextValue(v string) any {
	if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > -(1<<53) && n < 1<<53 {
		return n
	}
	return v
}

// liftFields reads a line's logfmt fields and returns the message without them. The trailing run
// of key=value pairs fills the correlation columns (request_id, user_id, api_key_id, account_id,
// platform, model) and the context (other keys, camelCased; "level" is the level, not context);
// correlation keys elsewhere in the text are still lifted. A line that is nothing but fields
// keeps its whole text as the message.
func liftFields(e *Entry, text string) string {
	msg, pairs := splitLogfmtTail(text)
	for _, p := range pairs {
		if p[0] == "level" || setCorrelation(e, p[0], p[1], true) {
			continue
		}
		if e.Context == nil {
			e.Context = map[string]any{}
		}
		if len(e.Context) < maxContextFields {
			e.Context[camelKey(p[0])] = contextValue(p[1])
		}
	}
	for _, m := range logfmtField.FindAllStringSubmatch(msg, -1) {
		setCorrelation(e, m[1], strings.Trim(m[2], `"`), false)
	}
	if strings.TrimSpace(msg) == "" {
		return text
	}
	return msg
}

// stripLevelWord drops a leading "warning: " (the entry's level says it) unless nothing would remain.
func stripLevelWord(text string) string {
	if m := levelPrefix.FindStringIndex(text); m != nil && m[1] < len(text) {
		return text[m[1]:]
	}
	return text
}

// parseNetLine reads one line of net's logger ("2006/01/02 15:04:05 [component] message", logx's
// "[component] level: message key=value ..." included). Lines whose message is empty are skipped.
func parseNetLine(line string, now time.Time) (Entry, bool) {
	text := stdTimestamp.ReplaceAllString(line, "")
	e := Entry{Source: "net", TimeISO: now.UTC().Format(time.RFC3339Nano), Component: "net"}
	if m := leadingTag.FindStringSubmatch(text); m != nil {
		tag := strings.ToLower(m[1])
		text = text[len(m[0]):]
		// "[mihomo:warning]" carries the level after the colon.
		if i := strings.IndexByte(tag, ':'); i > 0 {
			if l := normalizeLevel(tag[i+1:]); l != "" {
				e.Level = l
			}
			tag = tag[:i]
		}
		e.Component = tag
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return Entry{}, false
	}
	if e.Level == "" {
		e.Level = inferLevel(text)
	}
	e.Message = stripLevelWord(liftFields(&e, text))
	return e, true
}

// parseChildLine is a non-core child's line: source net, the child name as the component.
func parseChildLine(child, line string, now time.Time) Entry {
	text := strings.TrimSpace(line)
	e := Entry{Source: "net", TimeISO: now.UTC().Format(time.RFC3339Nano), Component: child, Level: inferLevel(text)}
	e.Message = liftFields(&e, text)
	return e
}

// parseCoreLine reads Zig std.log output ("warning(scope): message", "error: message"); other
// lines get an inferred level. The scope (or "core") is the component.
func parseCoreLine(line string, now time.Time) Entry {
	text := strings.TrimSpace(line)
	e := Entry{Source: "core", TimeISO: now.UTC().Format(time.RFC3339Nano), Component: "core"}
	if m := zigLine.FindStringSubmatch(text); m != nil {
		e.Level = normalizeLevel(m[1])
		if m[2] != "" {
			e.Component = "core." + strings.ToLower(m[2])
		}
		text = strings.TrimSpace(m[3])
	} else {
		e.Level = inferLevel(text)
	}
	if text == "" {
		text = "(empty)"
	}
	e.Message = liftFields(&e, text)
	return e
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
