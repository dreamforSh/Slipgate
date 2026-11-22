package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mustParseTurn(t *testing.T, path, body string) *CanonicalTurn {
	t.Helper()
	turn, err := ParseIngressRequest(path, "", []byte(body))
	if err != nil {
		t.Fatalf("ParseIngressRequest(%s): %v", path, err)
	}
	return turn
}

// jsonOf returns a decoder usable directly on (body, err) results: jsonOf(t)(encode(...)).
func jsonOf(t *testing.T) func([]byte, error) map[string]any {
	return func(raw []byte, err error) map[string]any {
		t.Helper()
		return mustJSONObject(t, raw, err)
	}
}

func mustJSONObject(t *testing.T, raw []byte, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("invalid JSON %s: %v", raw, err)
	}
	return out
}

func sseResponse(lines ...string) *http.Response {
	h := make(http.Header)
	h.Set("Content-Type", "text/event-stream")
	return &http.Response{StatusCode: http.StatusOK, Header: h, Body: io.NopCloser(strings.NewReader(strings.Join(lines, "\n") + "\n"))}
}

func jsonResponse(status int, body string) *http.Response {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}

// sseEvents decodes every data payload of an SSE body (skipping [DONE]).
func sseEvents(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok || data == "[DONE]" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			t.Fatalf("bad SSE data %q: %v", data, err)
		}
		out = append(out, ev)
	}
	return out
}

func TestAnthropicParallelToolResultsSurviveTranslation(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[
		{"role":"user","content":"weather in Tokyo and Paris?"},
		{"role":"assistant","content":[{"type":"text","text":"Checking."},
			{"type":"tool_use","id":"toolu_a","name":"lookup_weather","input":{"city":"Tokyo"}},
			{"type":"tool_use","id":"toolu_b","name":"lookup_weather","input":{"city":"Paris"}}]},
		{"role":"user","content":[
			{"type":"tool_result","tool_use_id":"toolu_a","content":"sunny"},
			{"type":"tool_result","tool_use_id":"toolu_b","content":[{"type":"text","text":"rain"}],"is_error":true},
			{"type":"text","text":"thanks"}]}
	],"tools":[{"name":"lookup_weather","input_schema":{"type":"object"}}]}`)

	if len(turn.Messages) != 5 {
		t.Fatalf("expected user, assistant, 2 tool results, user; got %+v", turn.Messages)
	}
	if turn.Messages[2].ToolCallID != "toolu_a" || turn.Messages[3].ToolCallID != "toolu_b" || !turn.Messages[3].IsError || turn.Messages[3].Content != "rain" {
		t.Fatalf("tool results lost their ids/errors: %+v", turn.Messages[2:4])
	}

	oa := jsonOf(t)(encodeOpenAIChatRequestBody("openai", "gpt-4o", turn, turn.Tools))
	msgs := oa["messages"].([]any)
	var roles []string
	for _, m := range msgs {
		roles = append(roles, m.(map[string]any)["role"].(string))
	}
	if strings.Join(roles, ",") != "user,assistant,tool,tool,user" {
		t.Fatalf("unexpected OpenAI roles %v", roles)
	}
	if msgs[3].(map[string]any)["tool_call_id"] != "toolu_b" {
		t.Fatalf("second tool message lost its id: %v", msgs[3])
	}

	ant := jsonOf(t)(encodeAnthropicRequestBody("claude-sonnet-4-5", turn, turn.Tools, false, true, OutboundPersonaContext{}, false))
	antMsgs := ant["messages"].([]any)
	if len(antMsgs) != 3 {
		t.Fatalf("expected merged user/assistant/user turns, got %v", antMsgs)
	}
	blocks := antMsgs[2].(map[string]any)["content"].([]any)
	if len(blocks) != 3 || blocks[0].(map[string]any)["tool_use_id"] != "toolu_a" ||
		blocks[1].(map[string]any)["is_error"] != true || blocks[2].(map[string]any)["type"] != "text" {
		t.Fatalf("tool results must share one user turn ahead of the text: %v", blocks)
	}
}

func TestImagesTranslateBetweenOpenAIAndAnthropic(t *testing.T) {
	t.Parallel()
	chat := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":[
		{"type":"text","text":"what is this?"},
		{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]}]}`)
	ant := jsonOf(t)(encodeAnthropicRequestBody("claude-sonnet-4-5", chat, nil, false, true, OutboundPersonaContext{}, false))
	if ant["max_tokens"] != float64(8192) {
		t.Fatalf("unset max_tokens should default to 8192, got %v", ant["max_tokens"])
	}
	content := ant["messages"].([]any)[0].(map[string]any)["content"].([]any)
	img := content[1].(map[string]any)
	src := img["source"].(map[string]any)
	if img["type"] != "image" || src["type"] != "base64" || src["media_type"] != "image/png" || src["data"] != "iVBORw0KGgo=" {
		t.Fatalf("image not converted to an Anthropic base64 block: %v", content)
	}

	antTurn := mustParseTurn(t, "/v1/messages", `{"model":"gpt-4o","max_tokens":64,"messages":[{"role":"user","content":[
		{"type":"image","source":{"type":"url","url":"https://example.com/cat.jpg"}},{"type":"text","text":"describe"}]}]}`)
	oa := jsonOf(t)(encodeOpenAIChatRequestBody("openai", "gpt-4o", antTurn, nil))
	parts := oa["messages"].([]any)[0].(map[string]any)["content"].([]any)
	if parts[0].(map[string]any)["type"] != "image_url" ||
		parts[0].(map[string]any)["image_url"].(map[string]any)["url"] != "https://example.com/cat.jpg" {
		t.Fatalf("Anthropic image not converted to image_url: %v", parts)
	}
}

