package dataplane

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// UpstreamTimeouts bounds the two waits an upstream can hang a turn on. There is deliberately no
// deadline for the whole response: a long SSE stream is normal, a silent upstream is not.
type UpstreamTimeouts struct {
	// Header is the longest wait from sending the request to the response headers (0 = none).
	Header time.Duration
	// Idle is the longest single wait for more response body (0 = none). Time the caller spends
	// between reads, e.g. writing to a slow client, does not count.
	Idle time.Duration
}

var (
	errUpstreamHeaderTimeout = errors.New("upstream sent no response headers in time")
	errUpstreamIdleTimeout   = errors.New("upstream stream stalled")
)

// do sends req through send under the header deadline and arms the idle deadline on the body.
func (t UpstreamTimeouts) do(req *http.Request, send func(*http.Request) (*http.Response, error)) (*http.Response, error) {
	if t.Header <= 0 && t.Idle <= 0 {
		return send(req)
	}
	ctx, cancel := context.WithCancelCause(req.Context())
	var headerTimer *time.Timer
	if t.Header > 0 {
		headerTimer = time.AfterFunc(t.Header, func() { cancel(errUpstreamHeaderTimeout) })
	}
	resp, err := send(req.WithContext(ctx))
	if headerTimer != nil && !headerTimer.Stop() && err == nil {
		// The deadline fired as the headers arrived: the context is already cancelled.
		_ = resp.Body.Close()
		resp, err = nil, context.Cause(ctx)
	}
	if err != nil {
		cause := context.Cause(ctx)
		cancel(nil)
		if errors.Is(cause, errUpstreamHeaderTimeout) {
			return nil, fmt.Errorf("%w (%s): %v", errUpstreamHeaderTimeout, t.Header, err)
		}
		return nil, err
	}
	if resp.Body == nil {
		cancel(nil)
		return resp, nil
	}
	body := &deadlineBody{ReadCloser: resp.Body, idle: t.Idle, ctx: ctx, cancel: cancel}
	if t.Idle > 0 {
		body.timer = time.AfterFunc(t.Idle, func() { cancel(errUpstreamIdleTimeout) })
		body.timer.Stop()
	}
	resp.Body = body
	return resp, nil
}

// deadlineBody owns the request context: it cancels it on Close and when one read waits longer
// than idle.
type deadlineBody struct {
	io.ReadCloser
	idle   time.Duration
	timer  *time.Timer
	ctx    context.Context
	cancel context.CancelCauseFunc
}

func (b *deadlineBody) Read(p []byte) (int, error) {
	if b.timer == nil {
		return b.ReadCloser.Read(p)
	}
	b.timer.Reset(b.idle)
	n, err := b.ReadCloser.Read(p)
	b.timer.Stop()
	if err != nil && !errors.Is(err, io.EOF) && errors.Is(context.Cause(b.ctx), errUpstreamIdleTimeout) {
		err = fmt.Errorf("%w: no data for %s: %v", errUpstreamIdleTimeout, b.idle, err)
	}
	return n, err
}

func (b *deadlineBody) Close() error {
	if b.timer != nil {
		b.timer.Stop()
	}
	err := b.ReadCloser.Close()
	b.cancel(nil)
	return err
}
