package dataplane

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// nativePassthroughEligible reports whether the caller's own request body can be forwarded as-is:
// both sides speak the same protocol and the account is a plain API-key account. Subscription
// personas and VM runtimes keep the canonical path, which owns their request shaping.
//
// Passthrough preserves everything the canonical model does not carry (prompt-cache breakpoints,
// citations, server tools, documents, provider-specific parameters, future fields).
func nativePassthroughEligible(pctx OutboundPersonaContext, secret AccountSecret, turn *CanonicalTurn, egress CodecKind, upstreamModel string) bool {
	if len(turn.RawBody) == 0 || egress != turn.IngressCodec || strings.EqualFold(pctx.ExecutionMode, "vm_slot") {
		return false
	}
	if IsClaudeSubscription(pctx, secret) || IsCodexSubscription(pctx, secret) || IsAntigravitySubscription(pctx) {
		return false
	}
	provider := strings.ToLower(strings.TrimSpace(pctx.Provider))
	switch egress {
	case CodecAnthropicMessages, CodecAnthropicCountTokens:
		return provider == "anthropic"
	case CodecGeminiGenerate:
		return provider == "gemini"
	case CodecOpenAIResponses:
		return provider == "openai"
	case CodecOpenAIChat:
		// OpenAI-compatible vendors differ in which OpenAI parameters they accept. Forward verbatim
		// only to OpenAI itself, or when the caller addressed the vendor's model by its own name.
		return provider == "openai" || strings.TrimSpace(turn.PublicModel) == strings.TrimSpace(upstreamModel)
	}
	return false
}

// isOfficialOpenAIBase reports whether base is empty (the default) or points at api.openai.com.
func isOfficialOpenAIBase(base string) bool {
	trimmed := strings.TrimSpace(base)
	if trimmed == "" {
		return true
	}
	u, err := url.Parse(trimmed)
	return err == nil && strings.EqualFold(u.Hostname(), "api.openai.com")
}

// buildNativePassthrough rewrites only the model (and, for streamed Chat, asks for the usage
// chunk billing needs) and returns the upstream URL and body.
func buildNativePassthrough(baseURL, upstreamModel string, turn *CanonicalTurn, egress CodecKind) (string, []byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(turn.RawBody, &obj); err != nil {
		return "", nil, err
	}
	modelRaw, _ := json.Marshal(upstreamModel)
	var fullURL string
	switch egress {
	case CodecAnthropicMessages:
		obj["model"] = modelRaw
		dropUnsignedThinking(obj)
		fullURL = joinProviderPath(baseURL, "/v1/messages")
	case CodecAnthropicCountTokens:
		obj["model"] = modelRaw
		dropUnsignedThinking(obj)
		fullURL = joinProviderPath(baseURL, "/v1/messages/count_tokens")
	case CodecOpenAIChat:
		obj["model"] = modelRaw
		if turn.Stream {
			obj["stream_options"] = withIncludeUsage(obj["stream_options"])
		}
		fullURL = joinOpenAIChatPath(baseURL)
	case CodecOpenAIResponses:
		obj["model"] = modelRaw
		fullURL = joinProviderPath(baseURL, "/v1/responses")
	case CodecGeminiGenerate:
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = joinProviderPath(baseURL, "/v1beta/models/"+upstreamModel+action)
	}
	body, err := marshalNoEscape(obj)
	return fullURL, body, err
}

// dropUnsignedThinking removes thinking blocks that carry no signature. Anthropic clients only hold
// such blocks when an earlier turn was answered by another provider's reasoning output, and
// Anthropic rejects them on replay.
func dropUnsignedThinking(obj map[string]json.RawMessage) {
	raw, ok := obj["messages"]
	if !ok || !bytes.Contains(raw, []byte(`"thinking"`)) {
		return
	}
	var msgs []map[string]json.RawMessage
	if json.Unmarshal(raw, &msgs) != nil {
		return
	}
	changed := false
	for _, m := range msgs {
		var blocks []json.RawMessage
		if json.Unmarshal(m["content"], &blocks) != nil {
			continue
		}
		kept := make([]json.RawMessage, 0, len(blocks))
		for _, b := range blocks {
			var head struct {
				Type      string `json:"type"`
				Signature string `json:"signature"`
			}
			if json.Unmarshal(b, &head) == nil && head.Type == "thinking" && head.Signature == "" {
				continue
			}
			kept = append(kept, b)
		}
		if len(kept) != len(blocks) && len(kept) > 0 {
			m["content"], _ = marshalNoEscape(kept)
			changed = true
		}
	}
	if changed {
		obj["messages"], _ = marshalNoEscape(msgs)
	}
}

func withIncludeUsage(raw json.RawMessage) json.RawMessage {
	opts := map[string]any{}
	_ = json.Unmarshal(raw, &opts)
	if opts == nil {
		opts = map[string]any{}
	}
	opts["include_usage"] = true
	out, _ := json.Marshal(opts)
	return out
}