func TestResponsesInputParsesDeveloperMessagesAndParallelCalls(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/responses", `{"model":"gpt-5","instructions":"Be brief.","input":[
		{"role":"developer","content":"Use metric units."},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"Weather?"},{"type":"input_image","image_url":"https://example.com/a.png"}]},
		{"type":"function_call","call_id":"call_1","name":"lookup_weather","arguments":"{\"city\":\"Oslo\"}"},
		{"type":"function_call","call_id":"call_2","name":"lookup_weather","arguments":"{\"city\":\"Rome\"}"},
		{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"5C"}]},
		{"type":"function_call_output","call_id":"call_2","output":"20C"},
		{"type":"reasoning","id":"rs_1","summary":[]}
	],"tools":[{"type":"function","name":"lookup_weather","parameters":{"type":"object"}},{"type":"web_search"}],
	"tool_choice":{"type":"function","name":"lookup_weather"},
	"text":{"format":{"type":"json_schema","name":"wx","schema":{"type":"object"}}},
	"reasoning":{"effort":"high"},"max_output_tokens":300}`)

	if turn.SystemPrompt != "Be brief.\n\nUse metric units." {
		t.Fatalf("developer message should join the system prompt, got %q", turn.SystemPrompt)
	}
	if len(turn.Messages) != 4 || len(turn.Messages[1].ToolCalls) != 2 {
		t.Fatalf("expected user, assistant(2 calls), 2 tool results; got %+v", turn.Messages)
	}
	if turn.Messages[2].Content != "5C" || turn.Messages[3].Content != "20C" {
		t.Fatalf("array and string function outputs must both parse: %+v", turn.Messages[2:])
	}
	if len(turn.Messages[0].Parts) != 2 || turn.Messages[0].Parts[1].URL != "https://example.com/a.png" {
		t.Fatalf("input_image lost: %+v", turn.Messages[0])
	}
	if len(turn.Tools) != 1 || turn.ToolChoice == nil || turn.ToolChoice.Name != "lookup_weather" ||
		turn.ResponseFormat == nil || turn.ResponseFormat.Name != "wx" || turn.ReasoningEffort != "high" || !turn.MaxTokensSet {
		t.Fatalf("Responses parameters not carried: %+v", turn)
	}
}

func TestSamplingAndToolChoiceMapToAnthropic(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","temperature":0.3,"top_p":0.9,
		"stop":["END"],"tool_choice":"required","parallel_tool_calls":false,
		"messages":[{"role":"user","content":"hi"}],
		"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}]}`)
	ant := jsonOf(t)(encodeAnthropicRequestBody("claude-sonnet-4-5", turn, turn.Tools, false, true, OutboundPersonaContext{}, false))
	if ant["temperature"] != 0.3 || ant["top_p"] != nil {
		t.Fatalf("temperature and top_p must not both reach Claude: %v", ant)
	}
	choice := ant["tool_choice"].(map[string]any)
	if choice["type"] != "any" || choice["disable_parallel_tool_use"] != true {
		t.Fatalf("unexpected tool_choice %v", choice)
	}
	if stops := ant["stop_sequences"].([]any); len(stops) != 1 || stops[0] != "END" {
		t.Fatalf("stop not mapped: %v", ant["stop_sequences"])
	}
	if ant["thinking"] != nil {
		t.Fatalf("forced tool use must not enable thinking: %v", ant["thinking"])
	}

	reasoning := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","reasoning_effort":"high",
		"temperature":0.5,"max_tokens":1000,"messages":[{"role":"user","content":"think"}]}`)
	ant = jsonOf(t)(encodeAnthropicRequestBody("claude-sonnet-4-5", reasoning, nil, false, true, OutboundPersonaContext{}, false))
	thinking := ant["thinking"].(map[string]any)
	if thinking["budget_tokens"] != float64(24576) || ant["max_tokens"] != float64(24576+4096) || ant["temperature"] != nil {
		t.Fatalf("reasoning_effort=high should become thinking with room for output and no temperature: %v", ant)
	}
}

func TestCurrentClaudeModelsGetAdaptiveThinkingAndNoSampling(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-5-5","reasoning_effort":"high","temperature":0.4,"top_p":0.9,
		"response_format":{"type":"json_schema","json_schema":{"name":"r","schema":{"type":"object"}}},
		"messages":[{"role":"user","content":"hi"}]}`)
	ant := jsonOf(t)(encodeAnthropicRequestBody("claude-sonnet-5-5", turn, nil, false, true, OutboundPersonaContext{}, false))
	if ant["temperature"] != nil || ant["top_p"] != nil || ant["top_k"] != nil {
		t.Fatalf("current Claude models take no sampling parameters: %v", ant)
	}
	if ant["thinking"].(map[string]any)["type"] != "adaptive" {
		t.Fatalf("expected adaptive thinking: %v", ant["thinking"])
	}
	oc := ant["output_config"].(map[string]any)
	if oc["effort"] != "high" || oc["format"].(map[string]any)["type"] != "json_schema" {
		t.Fatalf("effort and JSON schema belong in output_config: %v", oc)
	}
	if ant["max_tokens"] != float64(8192) {
		t.Fatalf("adaptive thinking needs no budget bump: %v", ant["max_tokens"])
	}

	for model, legacy := range map[string]bool{
		"claude-sonnet-4-5": true, "claude-sonnet-4-5-20250929": true, "claude-sonnet-4-20250514": true,
		"claude-3-7-sonnet-latest": true, "deepseek-chat": true,
		"claude-opus-4-6": false, "claude-sonnet-5-5": false, "claude-fable-5-2": false,
	} {
		if got := anthropicLegacyParams(model); got != legacy {
			t.Errorf("anthropicLegacyParams(%s) = %v, want %v", model, got, legacy)
		}
	}

	adaptive := mustParseTurn(t, "/v1/messages", `{"model":"gpt-5","max_tokens":500,"thinking":{"type":"adaptive"},
		"output_config":{"effort":"xhigh"},"messages":[{"role":"user","content":"hi"}]}`)
	oa := jsonOf(t)(encodeOpenAIChatRequestBody("openai", "gpt-5", adaptive, nil))
	if oa["reasoning_effort"] != "xhigh" {
		t.Fatalf("output_config.effort should carry to OpenAI: %v", oa)
	}
}

