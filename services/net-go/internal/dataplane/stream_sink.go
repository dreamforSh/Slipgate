package dataplane

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// streamSink renders relay events as the caller's own SSE dialect, following the event sequences
// the official OpenAI and Anthropic SDK stream helpers rebuild messages from. Headers are written
// lazily so an upstream failure before any output still becomes a real HTTP error status.
type streamSink struct {
	w            http.ResponseWriter
	flusher      http.Flusher
	ingress      CodecKind
	model        string
	id           string
	created      int64
	includeUsage bool
	sent         bool

	// Anthropic Messages
	blockIndex int
	blockOpen  string

	// OpenAI Chat
	nextToolIndex int

	// OpenAI Responses
	seq         int
	outputIndex int
	output      []map[string]any
	msg         *responsesOpenItem
	reasoning   *responsesOpenItem
	call        *responsesOpenItem

	// Gemini
	gemTool *responsesOpenItem
}

// responsesOpenItem tracks an output item that is still streaming.
type responsesOpenItem struct {
	id          string
	outputIndex int
	callID      string
	name        string
	text        strings.Builder
}

func newStreamSink(w http.ResponseWriter, turn *CanonicalTurn, model string) *streamSink {
	flusher, _ := w.(http.Flusher)
	now := time.Now()
	return &streamSink{
		w:            w,
		flusher:      flusher,
		ingress:      turn.IngressCodec,
		model:        model,
		id:           "sg" + strconv.FormatInt(now.UnixNano(), 36),
		created:      now.Unix(),
		includeUsage: turn.IncludeUsage,
	}
}

func (s *streamSink) sendHeaders() {
	if s.sent {
		return
	}
	s.sent = true
	h := s.w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	s.w.WriteHeader(http.StatusOK)
}

func (s *streamSink) flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

func (s *streamSink) start(u canonicalUsage) {
	s.sendHeaders()
	switch s.ingress {
	case CodecAnthropicMessages:
		writeSSEEvent(s.w, "message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id":            "msg_" + s.id,
				"type":          "message",
				"role":          "assistant",
				"model":         s.model,
				"content":       []any{},
				"stop_reason":   nil,
				"stop_sequence": nil,
				"usage": map[string]any{
					"input_tokens":                u.InputTokens,
					"output_tokens":               1,
					"cache_read_input_tokens":     u.CacheReadTokens,
					"cache_creation_input_tokens": u.CacheWriteTokens,
				},
			},
		})
		writeSSEEvent(s.w, "ping", map[string]any{"type": "ping"})
	case CodecOpenAIResponses:
		s.responsesEvent("response.created", map[string]any{"response": s.responseObject("in_progress", nil, nil)})
		s.responsesEvent("response.in_progress", map[string]any{"response": s.responseObject("in_progress", nil, nil)})
	case CodecGeminiGenerate:
		// Gemini has no stream preamble.
	default:
		s.chatChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
	}
	s.flush()
}

func (s *streamSink) thinkingDelta(text string) {
	switch s.ingress {
	case CodecAnthropicMessages:
		s.anthropicOpenBlock("thinking", map[string]any{"type": "thinking", "thinking": "", "signature": ""})
		s.anthropicDelta(map[string]any{"type": "thinking_delta", "thinking": text})
	case CodecOpenAIResponses:
		s.responsesReasoningDelta(text)
	case CodecGeminiGenerate:
		s.geminiParts([]map[string]any{{"text": text, "thought": true}}, nil)
	default:
		s.chatChunk(map[string]any{"reasoning_content": text}, nil, nil)
	}
	s.flush()
}

func (s *streamSink) thinkingSignature(sig string) {
	if s.ingress != CodecAnthropicMessages {
		return // only Anthropic clients can replay signed thinking
	}
	s.anthropicOpenBlock("thinking", map[string]any{"type": "thinking", "thinking": "", "signature": ""})
	s.anthropicDelta(map[string]any{"type": "signature_delta", "signature": sig})
	s.flush()
}

func (s *streamSink) redactedThinking(data string) {
	if s.ingress != CodecAnthropicMessages {
		return
	}
	s.anthropicCloseBlock()
	writeSSEEvent(s.w, "content_block_start", map[string]any{
		"type":          "content_block_start",
		"index":         s.blockIndex,
		"content_block": map[string]any{"type": "redacted_thinking", "data": data},
	})
	s.blockOpen = "redacted"
	s.anthropicCloseBlock()
	s.flush()
}

