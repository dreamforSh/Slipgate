package dataplane

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// turnSink receives one assistant turn as protocol-neutral events, in order. Implementations
// render them for a caller (streamSink), collect them into a unary result (resultCollector), or
// drop them (discardSink, used when the upstream bytes are forwarded verbatim).
type turnSink interface {
	start(u canonicalUsage)
	thinkingDelta(text string)
	thinkingSignature(sig string)
	redactedThinking(data string)
	textDelta(text string)
	toolStart(id, name string)
	toolArgsDelta(chunk string)
	toolEnd()
	finish(stop, stopSeq string, u canonicalUsage)
	fail(status int, errType, message string)
}

// turnRelay sits between an upstream decoder and a turnSink. It strips undeclared internal tools,
// keeps at most one tool open, records time-to-first-token and usage, and settles the final stop
// reason, so every decoder and sink stays simple.
type turnRelay struct {
	sink          turnSink
	cleanseMode   string
	stripTools    bool
	declared      map[string]bool
	onVisibleTool func()
	startedAt     time.Time
	estimatedIn   uint64

	started      bool
	usage        canonicalUsage
	stop         string
	stopSeq      string
	ttftMs       uint32
	emitted      int
	toolOpen     bool
	toolHidden   bool
	visibleTools int
	toolSeq      int
	failed       bool
	failStatus   int
}

func newTurnRelay(sink turnSink, turn *CanonicalTurn, cleanseMode string, stripTools bool, startedAt time.Time, onVisibleTool func()) *turnRelay {
	return &turnRelay{
		sink:          sink,
		cleanseMode:   cleanseMode,
		stripTools:    stripTools,
		declared:      turn.CallerDeclaredTools,
		onVisibleTool: onVisibleTool,
		startedAt:     startedAt,
		estimatedIn:   turn.EstimatedInputTokens,
	}
}

func (r *turnRelay) markFirstByte() {
	if r.ttftMs == 0 {
		r.ttftMs = elapsedMs(r.startedAt)
	}
}

func (r *turnRelay) ensureStarted() {
	if !r.started {
		r.started = true
		r.sink.start(r.finalUsage(false))
	}
}

// finalUsage fills in estimates for whatever upstream never reported.
func (r *turnRelay) finalUsage(final bool) canonicalUsage {
	u := r.usage
	if !u.InputSeen {
		u.InputTokens = r.estimatedIn
	}
	if final && !u.OutputSeen && r.emitted > 0 {
		u.OutputTokens = uint64(max(1, (r.emitted+3)/4))
	}
	return u
}

// Usage merges an upstream usage report.
func (r *turnRelay) Usage(u canonicalUsage) { r.usage.merge(u) }

// Stop records the upstream stop reason (canonical) and matched stop sequence.
func (r *turnRelay) Stop(reason, seq string) {
	if reason != "" {
		r.stop = reason
	}
	if seq != "" {
		r.stopSeq = seq
	}
}

func (r *turnRelay) Thinking(text string) {
	if text == "" || r.failed {
		return
	}
	r.closeTool()
	r.markFirstByte()
	r.ensureStarted()
	r.emitted += len(text)
	r.sink.thinkingDelta(text)
}

func (r *turnRelay) ThinkingSignature(sig string) {
	if sig == "" || r.failed {
		return
	}
	r.closeTool()
	r.ensureStarted()
	r.sink.thinkingSignature(sig)
}

func (r *turnRelay) RedactedThinking(data string) {
	if data == "" || r.failed {
		return
	}
	r.closeTool()
	r.markFirstByte()
	r.ensureStarted()
	r.sink.redactedThinking(data)
}

func (r *turnRelay) Text(text string) {
	if text == "" || r.failed {
		return
	}
	r.closeTool()
	r.markFirstByte()
	r.ensureStarted()
	r.emitted += len(text)
	r.sink.textDelta(text)
}

func (r *turnRelay) ToolStart(id, name string) {
	if r.failed {
		return
	}
	r.closeTool()
	r.toolOpen = true
	r.toolHidden = strings.TrimSpace(name) == "" ||
		(r.stripTools && ShouldStripInternalTool(r.cleanseMode, name, r.declared))
	if r.toolHidden {
		return
	}
	r.toolSeq++
	if id == "" {
		id = fmt.Sprintf("call_sg_%d", r.toolSeq)
	}
	r.visibleTools++
	if r.onVisibleTool != nil {
		r.onVisibleTool()
	}
	r.markFirstByte()
	r.ensureStarted()
	r.sink.toolStart(id, name)
}

func (r *turnRelay) ToolArgs(chunk string) {
	if !r.toolOpen || r.toolHidden || chunk == "" || r.failed {
		return
	}
	r.emitted += len(chunk)
	r.sink.toolArgsDelta(chunk)
}

func (r *turnRelay) ToolEnd() { r.closeTool() }

func (r *turnRelay) closeTool() {
	if !r.toolOpen {
		return
	}
	r.toolOpen = false
	if !r.toolHidden && !r.failed {
		r.sink.toolEnd()
	}
}

// Fail ends the turn with an upstream error. Sinks that have not written anything yet answer with
// a real HTTP error status, so SDK retry logic still works.
func (r *turnRelay) Fail(status int, errType, message string) {
	if r.failed {
		return
	}
	r.toolOpen = false
	r.failed = true
	if status < 400 {
		status = http.StatusBadGateway
	}
	r.failStatus = status
	r.sink.fail(status, errType, message)
}