func TestThinkingMapsToOpenAIReasoningOnlyForOpenAIReasoningModels(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"gpt-5","max_tokens":2048,"temperature":0.7,
		"thinking":{"type":"enabled","budget_tokens":10000},"messages":[{"role":"user","content":"hi"}]}`)
	oa := jsonOf(t)(encodeOpenAIChatRequestBody("openai", "gpt-5", turn, nil))
	if oa["max_completion_tokens"] != float64(2048) || oa["max_tokens"] != nil || oa["reasoning_effort"] != "medium" || oa["temperature"] != nil {
		t.Fatalf("unexpected gpt-5 body: %v", oa)
	}
	ds := jsonOf(t)(encodeOpenAIChatRequestBody("deepseek", "deepseek-chat", turn, nil))
	if ds["max_tokens"] != float64(2048) || ds["temperature"] != 0.7 || ds["reasoning_effort"] != nil {
		t.Fatalf("compatible vendors keep max_tokens/temperature: %v", ds)
	}
	unset := mustParseTurn(t, "/v1/chat/completions", `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	plain := jsonOf(t)(encodeOpenAIChatRequestBody("openai", "gpt-4o", unset, nil))
	if plain["max_tokens"] != nil || plain["max_completion_tokens"] != nil {
		t.Fatalf("an unset limit must not be invented: %v", plain)
	}
}

