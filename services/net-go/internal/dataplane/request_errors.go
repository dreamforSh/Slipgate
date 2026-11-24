package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	requestErrorQueueSize      = 256
	requestErrorMaxBatch       = 32
	requestErrorMaxMessageLen  = 4096
	requestErrorMaxBodyLen     = 16 * 1024
)

// RequestErrorReport mirrors BFF IngestRequestErrorItemSchema for non-blocking error telemetry.
type RequestErrorReport struct {
	RequestID       string         `json:"requestId"`
	ClientRequestID string         `json:"clientRequestId"`
	UserID          *string        `json:"userId,omitempty"`
	APIKeyID        *string        `json:"apiKeyId,omitempty"`
	AccountID       *string        `json:"accountId,omitempty"`
	GroupID         *string        `json:"groupId,omitempty"`
	Platform        string         `json:"platform"`
	Model           string         `json:"model"`
	UpstreamModel   string         `json:"upstreamModel"`
	Phase           string         `json:"phase"`
	Kind            string         `json:"kind"`
	StatusCode      int            `json:"statusCode"`
	UpstreamStatus  int            `json:"upstreamStatus"`
	ErrorType       string         `json:"errorType"`
	ErrorCode       string         `json:"errorCode"`
	ErrorMessage    string         `json:"errorMessage"`
	UpstreamBody    string         `json:"upstreamBody"`
	Attempt         int            `json:"attempt"`
	FailoverUsed    bool           `json:"failoverUsed"`
	DurationMs      int64          `json:"durationMs"`
	ExecutionMode   string         `json:"executionMode"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	CreatedAtIso    string         `json:"createdAtIso,omitempty"`
}

type requestErrorWorker struct {
	once  sync.Once
	ch    chan RequestErrorReport
	flush chan chan struct{}
	post  func(ctx context.Context, batch []RequestErrorReport)
}

func newRequestErrorWorker(post func(ctx context.Context, batch []RequestErrorReport)) *requestErrorWorker {
	return &requestErrorWorker{post: post}
}

func (w *requestErrorWorker) ensureStarted() {
	w.once.Do(func() {
		w.ch = make(chan RequestErrorReport, requestErrorQueueSize)
		w.flush = make(chan chan struct{}, 16)
		go w.run()
	})
}

func (w *requestErrorWorker) enqueue(ev RequestErrorReport) {
	w.ensureStarted()
	select {
	case w.ch <- ev:
	default:
		// Never stall data-plane traffic when the error center queue is saturated.
	}
}

func (w *requestErrorWorker) flushAll(ctx context.Context) {
	if w.ch == nil {
		return
	}
	done := make(chan struct{})
	select {
	case w.flush <- done:
	case <-ctx.Done():
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (w *requestErrorWorker) run() {
	for {
		select {
		case first := <-w.ch:
			w.drainAndSend([]RequestErrorReport{first})
		case done := <-w.flush:
			w.drainAll()
			close(done)
		}
	}
}

func (w *requestErrorWorker) drainAll() {
	for {
		var batch []RequestErrorReport
	drainLoop:
		for len(batch) < requestErrorMaxBatch {
			select {
			case ev := <-w.ch:
				batch = append(batch, ev)
			default:
				break drainLoop
			}
		}
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		w.post(ctx, batch)
		cancel()
	}
}

func (w *requestErrorWorker) drainAndSend(batch []RequestErrorReport) {
	for len(batch) < requestErrorMaxBatch {
		select {
		case ev := <-w.ch:
			batch = append(batch, ev)
		default:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			w.post(ctx, batch)
			cancel()
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	w.post(ctx, batch)
	cancel()
}

func optStringPtr(v string) *string {
	s := strings.TrimSpace(v)
	if s == "" {
		return nil
	}
	return &s
}

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

func (c *Coordinator) postRequestErrorsBatch(ctx context.Context, batch []RequestErrorReport) {
	if c.bffOrigin == "" || c.internalToken == "" || len(batch) == 0 {
		return
	}
	body, err := json.Marshal(struct {
		Items []RequestErrorReport `json:"items"`
	}{Items: batch})
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.bffOrigin+"/api/v1/internal/dataplane/request-errors", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	resp, doErr := c.bffClient.Do(req)
	if doErr != nil {
		c.logger.Printf("[dataplane] warning: POST /api/v1/internal/dataplane/request-errors failed: %v", doErr)
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
}

// FlushRequestErrors drains queued async request error reports before process exit or test assertions.
func (c *Coordinator) FlushRequestErrors(ctx context.Context) {
	if c.requestErrors != nil {
		c.requestErrors.flushAll(ctx)
	}
}

func (c *Coordinator) reportRequestError(ev RequestErrorReport) {
	if c.requestErrors == nil || c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	if ev.Attempt <= 0 {
		ev.Attempt = 1
	}
	if ev.DurationMs < 0 {
		ev.DurationMs = 0
	}
	if ev.Phase == "" {
		ev.Phase = "other"
	}
	if ev.CreatedAtIso == "" {
		ev.CreatedAtIso = time.Now().UTC().Format(time.RFC3339Nano)
	}
	ev.ErrorMessage = truncateUTF8(ev.ErrorMessage, requestErrorMaxMessageLen)
	ev.UpstreamBody = truncateUTF8(ev.UpstreamBody, requestErrorMaxBodyLen)
	c.requestErrors.enqueue(ev)
}

func buildDirectiveErrorReport(
	r *http.Request,
	requestID string,
	startedAt time.Time,
	dir *coreDispatchDirective,
	model string,
	phase string,
	kind string,
	statusCode int,
	upstreamStatus int,
	errType string,
	errCode string,
	errMsg string,
	upstreamBody string,
	attempt int,
	failoverUsed bool,
) RequestErrorReport {
	var clientReqID string
	var path string
	var method string
	if r != nil {
		clientReqID = strings.TrimSpace(r.Header.Get("X-Client-Request-Id"))
		path = r.URL.Path
		method = r.Method
	}
	rep := RequestErrorReport{
		RequestID:       requestID,
		ClientRequestID: clientReqID,
		Model:           model,
		Phase:           phase,
		Kind:            kind,
		StatusCode:      statusCode,
		UpstreamStatus:  upstreamStatus,
		ErrorType:       errType,
		ErrorCode:       errCode,
		ErrorMessage:    errMsg,
		UpstreamBody:    upstreamBody,
		Attempt:         max(1, attempt),
		FailoverUsed:    failoverUsed,
		DurationMs:      int64(elapsedMs(startedAt)),
		Metadata:        map[string]any{"method": method, "path": path},
	}
	if dir != nil {
		rep.UserID = optStringPtr(dir.UserID)
		rep.APIKeyID = optStringPtr(dir.APIKeyID)
		rep.AccountID = optStringPtr(dir.AccountID)
		rep.GroupID = optStringPtr(dir.GroupID)
		rep.Platform = dir.Provider
		rep.Model = firstNonEmpty(rep.Model, dir.PublicModel)
		rep.UpstreamModel = dir.UpstreamModel
		rep.ExecutionMode = dir.ExecutionMode
	}
	return rep
}