func (s *streamSink) textDelta(text string) {
	switch s.ingress {
	case CodecAnthropicMessages:
		s.anthropicOpenBlock("text", map[string]any{"type": "text", "text": ""})
		s.anthropicDelta(map[string]any{"type": "text_delta", "text": text})
	case CodecOpenAIResponses:
		s.responsesTextDelta(text)
	case CodecGeminiGenerate:
		s.geminiParts([]map[string]any{{"text": text}}, nil)
	default:
		s.chatChunk(map[string]any{"content": text}, nil, nil)
	}
	s.flush()
}

func (s *streamSink) toolStart(id, name string) {
	switch s.ingress {
	case CodecAnthropicMessages:
		s.anthropicCloseBlock()
		writeSSEEvent(s.w, "content_block_start", map[string]any{
			"type":          "content_block_start",
			"index":         s.blockIndex,
			"content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": map[string]any{}},
		})
		s.blockOpen = "tool"
	case CodecOpenAIResponses:
		s.responsesCloseMessage()
		s.responsesCloseReasoning()
		s.call = &responsesOpenItem{
			id:          fmt.Sprintf("fc_%s_%d", s.id, s.outputIndex),
			outputIndex: s.outputIndex,
			callID:      id,
			name:        name,
		}
		s.outputIndex++
		s.responsesEvent("response.output_item.added", map[string]any{
			"output_index": s.call.outputIndex,
			"item": map[string]any{
				"id": s.call.id, "type": "function_call", "status": "in_progress",
				"call_id": id, "name": name, "arguments": "",
			},
		})
	case CodecGeminiGenerate:
		s.gemTool = &responsesOpenItem{callID: id, name: name}
	default:
		idx := s.nextToolIndex
		s.nextToolIndex++
		s.chatChunk(map[string]any{"tool_calls": []map[string]any{{
			"index":    idx,
			"id":       id,
			"type":     "function",
			"function": map[string]any{"name": name, "arguments": ""},
		}}}, nil, nil)
	}
	s.flush()
}

func (s *streamSink) toolArgsDelta(chunk string) {
	switch s.ingress {
	case CodecAnthropicMessages:
		if s.blockOpen == "tool" {
			s.anthropicDelta(map[string]any{"type": "input_json_delta", "partial_json": chunk})
		}
	case CodecOpenAIResponses:
		if s.call != nil {
			s.call.text.WriteString(chunk)
			s.responsesEvent("response.function_call_arguments.delta", map[string]any{
				"item_id": s.call.id, "output_index": s.call.outputIndex, "delta": chunk,
			})
		}
	case CodecGeminiGenerate:
		if s.gemTool != nil {
			s.gemTool.text.WriteString(chunk)
		}
		return // Gemini sends whole function calls; nothing to flush yet
	default:
		s.chatChunk(map[string]any{"tool_calls": []map[string]any{{
			"index":    s.nextToolIndex - 1,
			"function": map[string]any{"arguments": chunk},
		}}}, nil, nil)
	}
	s.flush()
}

func (s *streamSink) toolEnd() {
	switch s.ingress {
	case CodecAnthropicMessages:
		if s.blockOpen == "tool" {
			s.anthropicCloseBlock()
		}
	case CodecOpenAIResponses:
		s.responsesCloseCall()
	case CodecGeminiGenerate:
		if t := s.gemTool; t != nil {
			s.gemTool = nil
			s.geminiParts([]map[string]any{{
				"functionCall": map[string]any{"name": t.name, "args": jsonObjectValue(t.text.String())},
			}}, nil)
		}
	default:
		return
	}
	s.flush()
}

func (s *streamSink) finish(stop, stopSeq string, u canonicalUsage) {
	switch s.ingress {
	case CodecAnthropicMessages:
		s.anthropicCloseBlock()
		var seq any
		if stopSeq != "" {
			seq = stopSeq
		}
		writeSSEEvent(s.w, "message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": anthropicStopReason(stop), "stop_sequence": seq},
			"usage": anthropicUsageJSON(u),
		})
		writeSSEEvent(s.w, "message_stop", map[string]any{"type": "message_stop"})
	case CodecOpenAIResponses:
		s.responsesCloseMessage()
		s.responsesCloseReasoning()
		s.responsesCloseCall()
		status, incomplete := responsesStatus(stop)
		event := "response.completed"
		if status == "incomplete" {
			event = "response.incomplete"
		}
		s.responsesEvent(event, map[string]any{"response": s.responseObject(status, responsesUsageJSON(u), map[string]any{"incomplete_details": incomplete})})
	case CodecGeminiGenerate:
		s.geminiParts([]map[string]any{}, map[string]any{
			"finishReason":  geminiFinishReason(stop),
			"usageMetadata": geminiUsageJSON(u),
		})
	default:
		if s.includeUsage {
			s.chatChunk(map[string]any{}, openAIFinishReason(stop), nil)
			writeSSEData(s.w, map[string]any{
				"id": "chatcmpl-" + s.id, "object": "chat.completion.chunk", "created": s.created, "model": s.model,
				"choices": []any{},
				"usage":   openAIChatUsageJSON(u),
			})
		} else {
			// Without include_usage, keep usage on the final choice chunk: spec-strict clients that
			// index choices[0] never see a choice-less chunk.
			s.chatChunk(map[string]any{}, openAIFinishReason(stop), openAIChatUsageJSON(u))
		}
		_, _ = io.WriteString(s.w, "data: [DONE]\n\n")
	}
	s.flush()
}