func TestUsageAndStopReasonNormalisation(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"gpt-4o","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`)
	upstream := jsonResponse(200, `{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"length"}],
		"usage":{"prompt_tokens":1200,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":1000},"completion_tokens_details":{"reasoning_tokens":40}}}`)
	rec := httptest.NewRecorder()
	metrics, err := RelayAndTranscodeResponse(rec, upstream, CodecOpenAIChat, turn, "gpt-4o", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	if metrics.InputTokens != 200 || metrics.CacheReadTokens != 1000 || metrics.OutputTokens != 100 {
		t.Fatalf("cached tokens must not be billed twice: %+v", metrics)
	}
	out := mustJSONObject(t, rec.Body.Bytes(), nil)
	usage := out["usage"].(map[string]any)
	if out["stop_reason"] != "max_tokens" || usage["input_tokens"] != float64(200) || usage["cache_read_input_tokens"] != float64(1000) {
		t.Fatalf("unexpected Anthropic body: %s", rec.Body.String())
	}

	// And back: Anthropic usage reported to an OpenAI client includes cache tokens in prompt_tokens.
	chat := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`)
	antUp := jsonResponse(200, `{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}],"stop_reason":"stop_sequence","stop_sequence":"END",
		"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":90,"cache_creation_input_tokens":20}}`)
	rec = httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(rec, antUp, CodecAnthropicMessages, chat, "claude-sonnet-4-5", "zero", time.Now(), nil); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	out = mustJSONObject(t, rec.Body.Bytes(), nil)
	usage = out["usage"].(map[string]any)
	choice := out["choices"].([]any)[0].(map[string]any)
	if usage["prompt_tokens"] != float64(120) || usage["prompt_tokens_details"].(map[string]any)["cached_tokens"] != float64(90) || choice["finish_reason"] != "stop" {
		t.Fatalf("unexpected OpenAI body: %s", rec.Body.String())
	}
}

func TestAnthropicStreamKeepsThinkingSignaturesAndStreamsToolInput(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"claude-sonnet-4-5","max_tokens":2048,"stream":true,
		"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"weather?"}],
		"tools":[{"name":"lookup_weather","input_schema":{"type":"object"}}]}`)
	upstream := sseResponse(
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_u","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":50,"cache_read_input_tokens":7,"output_tokens":1}}}`,
		``,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}`,
		`data: {"type":"content_block_stop","index":0}`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"lookup_weather","input":{}}}`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"Oslo\"}"}}`,
		`data: {"type":"content_block_stop","index":1}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":33}}`,
		`data: {"type":"message_stop"}`,
	)
	rec := httptest.NewRecorder()
	tracker := &NativeTurnTracker{}
	metrics, err := RelayAndTranscodeResponse(rec, upstream, CodecAnthropicMessages, turn, "claude-sonnet-4-5", "zero", time.Now(), tracker.OnVisibleToolDelta)
	if err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{`"thinking_delta"`, `"signature":"sig123"`, `"type":"tool_use"`, `"stop_reason":"tool_use"`, `"cache_read_input_tokens":7`, `"model":"claude-sonnet-4-5"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s in:\n%s", want, body)
		}
	}
	if strings.Count(body, `"input_json_delta"`) != 2 {
		t.Fatalf("tool input should stream incrementally:\n%s", body)
	}
	if strings.Contains(body, "20250929") {
		t.Fatalf("upstream model id leaked:\n%s", body)
	}
	if metrics.InputTokens != 50 || metrics.CacheReadTokens != 7 || metrics.OutputTokens != 33 || tracker.CanFailover() {
		t.Fatalf("unexpected metrics %+v (failover locked=%v)", metrics, !tracker.CanFailover())
	}
}

func TestResponsesStreamEmitsSDKEventSequence(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/responses", `{"model":"gpt-4o","stream":true,"input":"hi","tools":[{"type":"function","name":"lookup_weather"}]}`)
	upstream := sseResponse(
		`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}`,
		`data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}`,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"lookup_weather","arguments":""}}]}}]}`,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}`,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Oslo\"}"}}]}}]}`,
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":10}}}`,
		`data: [DONE]`,
	)
	rec := httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(rec, upstream, CodecOpenAIChat, turn, "gpt-4o", "zero", time.Now(), nil); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	events := sseEvents(t, rec.Body.String())
	var types []string
	msgItemID := ""
	for i, ev := range events {
		if int(ev["sequence_number"].(float64)) != i {
			t.Fatalf("sequence_number must count from 0: event %d is %v", i, ev)
		}
		typ := ev["type"].(string)
		types = append(types, typ)
		if typ == "response.output_item.added" {
			if item := ev["item"].(map[string]any); item["type"] == "message" {
				msgItemID = item["id"].(string)
			}
		}
		if typ == "response.output_text.delta" && ev["item_id"] != msgItemID {
			t.Fatalf("text delta must reference its message item: %v", ev)
		}
	}
	want := []string{
		"response.created", "response.in_progress",
		"response.output_item.added", "response.content_part.added",
		"response.output_text.delta", "response.output_text.delta",
		"response.output_text.done", "response.content_part.done", "response.output_item.done",
		"response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.delta",
		"response.function_call_arguments.done", "response.output_item.done",
		"response.completed",
	}
	if strings.Join(types, " ") != strings.Join(want, " ") {
		t.Fatalf("event sequence mismatch\n got: %v\nwant: %v", types, want)
	}
	final := events[len(events)-1]["response"].(map[string]any)
	usage := final["usage"].(map[string]any)
	if len(final["output"].([]any)) != 2 || usage["input_tokens"] != float64(40) ||
		usage["input_tokens_details"].(map[string]any)["cached_tokens"] != float64(10) {
		t.Fatalf("response.completed must carry output and usage: %v", final)
	}
}