// Finish closes the turn with its settled stop reason and usage. It is a no-op after Fail.
func (r *turnRelay) Finish() {
	if r.failed {
		return
	}
	r.closeTool()
	stop := r.stop
	switch {
	case stop == stopLength || stop == stopFilter || stop == stopRefusal:
	case r.visibleTools > 0:
		stop = stopTool
	case stop == "" || stop == stopTool:
		// Either upstream gave no reason, or every tool call it made was stripped.
		stop = stopEnd
	}
	r.markFirstByte()
	r.ensureStarted()
	r.sink.finish(stop, r.stopSeq, r.finalUsage(true))
}

// metrics folds the relay's accounting into base. A turn that failed before producing any output
// reports no tokens, so the hold is released instead of billed.
func (r *turnRelay) metrics(base RelayMetrics) RelayMetrics {
	u := r.finalUsage(true)
	if r.failed {
		base.UpstreamStatus = r.failStatus
		if r.emitted == 0 {
			u = canonicalUsage{}
		}
	}
	base.InputTokens = u.InputTokens
	base.OutputTokens = u.OutputTokens
	base.CacheReadTokens = u.CacheReadTokens
	base.CacheWriteTokens = u.CacheWriteTokens
	base.TTFTMs = r.ttftMs
	if base.TTFTMs == 0 {
		base.TTFTMs = elapsedMs(r.startedAt)
	}
	return base
}

// RelayAndTranscodeResponse reads upstream resp, strips undeclared CLI tools, transcodes unary or SSE streams into turn.IngressCodec, and returns RelayMetrics.
func RelayAndTranscodeResponse(
	w http.ResponseWriter,
	resp *http.Response,
	egress CodecKind,
	turn *CanonicalTurn,
	publicModel string,
	cleanseMode string,
	startedAt time.Time,
	onVisibleToolDelta func(),
) (RelayMetrics, error) {
	metrics := RelayMetrics{
		UpstreamStatus: resp.StatusCode,
		EgressCodec:    egress,
	}
	metrics.Window5hUsedBps, metrics.Window7dUsedBps = extractQuotaWatermarks(resp.Header)

	if turn.NativePassthrough {
		return relayNativePassthrough(w, resp, egress, turn, publicModel, startedAt, onVisibleToolDelta, metrics)
	}

	if resp.StatusCode >= 400 {
		rawErr, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
		copyRetryHeaders(w.Header(), resp.Header)
		errType, errCode, message := extractUpstreamError(rawErr, resp.Status)
		metrics.ErrorType = errType
		metrics.ErrorCode = errCode
		metrics.ErrorMessage = message
		metrics.ErrorBody = truncateUTF8(string(rawErr), requestErrorMaxBodyLen)
		WriteProtocolError(w, turn.IngressCodec, resp.StatusCode, firstNonEmpty(errType, "upstream_error"),
			firstNonEmpty(errCode, "upstream_http_"+strconv.Itoa(resp.StatusCode)), message)
		return metrics, nil
	}

	if turn.IngressCodec == CodecAnthropicCountTokens {
		rawBody, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
		if err != nil {
			return metrics, err
		}
		var cnt struct {
			InputTokens uint64 `json:"input_tokens"`
		}
		_ = json.Unmarshal(rawBody, &cnt)
		if cnt.InputTokens == 0 {
			cnt.InputTokens = turn.EstimatedInputTokens
		}
		metrics.InputTokens = cnt.InputTokens
		metrics.TTFTMs = elapsedMs(startedAt)
		writeJSONResponse(w, http.StatusOK, map[string]any{"input_tokens": cnt.InputTokens})
		return metrics, nil
	}

	var (
		sink      turnSink
		collector *resultCollector
	)
	if turn.Stream {
		sink = newStreamSink(w, turn, publicModel)
	} else {
		collector = newResultCollector()
		sink = collector
	}
	relay := newTurnRelay(sink, turn, cleanseMode, true, startedAt, onVisibleToolDelta)

	var runErr error
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		// Also covers upstreams that force SSE (e.g. the ChatGPT Codex backend) for unary callers.
		runErr = pumpSSE(resp.Body, newUpstreamDecoder(egress, relay))
		if runErr != nil {
			relay.Fail(http.StatusBadGateway, "api_error", "upstream stream interrupted: "+runErr.Error())
		}
	} else {
		rawBody, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
		if err == nil {
			var res canonicalResult
			if res, err = parseUnaryUpstream(egress, rawBody); err == nil {
				replayResult(relay, res)
			}
		}
		if err != nil {
			runErr = err
			relay.Fail(http.StatusBadGateway, "api_error", "unreadable upstream response: "+err.Error())
		}
	}
	relay.Finish()
	metrics = relay.metrics(metrics)

	if collector != nil {
		if collector.failed {
			WriteProtocolError(w, turn.IngressCodec, collector.failStatus, collector.failType, "upstream_error", collector.failMessage)
		} else {
			writeUnaryIngressResponse(w, turn, publicModel, collector.result())
		}
	}
	return metrics, runErr
}

// replayResult feeds a decoded unary turn through the relay as if it had been streamed.
func replayResult(r *turnRelay, res canonicalResult) {
	r.Usage(res.Usage)
	for _, th := range res.Thinking {
		if th.Redacted != "" {
			r.RedactedThinking(th.Redacted)
			continue
		}
		r.Thinking(th.Text)
		r.ThinkingSignature(th.Signature)
	}
	r.Text(res.Text)
	for _, tc := range res.ToolCalls {
		r.ToolStart(tc.ID, tc.Name)
		r.ToolArgs(defaultJSONObject(tc.Arguments))
		r.ToolEnd()
	}
	r.Stop(res.StopReason, res.StopSequence)
}

