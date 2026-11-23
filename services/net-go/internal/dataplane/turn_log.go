package dataplane

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/logx"
)

// Structured log lines of data-plane turns (internal/logx). They carry the turn's correlation
// fields, so the admin System logs filters (request, user, API key, account, platform, model)
// find net's warnings and access entries the way they find the BFF's.

// turnFields are a turn's correlation fields: request_id, and once slipgate-core has resolved the
// turn, user_id, api_key_id, account_id, platform (the upstream provider) and model (the public
// model, or the one the client asked for before the directive exists).
func turnFields(requestID string, d *coreDispatchDirective, requestedModel string) []string {
	fields := make([]string, 0, 16)
	fields = append(fields, "request_id", requestID)
	model := requestedModel
	if d != nil {
		fields = append(fields,
			"user_id", d.UserID,
			"api_key_id", d.APIKeyID,
			"account_id", d.AccountID,
			"platform", d.Provider,
		)
		if d.PublicModel != "" {
			model = d.PublicModel
		}
	}
	return append(fields, "model", model)
}

func fmtUint(n uint64) string { return strconv.FormatUint(n, 10) }
func fmtInt(n int64) string   { return strconv.FormatInt(n, 10) }

// logEvent writes one structured "[dataplane]" line; kv holds key/value pairs.
func (c *Coordinator) logEvent(level, msg string, kv ...string) {
	logx.Event(c.logger, "dataplane", level, msg, kv...)
}

// logTurn writes one structured "[dataplane]" line about a turn; extra holds more key/value pairs.
func (c *Coordinator) logTurn(level, msg, requestID string, d *coreDispatchDirective, requestedModel string, extra ...string) {
	logx.Event(c.logger, "dataplane", level, msg, append(turnFields(requestID, d, requestedModel), extra...)...)
}

/* ------------------------------------------------------------------------------------------ */
/* http.access lines (only while the BFF persists access logs)                                 */
/* ------------------------------------------------------------------------------------------ */

// accessRecorder remembers the status a turn answered with. Streaming keeps working (Flush) and
// http.ResponseController still reaches the real writer (Unwrap).
type accessRecorder struct {
	http.ResponseWriter
	status int
}

func (a *accessRecorder) WriteHeader(code int) {
	if a.status == 0 && code >= 200 {
		a.status = code
	}
	a.ResponseWriter.WriteHeader(code)
}

func (a *accessRecorder) Write(p []byte) (int, error) {
	if a.status == 0 {
		a.status = http.StatusOK
	}
	return a.ResponseWriter.Write(p)
}

func (a *accessRecorder) Flush() {
	if f, ok := a.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (a *accessRecorder) Unwrap() http.ResponseWriter { return a.ResponseWriter }

// turnAccess collects what a turn's http.access line reports. A nil *turnAccess (access logs
// off) makes every method a no-op, so the hot path pays one flag check.
type turnAccess struct {
	rec       *accessRecorder
	r         *http.Request
	startedAt time.Time
	turn      *CanonicalTurn
	directive *coreDispatchDirective
}

// beginAccess wraps *w to record the status when access lines are forwarded; nil otherwise.
func (c *Coordinator) beginAccess(w *http.ResponseWriter, r *http.Request, startedAt time.Time) *turnAccess {
	if c.accessLogEnabled == nil || !c.accessLogEnabled() {
		return nil
	}
	rec := &accessRecorder{ResponseWriter: *w}
	*w = rec
	return &turnAccess{rec: rec, r: r, startedAt: startedAt}
}

func (a *turnAccess) setTurn(t *CanonicalTurn) {
	if a != nil {
		a.turn = t
	}
}

func (a *turnAccess) setDirective(d *coreDispatchDirective) {
	if a != nil {
		a.directive = d
	}
}

// finishAccess writes the turn's "[http.access]" line: method, path, status, latency, client IP
// and the correlation fields known by the time it answered.
func (c *Coordinator) finishAccess(a *turnAccess) {
	if a == nil {
		return
	}
	status := a.rec.status
	if status == 0 {
		status = http.StatusOK // nothing written: net/http answers 200
	}
	requestedModel := ""
	if a.turn != nil {
		requestedModel = a.turn.PublicModel
	}
	var d *coreDispatchDirective
	if a.directive != nil && a.directive.Action != "" {
		d = a.directive
	}
	fields := append(turnFields(a.rec.Header().Get("X-Request-Id"), d, requestedModel),
		"method", a.r.Method,
		"path", a.r.URL.Path,
		"status", strconv.Itoa(status),
		"latency_ms", strconv.FormatInt(time.Since(a.startedAt).Milliseconds(), 10),
		"client_ip", extractClientIP(a.r),
	)
	logx.Event(c.logger, "http.access", "info", fmt.Sprintf("%s %s %d", a.r.Method, a.r.URL.Path, status), fields...)
}