func TestUpstreamStreamErrorsBecomeProtocolErrors(t *testing.T) {
	t.Parallel()
	chat := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	early := sseResponse(`event: error`, `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)
	rec := httptest.NewRecorder()
	metrics, _ := RelayAndTranscodeResponse(rec, early, CodecAnthropicMessages, chat, "claude-sonnet-4-5", "zero", time.Now(), nil)
	if rec.Code != 529 || !strings.Contains(rec.Body.String(), "Overloaded") {
		t.Fatalf("an error before any output must surface as HTTP 529, got %d %s", rec.Code, rec.Body.String())
	}
	if metrics.UpstreamStatus != 529 || metrics.InputTokens != 0 || metrics.OutputTokens != 0 {
		t.Fatalf("failed turn must not bill: %+v", metrics)
	}

	late := sseResponse(
		`data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}`,
		`data: {"type":"error","error":{"type":"api_error","message":"boom"}}`,
	)
	rec = httptest.NewRecorder()
	metrics, _ = RelayAndTranscodeResponse(rec, late, CodecAnthropicMessages, chat, "claude-sonnet-4-5", "zero", time.Now(), nil)
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, "partial") || !strings.Contains(body, `"error"`) || !strings.HasSuffix(strings.TrimSpace(body), "[DONE]") {
		t.Fatalf("an error mid-stream must arrive as an error chunk:\n%s", body)
	}
	if metrics.UpstreamStatus != 500 {
		t.Fatalf("mid-stream api_error should report 500, got %d", metrics.UpstreamStatus)
	}
}

func TestUpstreamHTTPErrorsKeepTypeAndRetryHints(t *testing.T) {
	t.Parallel()
	chat := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`)
	upstream := jsonResponse(529, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)
	upstream.Header.Set("Retry-After", "7")
	rec := httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(rec, upstream, CodecAnthropicMessages, chat, "claude-sonnet-4-5", "zero", time.Now(), nil); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	out := mustJSONObject(t, rec.Body.Bytes(), nil)
	if rec.Code != 529 || rec.Header().Get("Retry-After") != "7" || out["error"].(map[string]any)["type"] != "overloaded_error" {
		t.Fatalf("unexpected error relay: %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}

	// Anthropic callers always get a valid Anthropic error type.
	rec = httptest.NewRecorder()
	WriteProtocolError(rec, CodecAnthropicMessages, http.StatusPaymentRequired, "quota_error", "insufficient_quota", "no balance")
	if !strings.Contains(rec.Body.String(), `"type":"billing_error"`) {
		t.Fatalf("expected billing_error, got %s", rec.Body.String())
	}
}

func TestIncludeUsageEmitsSpecUsageChunk(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/chat/completions", `{"model":"claude-sonnet-4-5","stream":true,"stream_options":{"include_usage":true},
		"messages":[{"role":"user","content":"hi"}]}`)
	upstream := ExecuteMockTurn("mock://ok", "claude-sonnet-4-5", CodecAnthropicMessages, turn)
	rec := httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(rec, upstream, CodecAnthropicMessages, turn, "claude-sonnet-4-5", "zero", time.Now(), nil); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	events := sseEvents(t, rec.Body.String())
	last := events[len(events)-1]
	if choices := last["choices"].([]any); len(choices) != 0 || last["usage"] == nil {
		t.Fatalf("include_usage needs a final choice-less usage chunk: %v", last)
	}
	finish := events[len(events)-2]["choices"].([]any)[0].(map[string]any)
	if finish["finish_reason"] != "stop" {
		t.Fatalf("finish chunk missing: %v", finish)
	}
}

func TestGeminiFunctionResponsesUseCallNames(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/chat/completions", `{"model":"gemini-2.5-pro","messages":[
		{"role":"user","content":"run f"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}},
			{"id":"call_2","type":"function","function":{"name":"g","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"ok"},
		{"role":"tool","tool_call_id":"call_2","content":"{\"v\":1}"}]}`)
	gem := jsonOf(t)(encodeGeminiRequestBodyForModel("gemini-2.5-pro", turn, nil))
	contents := gem["contents"].([]any)
	if len(contents) != 3 {
		t.Fatalf("expected user, model, merged function responses; got %v", contents)
	}
	parts := contents[2].(map[string]any)["parts"].([]any)
	first := parts[0].(map[string]any)["functionResponse"].(map[string]any)
	second := parts[1].(map[string]any)["functionResponse"].(map[string]any)
	if first["name"] != "f" || first["response"].(map[string]any)["content"] != "ok" ||
		second["name"] != "g" || second["response"].(map[string]any)["v"] != float64(1) {
		t.Fatalf("function responses must carry call names and JSON objects: %v", parts)
	}
}

func TestUnaryResponsesReportsIncompleteOnMaxTokens(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/responses", `{"model":"claude-sonnet-4-5","input":"long story","max_output_tokens":5}`)
	upstream := jsonResponse(200, `{"id":"msg_1","type":"message","content":[{"type":"text","text":"Once"}],"stop_reason":"max_tokens","usage":{"input_tokens":3,"output_tokens":5}}`)
	rec := httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(rec, upstream, CodecAnthropicMessages, turn, "claude-sonnet-4-5", "zero", time.Now(), nil); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	out := mustJSONObject(t, rec.Body.Bytes(), nil)
	if out["status"] != "incomplete" || out["incomplete_details"].(map[string]any)["reason"] != "max_output_tokens" || out["output_text"] != "Once" {
		t.Fatalf("unexpected Responses body: %s", rec.Body.String())
	}
}

func TestAnthropicPassthroughForwardsBodyHeadersAndStream(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"team-sonnet","max_tokens":64,"stream":true,
		"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
		"messages":[{"role":"user","content":"hi <b>"}],"some_future_field":{"x":1}}`)
	turn.AnthropicVersion = "2023-06-01"
	turn.AnthropicBeta = "context-1m-2025-08-07"
	pctx := OutboundPersonaContext{Provider: "anthropic", AuthKind: "api_key", ExecutionMode: "direct_api"}
	req, egress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, "claude-sonnet-4-5", AccountSecret{APIKey: "sk-ant-api03-test"}, turn)
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	raw, _ := io.ReadAll(req.Body)
	body := string(raw)
	if !turn.NativePassthrough || egress != CodecAnthropicMessages || req.URL.String() != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("expected native passthrough to /v1/messages, got %v %s %s", turn.NativePassthrough, egress, req.URL)
	}
	if req.Header.Get("anthropic-beta") != "context-1m-2025-08-07" || req.Header.Get("x-api-key") != "sk-ant-api03-test" {
		t.Fatalf("caller beta header / api key missing: %v", req.Header)
	}
	for _, want := range []string{`"cache_control":{"type":"ephemeral"}`, `"some_future_field":{"x":1}`, `"model":"claude-sonnet-4-5"`, `hi <b>`} {
		if !strings.Contains(body, want) {
			t.Fatalf("passthrough body missing %s: %s", want, body)
		}
	}

	textLine := `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`
	upstream := sseResponse(
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_u","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}`,
		``,
		`event: content_block_delta`,
		textLine,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}`,
		``,
	)
	rec := httptest.NewRecorder()
	tracker := &NativeTurnTracker{}
	metrics, err := RelayAndTranscodeResponse(rec, upstream, egress, turn, "team-sonnet", "zero", time.Now(), tracker.OnVisibleToolDelta)
	if err != nil {
		t.Fatalf("passthrough relay failed: %v", err)
	}
	out := rec.Body.String()
	if !strings.Contains(out, `"model":"team-sonnet"`) || strings.Contains(out, "20250929") {
		t.Fatalf("message_start model must show the public name:\n%s", out)
	}
	if !strings.Contains(out, "event: content_block_delta\n"+textLine+"\n\n") {
		t.Fatalf("untouched events must be forwarded byte for byte:\n%s", out)
	}
	if metrics.InputTokens != 12 || metrics.OutputTokens != 9 || tracker.CanFailover() {
		t.Fatalf("passthrough accounting wrong: %+v", metrics)
	}
}