// ---------------------------------------------------------------------------------------------
// Upstream decoders: one per egress protocol, each turning SSE data payloads into relay events.

type upstreamDecoder interface {
	handle(data []byte)
}

func newUpstreamDecoder(egress CodecKind, r *turnRelay) upstreamDecoder {
	switch egress {
	case CodecAnthropicMessages:
		return &anthropicStreamDecoder{r: r, blocks: make(map[int]string)}
	case CodecOpenAIResponses:
		return &responsesStreamDecoder{r: r, items: make(map[string]*responsesToolItem)}
	case CodecGeminiGenerate, CodecAntigravityInternal:
		return &geminiStreamDecoder{r: r}
	default:
		return &chatStreamDecoder{r: r, tools: make(map[int]*chatToolState), current: -1}
	}
}

// pumpSSE feeds every data payload of an SSE body to dec.
func pumpSSE(body io.Reader, dec upstreamDecoder) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		dec.handle([]byte(data))
	}
	return scanner.Err()
}

// anthropicWireUsage keeps pointers so absent fields are told apart from zeros.
type anthropicWireUsage struct {
	InputTokens  *uint64 `json:"input_tokens"`
	OutputTokens *uint64 `json:"output_tokens"`
	CacheRead    *uint64 `json:"cache_read_input_tokens"`
	CacheWrite   *uint64 `json:"cache_creation_input_tokens"`
}

// applyTo overlays reported fields on cur. message_start reports input (zeros included);
// message_delta reports the final output and, on newer API versions, refreshed input counts.
func (w *anthropicWireUsage) applyTo(cur canonicalUsage, isDelta bool) canonicalUsage {
	if w == nil {
		return canonicalUsage{}
	}
	out := cur
	out.InputSeen, out.OutputSeen = false, false
	accept := func(v *uint64) bool { return v != nil && (!isDelta || *v > 0) }
	if accept(w.InputTokens) {
		out.InputTokens = *w.InputTokens
		out.InputSeen = true
	}
	if accept(w.CacheRead) {
		out.CacheReadTokens = *w.CacheRead
		out.InputSeen = true
	}
	if accept(w.CacheWrite) {
		out.CacheWriteTokens = *w.CacheWrite
		out.InputSeen = true
	}
	if isDelta && w.OutputTokens != nil {
		out.OutputTokens = *w.OutputTokens
		out.OutputSeen = true
	}
	return out
}

type anthropicStreamDecoder struct {
	r      *turnRelay
	blocks map[int]string
}

func (d *anthropicStreamDecoder) handle(data []byte) {
	var ev struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			Usage *anthropicWireUsage `json:"usage"`
		} `json:"message"`
		ContentBlock struct {
			Type     string          `json:"type"`
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			Data     string          `json:"data"`
			Input    json.RawMessage `json:"input"`
		} `json:"content_block"`
		Delta struct {
			Type         string  `json:"type"`
			Text         string  `json:"text"`
			PartialJSON  string  `json:"partial_json"`
			Thinking     string  `json:"thinking"`
			Signature    string  `json:"signature"`
			StopReason   string  `json:"stop_reason"`
			StopSequence *string `json:"stop_sequence"`
		} `json:"delta"`
		Usage *anthropicWireUsage `json:"usage"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &ev) != nil {
		return
	}
	switch ev.Type {
	case "message_start":
		d.r.Usage(ev.Message.Usage.applyTo(d.r.usage, false))
	case "content_block_start":
		cb := ev.ContentBlock
		switch cb.Type {
		case "text":
			d.blocks[ev.Index] = "text"
			d.r.Text(cb.Text)
		case "thinking":
			d.blocks[ev.Index] = "thinking"
			d.r.Thinking(cb.Thinking)
		case "redacted_thinking":
			d.blocks[ev.Index] = "redacted"
			d.r.RedactedThinking(cb.Data)
		case "tool_use":
			d.blocks[ev.Index] = "tool"
			d.r.ToolStart(cb.ID, cb.Name)
			if input := strings.TrimSpace(string(cb.Input)); input != "" && input != "{}" {
				d.r.ToolArgs(input)
			}
		default:
			d.blocks[ev.Index] = "other"
		}
	case "content_block_delta":
		switch ev.Delta.Type {
		case "text_delta":
			d.r.Text(ev.Delta.Text)
		case "thinking_delta":
			d.r.Thinking(ev.Delta.Thinking)
		case "signature_delta":
			d.r.ThinkingSignature(ev.Delta.Signature)
		case "input_json_delta":
			if d.blocks[ev.Index] == "tool" {
				d.r.ToolArgs(ev.Delta.PartialJSON)
			}
		}
	case "content_block_stop":
		if d.blocks[ev.Index] == "tool" {
			d.r.ToolEnd()
		}
	case "message_delta":
		seq := ""
		if ev.Delta.StopSequence != nil {
			seq = *ev.Delta.StopSequence
		}
		d.r.Stop(stopFromAnthropic(ev.Delta.StopReason), seq)
		d.r.Usage(ev.Usage.applyTo(d.r.usage, true))
	case "error":
		d.r.Fail(statusForAnthropicErrorType(ev.Error.Type), ev.Error.Type, ev.Error.Message)
	}
}

type openAIWireUsage struct {
	PromptTokens        uint64 `json:"prompt_tokens"`
	CompletionTokens    uint64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens uint64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens uint64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func (w *openAIWireUsage) canonical() canonicalUsage {
	var cached, reasoning uint64
	if w.PromptTokensDetails != nil {
		cached = w.PromptTokensDetails.CachedTokens
	}
	if w.CompletionTokensDetails != nil {
		reasoning = w.CompletionTokensDetails.ReasoningTokens
	}
	u := inputFromInclusivePrompt(w.PromptTokens, cached)
	u.OutputTokens = w.CompletionTokens
	u.ReasoningTokens = reasoning
	u.OutputSeen = true
	return u
}

type chatToolState struct {
	id      string
	name    string
	pending strings.Builder
	started bool
}

type chatStreamDecoder struct {
	r       *turnRelay
	tools   map[int]*chatToolState
	current int
}

type wireError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Status  string `json:"status"`
	Code    any    `json:"code"`
}

func (d *chatStreamDecoder) handle(data []byte) {
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content          string          `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
				Refusal          string          `json:"refusal"`
				ToolCalls        []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *openAIWireUsage `json:"usage"`
		Error *wireError       `json:"error"`
	}
	if json.Unmarshal(data, &chunk) != nil {
		return
	}
	if chunk.Error != nil {
		d.r.Fail(statusForWireError(chunk.Error), chunk.Error.Type, chunk.Error.Message)
		return
	}
	if chunk.Usage != nil {
		d.r.Usage(chunk.Usage.canonical())
	}
	if len(chunk.Choices) == 0 {
		return
	}
	ch := chunk.Choices[0]
	// DeepSeek, Kimi, GLM and Qwen stream reasoning as reasoning_content; OpenRouter/vLLM as reasoning.
	d.r.Thinking(firstNonEmpty(rawJSONString(ch.Delta.ReasoningContent), rawJSONString(ch.Delta.Reasoning)))
	d.r.Text(ch.Delta.Content)
	d.r.Text(ch.Delta.Refusal)
	for _, tc := range ch.Delta.ToolCalls {
		st := d.tools[tc.Index]
		if st == nil {
			st = &chatToolState{}
			d.tools[tc.Index] = st
		}
		if tc.ID != "" {
			st.id = tc.ID
		}
		if !st.started {
			if tc.Function.Name != "" {
				st.name = tc.Function.Name
			}
			st.pending.WriteString(tc.Function.Arguments)
			if st.name == "" {
				continue // hold argument bytes until the call is named
			}
			st.started = true
			d.current = tc.Index
			d.r.ToolStart(st.id, st.name)
			d.r.ToolArgs(st.pending.String())
			st.pending.Reset()
			continue
		}
		// Calls stream one after another; bytes for a call that is no longer open cannot be
		// re-opened in sequential protocols and are dropped.
		if tc.Index == d.current {
			d.r.ToolArgs(tc.Function.Arguments)
		}
	}
	if ch.FinishReason != "" {
		d.r.Stop(stopFromOpenAI(ch.FinishReason), "")
	}
}