func (s *streamSink) fail(status int, errType, message string) {
	if !s.sent {
		WriteProtocolError(s.w, s.ingress, status, errType, "upstream_error", message)
		return
	}
	switch s.ingress {
	case CodecAnthropicMessages:
		writeSSEEvent(s.w, "error", map[string]any{
			"type":  "error",
			"error": map[string]any{"type": anthropicErrorType(errType, status), "message": message},
		})
	case CodecOpenAIResponses:
		s.responsesEvent("response.failed", map[string]any{"response": s.responseObject("failed", nil, map[string]any{
			"error": map[string]any{"code": firstNonEmpty(errType, "server_error"), "message": message},
		})})
	case CodecGeminiGenerate:
		writeSSEData(s.w, map[string]any{"error": map[string]any{
			"code": status, "message": message, "status": strings.ToUpper(firstNonEmpty(errType, "internal")),
		}})
	default:
		writeSSEData(s.w, map[string]any{"error": map[string]any{
			"message": message, "type": firstNonEmpty(errType, "upstream_error"), "code": "upstream_error",
		}})
		_, _ = io.WriteString(s.w, "data: [DONE]\n\n")
	}
	s.flush()
}

// --- Anthropic helpers ---

func (s *streamSink) anthropicOpenBlock(kind string, block map[string]any) {
	if s.blockOpen == kind && kind != "tool" {
		return
	}
	s.anthropicCloseBlock()
	writeSSEEvent(s.w, "content_block_start", map[string]any{
		"type":          "content_block_start",
		"index":         s.blockIndex,
		"content_block": block,
	})
	s.blockOpen = kind
}

func (s *streamSink) anthropicCloseBlock() {
	if s.blockOpen == "" {
		return
	}
	writeSSEEvent(s.w, "content_block_stop", map[string]any{"type": "content_block_stop", "index": s.blockIndex})
	s.blockIndex++
	s.blockOpen = ""
}

func (s *streamSink) anthropicDelta(delta map[string]any) {
	writeSSEEvent(s.w, "content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": s.blockIndex,
		"delta": delta,
	})
}

// --- OpenAI Chat helpers ---

func (s *streamSink) chatChunk(delta map[string]any, finish any, usage map[string]any) {
	chunk := map[string]any{
		"id":      "chatcmpl-" + s.id,
		"object":  "chat.completion.chunk",
		"created": s.created,
		"model":   s.model,
		"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": finish}},
	}
	if usage != nil {
		chunk["usage"] = usage
	}
	writeSSEData(s.w, chunk)
}

// --- OpenAI Responses helpers ---

func (s *streamSink) responsesEvent(eventType string, fields map[string]any) {
	fields["type"] = eventType
	fields["sequence_number"] = s.seq
	s.seq++
	writeSSEEvent(s.w, eventType, fields)
}

func (s *streamSink) responseObject(status string, usage map[string]any, extra map[string]any) map[string]any {
	output := s.output
	if output == nil {
		output = []map[string]any{}
	}
	obj := map[string]any{
		"id":         "resp_" + s.id,
		"object":     "response",
		"created_at": s.created,
		"status":     status,
		"model":      s.model,
		"output":     output,
		"usage":      usage,
	}
	for k, v := range extra {
		obj[k] = v
	}
	return obj
}