func TestAnthropicPassthroughDropsUnsignedThinking(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[
		{"role":"user","content":"q1"},
		{"role":"assistant","content":[{"type":"thinking","thinking":"from deepseek","signature":""},{"type":"text","text":"a1"}]},
		{"role":"assistant","content":[{"type":"thinking","thinking":"from claude","signature":"sig"},{"type":"text","text":"a2"}]},
		{"role":"user","content":"q2"}]}`)
	pctx := OutboundPersonaContext{Provider: "anthropic", AuthKind: "api_key"}
	req, _, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, "claude-sonnet-4-5", AccountSecret{APIKey: "k"}, turn)
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	raw, _ := io.ReadAll(req.Body)
	if strings.Contains(string(raw), "from deepseek") || !strings.Contains(string(raw), `"signature":"sig"`) || !strings.Contains(string(raw), `"a1"`) {
		t.Fatalf("only unsigned thinking should be dropped: %s", raw)
	}
}

func TestOpenAIPassthroughHidesInjectedUsageChunk(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/chat/completions", `{"model":"gpt-4o","stream":true,"logprobs":true,"messages":[{"role":"user","content":"hi"}]}`)
	pctx := OutboundPersonaContext{Provider: "openai", AuthKind: "api_key", ExecutionMode: "direct_api"}
	req, egress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, "gpt-4o", AccountSecret{APIKey: "sk-test"}, turn)
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	raw, _ := io.ReadAll(req.Body)
	if !turn.NativePassthrough || !strings.Contains(string(raw), `"include_usage":true`) || !strings.Contains(string(raw), `"logprobs":true`) {
		t.Fatalf("expected verbatim body with include_usage injected: %s", raw)
	}
	upstream := sseResponse(
		`data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"hey"},"finish_reason":null}]}`,
		``,
		`data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		``,
		`data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2}}`,
		``,
		`data: [DONE]`,
		``,
	)
	rec := httptest.NewRecorder()
	metrics, err := RelayAndTranscodeResponse(rec, upstream, egress, turn, "gpt-4o", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	out := rec.Body.String()
	if strings.Contains(out, `"choices":[]`) || strings.Contains(out, "2024-08-06") || !strings.Contains(out, "data: [DONE]") {
		t.Fatalf("usage chunk must be hidden and model rewritten:\n%s", out)
	}
	if metrics.InputTokens != 8 || metrics.OutputTokens != 2 {
		t.Fatalf("usage from the hidden chunk must still be billed: %+v", metrics)
	}
}