type responsesWireUsage struct {
	InputTokens        uint64 `json:"input_tokens"`
	OutputTokens       uint64 `json:"output_tokens"`
	InputTokensDetails *struct {
		CachedTokens uint64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputTokensDetails *struct {
		ReasoningTokens uint64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (w *responsesWireUsage) canonical() canonicalUsage {
	var cached, reasoning uint64
	if w.InputTokensDetails != nil {
		cached = w.InputTokensDetails.CachedTokens
	}
	if w.OutputTokensDetails != nil {
		reasoning = w.OutputTokensDetails.ReasoningTokens
	}
	u := inputFromInclusivePrompt(w.InputTokens, cached)
	u.OutputTokens = w.OutputTokens
	u.ReasoningTokens = reasoning
	u.OutputSeen = true
	return u
}

type responsesToolItem struct {
	open    bool
	gotArgs bool
}

type responsesStreamDecoder struct {
	r       *turnRelay
	items   map[string]*responsesToolItem
	current string
}

func (d *responsesStreamDecoder) handle(data []byte) {
	var ev struct {
		Type   string `json:"type"`
		Delta  string `json:"delta"`
		ItemID string `json:"item_id"`
		Item   struct {
			ID        string `json:"id"`
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"item"`
		Response struct {
			Usage             *responsesWireUsage `json:"usage"`
			IncompleteDetails *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
			Error *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		} `json:"response"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &ev) != nil {
		return
	}
	switch ev.Type {
	case "response.output_text.delta", "response.refusal.delta":
		d.r.Text(ev.Delta)
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		d.r.Thinking(ev.Delta)
	case "response.output_item.added":
		if ev.Item.Type != "function_call" {
			return
		}
		key := firstNonEmpty(ev.Item.ID, ev.Item.CallID)
		item := &responsesToolItem{open: true}
		d.items[key] = item
		d.current = key
		d.r.ToolStart(ev.Item.CallID, ev.Item.Name)
		if ev.Item.Arguments != "" {
			d.r.ToolArgs(ev.Item.Arguments)
			item.gotArgs = true
		}
	case "response.function_call_arguments.delta":
		if item := d.items[ev.ItemID]; item != nil && item.open && d.current == ev.ItemID {
			d.r.ToolArgs(ev.Delta)
			item.gotArgs = true
		}
	case "response.output_item.done":
		if ev.Item.Type != "function_call" {
			return
		}
		key := firstNonEmpty(ev.Item.ID, ev.Item.CallID)
		item := d.items[key]
		if item == nil {
			// Upstreams that only emit completed items (no added/delta events).
			d.r.ToolStart(ev.Item.CallID, ev.Item.Name)
			d.r.ToolArgs(ev.Item.Arguments)
			d.r.ToolEnd()
			return
		}
		if item.open && d.current == key {
			if !item.gotArgs {
				d.r.ToolArgs(ev.Item.Arguments)
			}
			d.r.ToolEnd()
		}
		item.open = false
	case "response.completed":
		if ev.Response.Usage != nil {
			d.r.Usage(ev.Response.Usage.canonical())
		}
		d.r.Stop(stopEnd, "")
	case "response.incomplete":
		if ev.Response.Usage != nil {
			d.r.Usage(ev.Response.Usage.canonical())
		}
		reason := ""
		if ev.Response.IncompleteDetails != nil {
			reason = ev.Response.IncompleteDetails.Reason
		}
		d.r.Stop(stopFromResponsesIncomplete(reason), "")
	case "response.failed":
		code, msg := "api_error", "upstream response failed"
		if e := ev.Response.Error; e != nil {
			code, msg = firstNonEmpty(e.Code, code), firstNonEmpty(e.Message, msg)
		}
		d.r.Fail(statusForWireError(&wireError{Type: code}), code, msg)
	case "error":
		d.r.Fail(statusForWireError(&wireError{Type: ev.Code}), firstNonEmpty(ev.Code, "api_error"), ev.Message)
	}
}

type geminiWireUsage struct {
	PromptTokenCount        uint64 `json:"promptTokenCount"`
	CandidatesTokenCount    uint64 `json:"candidatesTokenCount"`
	CachedContentTokenCount uint64 `json:"cachedContentTokenCount"`
	ThoughtsTokenCount      uint64 `json:"thoughtsTokenCount"`
}

func (w *geminiWireUsage) canonical() canonicalUsage {
	u := inputFromInclusivePrompt(w.PromptTokenCount, w.CachedContentTokenCount)
	u.InputSeen = w.PromptTokenCount > 0
	if out := w.CandidatesTokenCount + w.ThoughtsTokenCount; out > 0 {
		u.OutputTokens = out
		u.ReasoningTokens = w.ThoughtsTokenCount
		u.OutputSeen = true
	}
	return u
}

type geminiStreamDecoder struct {
	r   *turnRelay
	seq int
}

func (d *geminiStreamDecoder) handle(data []byte) {
	var chunk struct {
		Candidates []struct {
			Content struct {
				Parts []geminiPart `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata *geminiWireUsage `json:"usageMetadata"`
		Error         *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if json.Unmarshal(unwrapAntigravityResponse(data), &chunk) != nil {
		return
	}
	if e := chunk.Error; e != nil {
		d.r.Fail(e.Code, strings.ToLower(e.Status), e.Message)
		return
	}
	if chunk.UsageMetadata != nil {
		d.r.Usage(chunk.UsageMetadata.canonical())
	}
	if len(chunk.Candidates) == 0 {
		return
	}
	cand := chunk.Candidates[0]
	for _, p := range cand.Content.Parts {
		switch {
		case p.FunctionCall != nil && p.FunctionCall.Name != "":
			d.seq++
			d.r.ToolStart(firstNonEmpty(p.FunctionCall.ID, fmt.Sprintf("call_gem_%d", d.seq)), p.FunctionCall.Name)
			d.r.ToolArgs(defaultJSONObject(string(p.FunctionCall.Args)))
			d.r.ToolEnd()
		case p.Thought:
			d.r.Thinking(p.Text)
		default:
			d.r.Text(p.Text)
		}
	}
	if cand.FinishReason != "" {
		d.r.Stop(stopFromGemini(cand.FinishReason), "")
	}
}

func statusForWireError(e *wireError) int {
	t := strings.ToLower(firstNonEmpty(e.Type, e.Status, fmt.Sprint(e.Code)))
	switch {
	case strings.Contains(t, "rate_limit"), strings.Contains(t, "resource_exhausted"), t == "429":
		return http.StatusTooManyRequests
	case strings.Contains(t, "overloaded"), strings.Contains(t, "unavailable"):
		return http.StatusServiceUnavailable
	case strings.Contains(t, "invalid"), strings.Contains(t, "bad_request"):
		return http.StatusBadRequest
	default:
		return http.StatusBadGateway
	}
}

// rawJSONString returns raw when it is a JSON string, and "" for objects, arrays or null.
func rawJSONString(raw json.RawMessage) string {
	var s string
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func unwrapAntigravityResponse(raw []byte) []byte {
	var wrapper struct {
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(raw, &wrapper) == nil && len(bytes.TrimSpace(wrapper.Response)) > 0 && !bytes.Equal(bytes.TrimSpace(wrapper.Response), []byte("null")) {
		return wrapper.Response
	}
	return raw
}

// ---------------------------------------------------------------------------------------------
// Unary upstream decoding.

func parseUnaryUpstream(egress CodecKind, raw []byte) (canonicalResult, error) {
	res := canonicalResult{ID: fmt.Sprintf("sg%d", time.Now().UnixNano())}

	switch egress {
	case CodecAnthropicMessages:
		var ant struct {
			ID           string           `json:"id"`
			StopReason   string           `json:"stop_reason"`
			StopSequence string           `json:"stop_sequence"`
			Content      []anthropicBlock `json:"content"`
			Usage        *struct {
				InputTokens              uint64 `json:"input_tokens"`
				OutputTokens             uint64 `json:"output_tokens"`
				CacheReadInputTokens     uint64 `json:"cache_read_input_tokens"`
				CacheCreationInputTokens uint64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &ant); err != nil {
			return res, fmt.Errorf("decode Anthropic response: %w", err)
		}
		res.ID = firstNonEmpty(ant.ID, res.ID)
		res.StopReason = stopFromAnthropic(ant.StopReason)
		res.StopSequence = ant.StopSequence
		var texts []string
		for _, b := range ant.Content {
			switch b.Type {
			case "text":
				texts = append(texts, b.Text)
			case "thinking":
				res.Thinking = append(res.Thinking, CanonicalThinking{Text: b.Thinking, Signature: b.Signature})
			case "redacted_thinking":
				res.Thinking = append(res.Thinking, CanonicalThinking{Redacted: b.Data})
			case "tool_use":
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{ID: b.ID, Name: b.Name, Arguments: defaultJSONObject(string(b.Input))})
			}
		}
		res.Text = strings.Join(texts, "")
		if u := ant.Usage; u != nil {
			res.Usage = canonicalUsage{
				InputTokens:      u.InputTokens,
				OutputTokens:     u.OutputTokens,
				CacheReadTokens:  u.CacheReadInputTokens,
				CacheWriteTokens: u.CacheCreationInputTokens,
				InputSeen:        true,
				OutputSeen:       true,
			}
		}

	case CodecOpenAIResponses:
		var respObj struct {
			ID                string `json:"id"`
			Status            string `json:"status"`
			OutputText        string `json:"output_text"`
			IncompleteDetails *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
			Output []struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
				Content   []struct {
					Type    string `json:"type"`
					Text    string `json:"text"`
					Refusal string `json:"refusal"`
				} `json:"content"`
				Summary []struct {
					Text string `json:"text"`
				} `json:"summary"`
			} `json:"output"`
			Usage *responsesWireUsage `json:"usage"`
		}
		if err := json.Unmarshal(raw, &respObj); err != nil {
			return res, fmt.Errorf("decode OpenAI Responses payload: %w", err)
		}
		res.ID = firstNonEmpty(respObj.ID, res.ID)
		var texts []string
		for _, item := range respObj.Output {
			switch item.Type {
			case "message":
				for _, c := range item.Content {
					texts = append(texts, firstNonEmpty(c.Text, c.Refusal))
				}
			case "function_call":
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{ID: item.CallID, Name: item.Name, Arguments: defaultJSONObject(item.Arguments)})
			case "reasoning":
				for _, s := range item.Summary {
					if s.Text != "" {
						res.Thinking = append(res.Thinking, CanonicalThinking{Text: s.Text})
					}
				}
			}
		}
		res.Text = strings.Join(texts, "")
		if res.Text == "" {
			res.Text = respObj.OutputText
		}
		res.StopReason = stopEnd
		if respObj.Status == "incomplete" {
			reason := ""
			if respObj.IncompleteDetails != nil {
				reason = respObj.IncompleteDetails.Reason
			}
			res.StopReason = stopFromResponsesIncomplete(reason)
		}
		if respObj.Usage != nil {
			res.Usage = respObj.Usage.canonical()
		}

	case CodecGeminiGenerate, CodecAntigravityInternal:
		var gem struct {
			Candidates []struct {
				FinishReason string `json:"finishReason"`
				Content      struct {
					Parts []geminiPart `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
			UsageMetadata *geminiWireUsage `json:"usageMetadata"`
		}
		if err := json.Unmarshal(unwrapAntigravityResponse(raw), &gem); err != nil {
			return res, fmt.Errorf("decode Gemini/Antigravity response: %w", err)
		}
		if len(gem.Candidates) > 0 {
			cand := gem.Candidates[0]
			res.StopReason = stopFromGemini(cand.FinishReason)
			var texts []string
			for idx, p := range cand.Content.Parts {
				switch {
				case p.FunctionCall != nil && p.FunctionCall.Name != "":
					res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
						ID:        firstNonEmpty(p.FunctionCall.ID, fmt.Sprintf("call_gem_%d", idx+1)),
						Name:      p.FunctionCall.Name,
						Arguments: defaultJSONObject(string(p.FunctionCall.Args)),
					})
				case p.Thought && p.Text != "":
					res.Thinking = append(res.Thinking, CanonicalThinking{Text: p.Text})
				default:
					texts = append(texts, p.Text)
				}
			}
			res.Text = strings.Join(texts, "")
		}
		if gem.UsageMetadata != nil {
			res.Usage = gem.UsageMetadata.canonical()
		}

	default:
		var oa struct {
			ID      string `json:"id"`
			Choices []struct {
				FinishReason string `json:"finish_reason"`
				Message      struct {
					Content          json.RawMessage `json:"content"`
					ReasoningContent json.RawMessage `json:"reasoning_content"`
					Reasoning        json.RawMessage `json:"reasoning"`
					Refusal          string          `json:"refusal"`
					ToolCalls        []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"message"`
			} `json:"choices"`
			Usage *openAIWireUsage `json:"usage"`
		}
		if err := json.Unmarshal(raw, &oa); err != nil {
			return res, fmt.Errorf("decode OpenAI response: %w", err)
		}
		res.ID = firstNonEmpty(oa.ID, res.ID)
		if len(oa.Choices) > 0 {
			ch := oa.Choices[0]
			text, _ := parseContentBlocks(ch.Message.Content)
			res.Text = firstNonEmpty(text, ch.Message.Refusal)
			if reasoning := firstNonEmpty(rawJSONString(ch.Message.ReasoningContent), rawJSONString(ch.Message.Reasoning)); reasoning != "" {
				res.Thinking = append(res.Thinking, CanonicalThinking{Text: reasoning})
			}
			res.StopReason = stopFromOpenAI(ch.FinishReason)
			for _, tc := range ch.Message.ToolCalls {
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: defaultJSONObject(tc.Function.Arguments)})
			}
		}
		if oa.Usage != nil {
			res.Usage = oa.Usage.canonical()
		}
	}
	return res, nil
}

// ---------------------------------------------------------------------------------------------
// resultCollector assembles relay events into a unary canonicalResult.

type resultCollector struct {
	res         canonicalResult
	text        strings.Builder
	openThought int
	tool        *CanonicalToolCall
	args        strings.Builder

	failed      bool
	failStatus  int
	failType    string
	failMessage string
}

func newResultCollector() *resultCollector {
	return &resultCollector{
		res:         canonicalResult{ID: fmt.Sprintf("sg%d", time.Now().UnixNano())},
		openThought: -1,
	}
}

func (c *resultCollector) start(canonicalUsage) {}

func (c *resultCollector) thinkingDelta(text string) {
	if c.openThought < 0 {
		c.res.Thinking = append(c.res.Thinking, CanonicalThinking{})
		c.openThought = len(c.res.Thinking) - 1
	}
	c.res.Thinking[c.openThought].Text += text
}

func (c *resultCollector) thinkingSignature(sig string) {
	if c.openThought < 0 {
		c.res.Thinking = append(c.res.Thinking, CanonicalThinking{})
		c.openThought = len(c.res.Thinking) - 1
	}
	c.res.Thinking[c.openThought].Signature = sig
	c.openThought = -1
}

func (c *resultCollector) redactedThinking(data string) {
	c.openThought = -1
	c.res.Thinking = append(c.res.Thinking, CanonicalThinking{Redacted: data})
}

func (c *resultCollector) textDelta(text string) {
	c.openThought = -1
	c.text.WriteString(text)
}

func (c *resultCollector) toolStart(id, name string) {
	c.openThought = -1
	c.tool = &CanonicalToolCall{ID: id, Name: name}
	c.args.Reset()
}

func (c *resultCollector) toolArgsDelta(chunk string) { c.args.WriteString(chunk) }

func (c *resultCollector) toolEnd() {
	if c.tool == nil {
		return
	}
	c.tool.Arguments = defaultJSONObject(c.args.String())
	c.res.ToolCalls = append(c.res.ToolCalls, *c.tool)
	c.tool = nil
}

func (c *resultCollector) finish(stop, stopSeq string, u canonicalUsage) {
	c.res.StopReason = stop
	c.res.StopSequence = stopSeq
	c.res.Usage = u
}

func (c *resultCollector) fail(status int, errType, message string) {
	c.failed = true
	c.failStatus = status
	c.failType = errType
	c.failMessage = message
}

func (c *resultCollector) result() canonicalResult {
	c.res.Text = c.text.String()
	return c.res
}

// discardSink drops every event; the passthrough relay only needs the accounting.
type discardSink struct{}

func (discardSink) start(canonicalUsage)                  {}
func (discardSink) thinkingDelta(string)                  {}
func (discardSink) thinkingSignature(string)              {}
func (discardSink) redactedThinking(string)               {}
func (discardSink) textDelta(string)                      {}
func (discardSink) toolStart(string, string)              {}
func (discardSink) toolArgsDelta(string)                  {}
func (discardSink) toolEnd()                              {}
func (discardSink) finish(string, string, canonicalUsage) {}
func (discardSink) fail(int, string, string)              {}

// ---------------------------------------------------------------------------------------------
// Unary responses in the caller's protocol.

func writeUnaryIngressResponse(w http.ResponseWriter, turn *CanonicalTurn, publicModel string, res canonicalResult) {
	thinkingText := joinThinkingText(res.Thinking)
	switch turn.IngressCodec {
	case CodecAnthropicMessages:
		content := make([]map[string]any, 0, len(res.Thinking)+1+len(res.ToolCalls))
		for _, th := range res.Thinking {
			if th.Redacted != "" {
				content = append(content, map[string]any{"type": "redacted_thinking", "data": th.Redacted})
			} else if th.Text != "" || th.Signature != "" {
				content = append(content, map[string]any{"type": "thinking", "thinking": th.Text, "signature": th.Signature})
			}
		}
		if res.Text != "" || len(res.ToolCalls) == 0 {
			content = append(content, map[string]any{"type": "text", "text": res.Text})
		}
		for _, tc := range res.ToolCalls {
			content = append(content, map[string]any{
				"type":  "tool_use",
				"id":    tc.ID,
				"name":  tc.Name,
				"input": jsonObjectValue(tc.Arguments),
			})
		}
		var stopSeq any
		if res.StopSequence != "" {
			stopSeq = res.StopSequence
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":            ensurePrefix(res.ID, "msg_"),
			"type":          "message",
			"role":          "assistant",
			"model":         publicModel,
			"content":       content,
			"stop_reason":   anthropicStopReason(res.StopReason),
			"stop_sequence": stopSeq,
			"usage":         anthropicUsageJSON(res.Usage),
		})

	case CodecOpenAIResponses:
		output := make([]map[string]any, 0, 2+len(res.ToolCalls))
		if thinkingText != "" {
			output = append(output, map[string]any{
				"id":      "rs_" + res.ID,
				"type":    "reasoning",
				"summary": []map[string]any{{"type": "summary_text", "text": thinkingText}},
			})
		}
		if res.Text != "" || len(res.ToolCalls) == 0 {
			output = append(output, responsesMessageItem("msg_"+res.ID, res.Text))
		}
		for i, tc := range res.ToolCalls {
			output = append(output, responsesFunctionCallItem(fmt.Sprintf("fc_%s_%d", res.ID, i), tc.ID, tc.Name, defaultJSONObject(tc.Arguments)))
		}
		status, incomplete := responsesStatus(res.StopReason)
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":                 ensurePrefix(res.ID, "resp_"),
			"object":             "response",
			"created_at":         time.Now().Unix(),
			"status":             status,
			"incomplete_details": incomplete,
			"model":              publicModel,
			"output":             output,
			"output_text":        res.Text,
			"usage":              responsesUsageJSON(res.Usage),
		})

	case CodecGeminiGenerate:
		var parts []map[string]any
		if thinkingText != "" {
			parts = append(parts, map[string]any{"text": thinkingText, "thought": true})
		}
		if res.Text != "" || len(res.ToolCalls) == 0 {
			parts = append(parts, map[string]any{"text": res.Text})
		}
		for _, tc := range res.ToolCalls {
			parts = append(parts, map[string]any{
				"functionCall": map[string]any{"name": tc.Name, "args": jsonObjectValue(tc.Arguments)},
			})
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"candidates": []map[string]any{{
				"index":        0,
				"content":      map[string]any{"role": "model", "parts": parts},
				"finishReason": geminiFinishReason(res.StopReason),
			}},
			"usageMetadata": geminiUsageJSON(res.Usage),
			"modelVersion":  publicModel,
		})

	case CodecMCPJSONRPC:
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      turn.MCPID,
			"result": map[string]any{
				"model":   publicModel,
				"content": []map[string]any{{"type": "text", "text": res.Text}},
				"isError": false,
			},
		})

	default:
		msg := map[string]any{"role": "assistant", "content": res.Text}
		if thinkingText != "" {
			msg["reasoning_content"] = thinkingText
		}
		if len(res.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(res.ToolCalls))
			for _, tc := range res.ToolCalls {
				calls = append(calls, map[string]any{
					"id":       tc.ID,
					"type":     "function",
					"function": map[string]any{"name": tc.Name, "arguments": defaultJSONObject(tc.Arguments)},
				})
			}
			msg["tool_calls"] = calls
			if res.Text == "" {
				msg["content"] = nil
			}
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":      ensurePrefix(res.ID, "chatcmpl-"),
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   publicModel,
			"choices": []map[string]any{{"index": 0, "message": msg, "finish_reason": openAIFinishReason(res.StopReason)}},
			"usage":   openAIChatUsageJSON(res.Usage),
		})
	}
}

func joinThinkingText(blocks []CanonicalThinking) string {
	var parts []string
	for _, th := range blocks {
		if th.Text != "" {
			parts = append(parts, th.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// jsonObjectValue decodes tool arguments for protocols that embed them as a JSON object.
func jsonObjectValue(args string) any {
	var v any = map[string]any{}
	_ = json.Unmarshal([]byte(defaultJSONObject(args)), &v)
	return v
}

func responsesStatus(stop string) (string, any) {
	switch stop {
	case stopLength:
		return "incomplete", map[string]any{"reason": "max_output_tokens"}
	case stopFilter, stopRefusal:
		return "incomplete", map[string]any{"reason": "content_filter"}
	default:
		return "completed", nil
	}
}

func responsesMessageItem(id, text string) map[string]any {
	return map[string]any{
		"id":      id,
		"type":    "message",
		"status":  "completed",
		"role":    "assistant",
		"content": []map[string]any{{"type": "output_text", "text": text, "annotations": []any{}}},
	}
}

func responsesFunctionCallItem(id, callID, name, args string) map[string]any {
	return map[string]any{
		"id":        id,
		"type":      "function_call",
		"status":    "completed",
		"call_id":   callID,
		"name":      name,
		"arguments": args,
	}
}

// ---------------------------------------------------------------------------------------------
// Upstream error helpers.

// extractUpstreamError pulls type, code and message out of an OpenAI, Anthropic or Gemini error body.
func extractUpstreamError(raw []byte, fallback string) (errType, code, message string) {
	message = extractErrorMessage(raw, fallback)
	var parsed struct {
		Type  string          `json:"type"`
		Code  any             `json:"code"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return "", "", message
	}
	var inner wireError
	if json.Unmarshal(parsed.Error, &inner) == nil {
		errType = firstNonEmpty(inner.Type, strings.ToLower(inner.Status))
		code = codeString(inner.Code)
	}
	if errType == "" && parsed.Type != "error" {
		errType = parsed.Type
	}
	if code == "" {
		code = codeString(parsed.Code)
	}
	return errType, code, message
}

func codeString(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case float64:
		return strconv.FormatFloat(c, 'f', -1, 64)
	default:
		return ""
	}
}

// copyRetryHeaders forwards the upstream retry hints that OpenAI and Anthropic SDKs honour.
func copyRetryHeaders(dst, src http.Header) {
	for _, k := range []string{"Retry-After", "Retry-After-Ms", "X-Should-Retry"} {
		if v := src.Get(k); v != "" {
			dst.Set(k, v)
		}
	}
}

// setRetryAfter publishes a retry delay in both the standard and the millisecond form.
func setRetryAfter(h http.Header, ms uint64) {
	if ms == 0 {
		return
	}
	h.Set("Retry-After", strconv.FormatUint((ms+999)/1000, 10))
	h.Set("Retry-After-Ms", strconv.FormatUint(ms, 10))
}
