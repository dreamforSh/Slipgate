package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func buildUpstreamForTest(t *testing.T, path, body string, pctx OutboundPersonaContext, secret AccountSecret, model string, prepare func(*CanonicalTurn)) (*CanonicalTurn, *http.Request, CodecKind, map[string]any) {
	t.Helper()
	turn, err := ParseIngressRequest(path, "", []byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if prepare != nil {
		prepare(turn)
	}
	req, egress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, model, secret, turn)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	raw, _ := io.ReadAll(req.Body)
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("upstream body is not JSON: %v\n%s", err, raw)
	}
	return turn, req, egress, payload
}

func TestCodexSubscriptionRequestsKeepReasoningTierCacheKeyAndImages(t *testing.T) {
	t.Parallel()
	turn, _, egress, body := buildUpstreamForTest(t, "/v1/chat/completions",
		`{"model":"gpt-5","reasoning_effort":"high","service_tier":"fast","prompt_cache_key":"caller-session-1",
		  "messages":[{"role":"user","content":[{"type":"text","text":"what is this"},
		    {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]}]}`,
		OutboundPersonaContext{Provider: "codex", AuthKind: "oauth", AccountID: "acc_codex"},
		AccountSecret{APIKey: "chatgpt-token", ChatGPTAccountID: "acct-1"}, "gpt-5-codex", nil)
	if egress != CodecOpenAIResponses {
		t.Fatalf("egress = %s", egress)
	}
	reasoning, _ := body["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" || reasoning["summary"] != "auto" {
		t.Fatalf("reasoning = %v", body["reasoning"])
	}
	if include, _ := body["include"].([]any); len(include) != 1 || include[0] != "reasoning.encrypted_content" {
		t.Fatalf("include = %v", body["include"])
	}
	if body["service_tier"] != "priority" {
		t.Fatalf("service_tier = %v", body["service_tier"])
	}
	if key := body["prompt_cache_key"]; key != DeterministicUUID("slipgate-codex-cache", "caller-session-1") {
		t.Fatalf("prompt_cache_key = %v (the caller's own key must not leave the edge)", key)
	}
	input, _ := body["input"].([]any)
	first, _ := input[0].(map[string]any)
	content, _ := first["content"].([]any)
	var sawImage bool
	for _, c := range content {
		if part, _ := c.(map[string]any); part["type"] == "input_image" && part["image_url"] == "data:image/png;base64,iVBORw0KGgo=" {
			sawImage = true
		}
	}
	if !sawImage {
		t.Fatalf("the image was dropped: %v", first["content"])
	}
	if turn.UpstreamServiceTier != "priority" || billedServiceTier(turn) != "priority" {
		t.Fatalf("the tier sent upstream is the tier billed: %q / %q", turn.UpstreamServiceTier, billedServiceTier(turn))
	}
}

const anthropicServerToolTurn = `{"model":"claude-sonnet-4-5","max_tokens":1024,"service_tier":"priority",
  "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":3},
           {"name":"lookup","description":"Look something up","input_schema":{"type":"object"}}],
  "messages":[
    {"role":"user","content":"news?"},
    {"role":"assistant","content":[
      {"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"news"}},
      {"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[
        {"type":"web_search_result","url":"https://example.com","title":"Ex","encrypted_content":"Eo8BCioI","page_age":"1 day"}]},
      {"type":"text","text":"Here is the news."}]},
    {"role":"user","content":"more"}]}`

func TestClaudeSubscriptionRequestsKeepServerToolsHistoryAndBetas(t *testing.T) {
	t.Parallel()
	turn, req, egress, body := buildUpstreamForTest(t, "/v1/messages", anthropicServerToolTurn,
		OutboundPersonaContext{Provider: "anthropic", AuthKind: "oauth", AccountID: "acc_claude"},
		AccountSecret{APIKey: "sk-ant-oat01-test"}, "claude-sonnet-4-5",
		func(turn *CanonicalTurn) { turn.AnthropicBeta = "context-1m-2025-08-07, claude-code-20250219" })
	if egress != CodecAnthropicMessages {
		t.Fatalf("egress = %s", egress)
	}

	tools, _ := body["tools"].([]any)
	var sawWebSearch, sawLookup bool
	for _, raw := range tools {
		tool, _ := raw.(map[string]any)
		switch tool["name"] {
		case "web_search":
			sawWebSearch = tool["type"] == "web_search_20250305" && tool["max_uses"] == float64(3)
		case "lookup":
			sawLookup = true
		}
	}
	if !sawWebSearch || !sawLookup {
		t.Fatalf("server and custom tools must both reach Anthropic: %v", body["tools"])
	}

	msgs, _ := body["messages"].([]any)
	assistant, _ := msgs[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	var types []string
	for _, b := range blocks {
		block, _ := b.(map[string]any)
		types = append(types, block["type"].(string))
	}
	if strings.Join(types, ",") != "server_tool_use,web_search_tool_result,text" {
		t.Fatalf("assistant history = %v", types)
	}
	result, _ := blocks[1].(map[string]any)
	if items, _ := result["content"].([]any); len(items) != 1 || items[0].(map[string]any)["encrypted_content"] != "Eo8BCioI" {
		t.Fatalf("the search result must be replayed verbatim: %v", result)
	}

	beta := req.Header.Get("anthropic-beta")
	if !strings.Contains(beta, "context-1m-2025-08-07") || strings.Count(beta, "claude-code-20250219") != 1 || !strings.Contains(beta, "oauth-2025-04-20") {
		t.Fatalf("anthropic-beta = %q", beta)
	}

	if _, sent := body["service_tier"]; sent || turn.UpstreamServiceTier != "" || billedServiceTier(turn) != "default" {
		t.Fatalf("a tier the subscription never sends must not be billed: sent=%v upstream=%q billed=%q", sent, turn.UpstreamServiceTier, billedServiceTier(turn))
	}
}

func TestAnthropicOnlyContentIsDroppedForOpenAIUpstreams(t *testing.T) {
	t.Parallel()
	_, _, egress, body := buildUpstreamForTest(t, "/v1/messages", anthropicServerToolTurn,
		OutboundPersonaContext{Provider: "openai", AuthKind: "api_key"}, AccountSecret{APIKey: "sk-test"}, "gpt-4o", nil)
	if egress != CodecOpenAIChat {
		t.Fatalf("egress = %s", egress)
	}
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("only the portable tool can go to OpenAI: %v", body["tools"])
	}
	for _, raw := range body["messages"].([]any) {
		msg := raw.(map[string]any)
		if msg["role"] == "assistant" && msg["content"] != "Here is the news." {
			t.Fatalf("assistant content = %#v", msg["content"])
		}
	}
}

func TestOnlyTheServiceTierSentUpstreamIsBilled(t *testing.T) {
	t.Parallel()
	const chat = `{"model":"%s","service_tier":"priority","messages":[{"role":"user","content":"hi"}]}`
	// An OpenAI-compatible vendor reached by transcoding gets no tier, so none is billed.
	turn, _, _, body := buildUpstreamForTest(t, "/v1/chat/completions", strings.Replace(chat, "%s", "public-model", 1),
		OutboundPersonaContext{Provider: "deepseek", AuthKind: "api_key"}, AccountSecret{APIKey: "sk-test", BaseURL: "https://api.deepseek.com"}, "deepseek-chat", nil)
	if _, sent := body["service_tier"]; sent || billedServiceTier(turn) != "default" {
		t.Fatalf("vendor: sent=%v billed=%q", sent, billedServiceTier(turn))
	}
	// OpenAI itself receives the caller's body verbatim, tier included.
	turn, _, _, body = buildUpstreamForTest(t, "/v1/chat/completions", strings.Replace(chat, "%s", "gpt-4o", 1),
		OutboundPersonaContext{Provider: "openai", AuthKind: "api_key"}, AccountSecret{APIKey: "sk-test"}, "gpt-4o", nil)
	if !turn.NativePassthrough || body["service_tier"] != "priority" || billedServiceTier(turn) != "priority" {
		t.Fatalf("openai: passthrough=%v sent=%v billed=%q", turn.NativePassthrough, body["service_tier"], billedServiceTier(turn))
	}
	// A turn that asked for no tier bills none.
	turn, _, _, _ = buildUpstreamForTest(t, "/v1/chat/completions", `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`,
		OutboundPersonaContext{Provider: "openai", AuthKind: "api_key"}, AccountSecret{APIKey: "sk-test"}, "gpt-4o", nil)
	if billedServiceTier(turn) != "" {
		t.Fatalf("no tier requested, billed %q", billedServiceTier(turn))
	}
}