func (s *streamSink) responsesTextDelta(text string) {
	if s.msg == nil {
		s.responsesCloseReasoning()
		s.msg = &responsesOpenItem{id: fmt.Sprintf("msg_%s_%d", s.id, s.outputIndex), outputIndex: s.outputIndex}
		s.outputIndex++
		s.responsesEvent("response.output_item.added", map[string]any{
			"output_index": s.msg.outputIndex,
			"item":         map[string]any{"id": s.msg.id, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}},
		})
		s.responsesEvent("response.content_part.added", map[string]any{
			"item_id": s.msg.id, "output_index": s.msg.outputIndex, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
		})
	}
	s.msg.text.WriteString(text)
	s.responsesEvent("response.output_text.delta", map[string]any{
		"item_id": s.msg.id, "output_index": s.msg.outputIndex, "content_index": 0, "delta": text, "logprobs": []any{},
	})
}

func (s *streamSink) responsesCloseMessage() {
	m := s.msg
	if m == nil {
		return
	}
	s.msg = nil
	text := m.text.String()
	part := map[string]any{"type": "output_text", "text": text, "annotations": []any{}}
	s.responsesEvent("response.output_text.done", map[string]any{
		"item_id": m.id, "output_index": m.outputIndex, "content_index": 0, "text": text, "logprobs": []any{},
	})
	s.responsesEvent("response.content_part.done", map[string]any{
		"item_id": m.id, "output_index": m.outputIndex, "content_index": 0, "part": part,
	})
	item := responsesMessageItem(m.id, text)
	s.output = append(s.output, item)
	s.responsesEvent("response.output_item.done", map[string]any{"output_index": m.outputIndex, "item": item})
}

func (s *streamSink) responsesReasoningDelta(text string) {
	if s.reasoning == nil {
		s.responsesCloseMessage()
		s.reasoning = &responsesOpenItem{id: fmt.Sprintf("rs_%s_%d", s.id, s.outputIndex), outputIndex: s.outputIndex}
		s.outputIndex++
		s.responsesEvent("response.output_item.added", map[string]any{
			"output_index": s.reasoning.outputIndex,
			"item":         map[string]any{"id": s.reasoning.id, "type": "reasoning", "summary": []any{}},
		})
		s.responsesEvent("response.reasoning_summary_part.added", map[string]any{
			"item_id": s.reasoning.id, "output_index": s.reasoning.outputIndex, "summary_index": 0,
			"part": map[string]any{"type": "summary_text", "text": ""},
		})
	}
	s.reasoning.text.WriteString(text)
	s.responsesEvent("response.reasoning_summary_text.delta", map[string]any{
		"item_id": s.reasoning.id, "output_index": s.reasoning.outputIndex, "summary_index": 0, "delta": text,
	})
}

func (s *streamSink) responsesCloseReasoning() {
	r := s.reasoning
	if r == nil {
		return
	}
	s.reasoning = nil
	text := r.text.String()
	s.responsesEvent("response.reasoning_summary_text.done", map[string]any{
		"item_id": r.id, "output_index": r.outputIndex, "summary_index": 0, "text": text,
	})
	s.responsesEvent("response.reasoning_summary_part.done", map[string]any{
		"item_id": r.id, "output_index": r.outputIndex, "summary_index": 0,
		"part": map[string]any{"type": "summary_text", "text": text},
	})
	item := map[string]any{"id": r.id, "type": "reasoning", "summary": []map[string]any{{"type": "summary_text", "text": text}}}
	s.output = append(s.output, item)
	s.responsesEvent("response.output_item.done", map[string]any{"output_index": r.outputIndex, "item": item})
}

func (s *streamSink) responsesCloseCall() {
	c := s.call
	if c == nil {
		return
	}
	s.call = nil
	args := defaultJSONObject(c.text.String())
	s.responsesEvent("response.function_call_arguments.done", map[string]any{
		"item_id": c.id, "output_index": c.outputIndex, "arguments": args,
	})
	item := responsesFunctionCallItem(c.id, c.callID, c.name, args)
	s.output = append(s.output, item)
	s.responsesEvent("response.output_item.done", map[string]any{"output_index": c.outputIndex, "item": item})
}

// --- Gemini helpers ---

func (s *streamSink) geminiParts(parts []map[string]any, extra map[string]any) {
	cand := map[string]any{
		"index":   0,
		"content": map[string]any{"role": "model", "parts": parts},
	}
	chunk := map[string]any{"modelVersion": s.model}
	if extra != nil {
		if fr, ok := extra["finishReason"]; ok {
			cand["finishReason"] = fr
		}
		if um, ok := extra["usageMetadata"]; ok {
			chunk["usageMetadata"] = um
		}
	}
	chunk["candidates"] = []map[string]any{cand}
	writeSSEData(s.w, chunk)
}