// sanitizeHeaderToken keeps comma-separated header tokens such as anthropic-beta values.
func sanitizeHeaderToken(v string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(v) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune(",._- ", r) {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// relayNativePassthrough forwards the upstream response to the caller unchanged apart from the
// model name, while decoding it on the side for billing, TTFT and the native-handoff lock.
func relayNativePassthrough(
	w http.ResponseWriter,
	resp *http.Response,
	egress CodecKind,
	turn *CanonicalTurn,
	publicModel string,
	startedAt time.Time,
	onVisibleToolDelta func(),
	metrics RelayMetrics,
) (RelayMetrics, error) {
	copyRetryHeaders(w.Header(), resp.Header)
	contentType := resp.Header.Get("Content-Type")

	if resp.StatusCode >= 400 || egress == CodecAnthropicCountTokens {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		w.Header().Set("Content-Type", firstNonEmpty(contentType, "application/json"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		metrics.TTFTMs = elapsedMs(startedAt)
		return metrics, err
	}

	// Every tool in a verbatim request was declared by the caller, so nothing is stripped here.
	relay := newTurnRelay(discardSink{}, turn, "", false, startedAt, onVisibleToolDelta)

	if !strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		if err != nil {
			return metrics, err
		}
		if res, perr := parseUnaryUpstream(egress, raw); perr == nil {
			replayResult(relay, res)
		}
		relay.Finish()
		w.Header().Set("Content-Type", firstNonEmpty(contentType, "application/json"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(rewriteTopLevelModel(raw, egress, publicModel))
		return relay.metrics(metrics), nil
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)

	dec := newUpstreamDecoder(egress, relay)
	reader := bufio.NewReaderSize(resp.Body, 64*1024)
	var block []string
	flushBlock := func() {
		if len(block) == 0 {
			return
		}
		out, keep := passthroughSSEBlock(block, egress, turn, publicModel, dec)
		block = block[:0]
		if keep {
			_, _ = io.WriteString(w, out)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
	var readErr error
	for {
		line, err := reader.ReadString('\n')
		if trimmed := strings.TrimRight(line, "\r\n"); trimmed != "" {
			block = append(block, trimmed)
		} else if line != "" {
			flushBlock()
		}
		if err != nil {
			if err != io.EOF {
				readErr = err
			}
			break
		}
	}
	flushBlock()
	relay.Finish()
	return relay.metrics(metrics), readErr
}

// passthroughSSEBlock decodes one SSE event for accounting and returns it re-serialised with the
// public model name. keep is false for events the caller did not ask for.
func passthroughSSEBlock(lines []string, egress CodecKind, turn *CanonicalTurn, publicModel string, dec upstreamDecoder) (string, bool) {
	var dataLines []string
	for _, l := range lines {
		if strings.HasPrefix(l, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(l, "data:"), " "))
		}
	}
	data := strings.Join(dataLines, "\n")
	if len(dataLines) == 0 || strings.TrimSpace(data) == "[DONE]" {
		return strings.Join(lines, "\n") + "\n\n", true
	}
	dec.handle([]byte(data))
	newData, keep := rewritePassthroughEvent([]byte(data), egress, turn, publicModel)
	if !keep {
		return "", false
	}
	var b strings.Builder
	wroteData := false
	for _, l := range lines {
		if strings.HasPrefix(l, "data:") {
			if !wroteData {
				b.WriteString("data: ")
				b.Write(newData)
				b.WriteByte('\n')
				wroteData = true
			}
			continue
		}
		b.WriteString(l)
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	return b.String(), true
}

func rewritePassthroughEvent(data []byte, egress CodecKind, turn *CanonicalTurn, publicModel string) ([]byte, bool) {
	switch egress {
	case CodecOpenAIChat:
		var chunk map[string]json.RawMessage
		if json.Unmarshal(data, &chunk) != nil {
			return data, true
		}
		// We asked upstream for the usage-only chunk; hide it from callers that did not.
		if !turn.IncludeUsage && isUsageOnlyChunk(chunk) {
			return nil, false
		}
		return replaceModelField(chunk, data, publicModel), true
	case CodecAnthropicMessages:
		if !bytes.Contains(data, []byte(`"message_start"`)) {
			return data, true
		}
		return rewriteNestedModel(data, "message", publicModel), true
	case CodecOpenAIResponses:
		if !bytes.Contains(data, []byte(`"response"`)) {
			return data, true
		}
		return rewriteNestedModel(data, "response", publicModel), true
	}
	return data, true
}

func isUsageOnlyChunk(chunk map[string]json.RawMessage) bool {
	if _, hasErr := chunk["error"]; hasErr {
		return false
	}
	usage := bytes.TrimSpace(chunk["usage"])
	if len(usage) == 0 || bytes.Equal(usage, []byte("null")) {
		return false
	}
	choices := bytes.TrimSpace(chunk["choices"])
	return len(choices) == 0 || bytes.Equal(choices, []byte("[]"))
}

// replaceModelField swaps obj["model"] for publicModel, returning original untouched when it
// already matches or has no model.
func replaceModelField(obj map[string]json.RawMessage, original []byte, publicModel string) []byte {
	cur, ok := obj["model"]
	if !ok || publicModel == "" {
		return original
	}
	want, _ := json.Marshal(publicModel)
	if bytes.Equal(bytes.TrimSpace(cur), want) {
		return original
	}
	obj["model"] = want
	out, err := marshalNoEscape(obj)
	if err != nil {
		return original
	}
	return out
}

func rewriteNestedModel(data []byte, key, publicModel string) []byte {
	var ev map[string]json.RawMessage
	if json.Unmarshal(data, &ev) != nil {
		return data
	}
	var inner map[string]json.RawMessage
	if json.Unmarshal(ev[key], &inner) != nil || inner == nil {
		return data
	}
	rewritten := replaceModelField(inner, ev[key], publicModel)
	if bytes.Equal(rewritten, ev[key]) {
		return data
	}
	ev[key] = rewritten
	out, err := marshalNoEscape(ev)
	if err != nil {
		return data
	}
	return out
}

func rewriteTopLevelModel(raw []byte, egress CodecKind, publicModel string) []byte {
	if egress == CodecGeminiGenerate {
		return raw
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return raw
	}
	return replaceModelField(obj, raw, publicModel)
}

// marshalNoEscape is json.Marshal without HTML escaping, so forwarded text keeps its bytes.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