func TestPassthroughStaysOffForSubscriptionsAndAliasedVendors(t *testing.T) {
	t.Parallel()
	turn := mustParseTurn(t, "/v1/messages", `{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)
	sub := OutboundPersonaContext{Provider: "anthropic", AuthKind: "oauth"}
	if nativePassthroughEligible(sub, AccountSecret{}, turn, CodecAnthropicMessages, "claude-sonnet-4-5") {
		t.Fatal("subscription accounts must keep the canonical path")
	}
	chat := mustParseTurn(t, "/v1/chat/completions", `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	aliased := OutboundPersonaContext{Provider: "deepseek", AuthKind: "api_key"}
	if nativePassthroughEligible(aliased, AccountSecret{}, chat, CodecOpenAIChat, "deepseek-chat") {
		t.Fatal("an aliased OpenAI request must be translated for a compatible vendor")
	}
	if !nativePassthroughEligible(aliased, AccountSecret{}, mustParseTurn(t, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`), CodecOpenAIChat, "deepseek-chat") {
		t.Fatal("a vendor model addressed by its own name can be forwarded verbatim")
	}
	if got := ProviderEgressCodecWithPersona(OutboundPersonaContext{Provider: "openai", AuthKind: "api_key"}, AccountSecret{BaseURL: "https://proxy.example.com/v1"}, CodecOpenAIResponses); got != CodecOpenAIChat {
		t.Fatalf("non-OpenAI base URLs must not assume /v1/responses support, got %s", got)
	}
}

func TestSupportedDataPlaneRoutes(t *testing.T) {
	t.Parallel()
	cases := []struct {
		method, path string
		want         bool
	}{
		{http.MethodPost, "/v1/chat/completions", true},
		{http.MethodPost, "/v1/responses", true},
		{http.MethodPost, "/v1/messages", true},
		{http.MethodPost, "/v1/messages/count_tokens", true},
		{http.MethodGet, "/v1/models", true},
		{http.MethodGet, "/v1/models/claude-sonnet-4-5", true},
		{http.MethodPost, "/v1beta/models/gemini-2.5-pro:streamGenerateContent", true},
		{http.MethodPost, "/v1beta/models/gemini-2.5-pro:countTokens", true},
		{http.MethodPost, "/mcp/v1", true},
		{http.MethodPost, "/v1/embeddings", false},
		{http.MethodPost, "/v1/images/generations", false},
		{http.MethodGet, "/v1/chat/completions", false},
		{http.MethodPost, "/v1beta/models/gemini-2.5-pro:embedContent", false},
	}
	for _, c := range cases {
		if got := isSupportedDataPlaneRoute(c.method, c.path); got != c.want {
			t.Errorf("%s %s: got %v want %v", c.method, c.path, got, c.want)
		}
	}
}
