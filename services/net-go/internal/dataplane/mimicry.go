package dataplane

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const (
	claudeCodeSystemPreamble = "You are Claude Code, Anthropic's official CLI for Claude."
	claudeCodeBetaHeader     = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
	claudeCLIUserAgent       = "claude-cli/2.1.280 (external, cli)"
	codexCLIUserAgent        = "codex_cli_rs/0.38.0 (Linux 6.8.0; x86_64)"
	antigravityUserAgent     = "antigravity/1.15.8 linux/amd64"
	defaultAntigravityProj   = "rising-fact-p41fc"
)

// OutboundPersonaContext carries account, auth, and VM-slot identity metadata into outbound protocol shaping.
type OutboundPersonaContext struct {
	Provider         string
	AuthKind         string
	SubscriptionTier string
	TierMultiplier   uint16
	ExecutionMode    string
	AccountID        string
	GuestMachineID   string
	RuntimeProfile   string
	CleanseMode      string
	RequestID        string
	CatalogProtocols []string
}

// IsClaudeSubscription reports whether outbound traffic should emulate official Claude Code Pro/Max OAuth/CLI wire format.
func IsClaudeSubscription(pctx OutboundPersonaContext, secret AccountSecret) bool {
	if !strings.EqualFold(strings.TrimSpace(pctx.Provider), "anthropic") {
		return false
	}
	ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))
	if ak == "oauth" || ak == "setup_token" || ak == "vm_cli_seed" {
		return true
	}
	key := strings.TrimSpace(secret.APIKey)
	return strings.HasPrefix(key, "sk-ant-oat")
}

// IsCodexSubscription reports whether outbound traffic should emulate OpenAI Codex CLI Responses wire format.
func IsCodexSubscription(pctx OutboundPersonaContext, secret AccountSecret) bool {
	prov := strings.ToLower(strings.TrimSpace(pctx.Provider))
	if prov == "codex" {
		return true
	}
	if prov == "openai" {
		ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))
		if ak == "oauth" || ak == "vm_cli_seed" || strings.TrimSpace(secret.ChatGPTAccountID) != "" {
			return true
		}
	}
	return false
}

// IsAntigravitySubscription reports whether outbound traffic targets Antigravity Cloud Code v1internal.
func IsAntigravitySubscription(pctx OutboundPersonaContext) bool {
	return strings.EqualFold(strings.TrimSpace(pctx.Provider), "antigravity")
}

// DeterministicUUID derives a stable RFC 4122 v4-formatted UUID from a namespace and seed.
func DeterministicUUID(namespace, seed string) string {
	sum := sha256.Sum256([]byte(namespace + ":" + seed))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16],
	)
}

// ClaudeMetadataUserID builds a stable per-account/per-VM `user_<64hex>_account_<uuid>_session_<uuid>` identifier without leaking caller PII.
func ClaudeMetadataUserID(accountID, guestMachineID string) string {
	anchor := strings.TrimSpace(accountID) + "|" + strings.TrimSpace(guestMachineID)
	deviceHash := sha256.Sum256([]byte("slipgate-claude-device:" + anchor))
	accUUID := DeterministicUUID("slipgate-claude-acc", anchor)
	sessUUID := DeterministicUUID("slipgate-claude-sess", anchor)
	return fmt.Sprintf("user_%s_account_%s_session_%s", hex.EncodeToString(deviceHash[:]), accUUID, sessUUID)
}

// CodexSessionUUID derives a stable per-account/per-VM Codex CLI session UUID.
func CodexSessionUUID(accountID, guestMachineID string) string {
	return DeterministicUUID("slipgate-codex-session", strings.TrimSpace(accountID)+"|"+strings.TrimSpace(guestMachineID))
}

// AntigravityAgentRequestID builds an `agent-<uuid>` request identifier matching Antigravity Cloud Code wire traffic.
func AntigravityAgentRequestID(accountID, requestID string) string {
	return "agent-" + DeterministicUUID("slipgate-ag-req", strings.TrimSpace(accountID)+"|"+strings.TrimSpace(requestID))
}

// StripAntigravityModelPrefix removes leading `antigravity/` or `ag-` routing namespaces before upstream dispatch.
func StripAntigravityModelPrefix(model string) string {
	trimmed := strings.TrimSpace(model)
	if strings.HasPrefix(strings.ToLower(trimmed), "antigravity/") {
		return trimmed[len("antigravity/"):]
	}
	return trimmed
}

// ApplyClaudeSubscriptionHeaders sets official Claude Code 2.1 CLI + Stainless headers and removes
// x-api-key. callerBeta is the caller's own anthropic-beta: its opt-ins (1M context, files, ...)
// follow the Claude Code set, since the request body may depend on them.
func ApplyClaudeSubscriptionHeaders(req *http.Request, secret AccountSecret, callerBeta string) {
	req.Header.Del("x-api-key")
	if secret.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+secret.APIKey)
	}
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-beta", mergeHeaderTokens(claudeCodeBetaHeader, sanitizeHeaderToken(callerBeta)))
	req.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	req.Header.Set("x-app", "cli")
	req.Header.Set("User-Agent", claudeCLIUserAgent)
	req.Header.Set("X-Stainless-Lang", "js")
	req.Header.Set("X-Stainless-Package-Version", "0.55.1")
	req.Header.Set("X-Stainless-OS", "Linux")
	req.Header.Set("X-Stainless-Arch", "x64")
	req.Header.Set("X-Stainless-Runtime", "bun")
	req.Header.Set("X-Stainless-Runtime-Version", "1.2.9")
	req.Header.Set("X-Stainless-Retry-Count", "0")
}

// mergeHeaderTokens joins comma-separated token lists, keeping the first occurrence of each token
// (case-insensitively) in order.
func mergeHeaderTokens(lists ...string) string {
	seen := make(map[string]bool)
	var out []string
	for _, list := range lists {
		for _, tok := range strings.Split(list, ",") {
			tok = strings.TrimSpace(tok)
			if key := strings.ToLower(tok); tok != "" && !seen[key] {
				seen[key] = true
				out = append(out, tok)
			}
		}
	}
	return strings.Join(out, ",")
}

// ApplyCodexSubscriptionHeaders sets official OpenAI Codex CLI Rust headers (`originator`, `session_id`, `chatgpt-account-id`).
func ApplyCodexSubscriptionHeaders(req *http.Request, pctx OutboundPersonaContext, secret AccountSecret) {
	if secret.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+secret.APIKey)
	}
	sessID := CodexSessionUUID(pctx.AccountID, pctx.GuestMachineID)
	req.Header.Set("originator", "codex_cli_rs")
	req.Header.Set("OpenAI-Beta", "responses=experimental")
	req.Header.Set("session_id", sessID)
	req.Header.Set("Conversation_id", sessID)
	req.Header.Set("User-Agent", codexCLIUserAgent)
	req.Header.Set("Accept", "text/event-stream")
	if strings.TrimSpace(secret.ChatGPTAccountID) != "" {
		req.Header.Set("chatgpt-account-id", strings.TrimSpace(secret.ChatGPTAccountID))
	}
	if strings.TrimSpace(secret.OrganizationID) != "" {
		req.Header.Set("OpenAI-Organization", strings.TrimSpace(secret.OrganizationID))
	}
}

// ApplyAntigravityHeaders sets Cloud Code v1internal / Antigravity IDE headers.
func ApplyAntigravityHeaders(req *http.Request, pctx OutboundPersonaContext, secret AccountSecret) {
	req.Header.Del("x-goog-api-key")
	if secret.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+secret.APIKey)
	}
	req.Header.Set("User-Agent", antigravityUserAgent)
	req.Header.Set("X-Goog-Api-Client", "gl-node/22.14.0 antigravity/1.15.8")
	req.Header.Set("Client-Metadata", `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}`)
	if strings.TrimSpace(pctx.GuestMachineID) != "" {
		req.Header.Set("X-Goog-Device-Id", strings.TrimSpace(pctx.GuestMachineID))
	}
}

// SanitizeOutboundHeaders strips proxy-forwarding headers so downstream client network metadata never leaks upstream.
func SanitizeOutboundHeaders(h http.Header) {
	for _, k := range []string{
		"X-Forwarded-For",
		"X-Forwarded-Host",
		"X-Forwarded-Proto",
		"X-Real-IP",
		"Forwarded",
		"Via",
		"CF-Connecting-IP",
		"True-Client-IP",
	} {
		h.Del(k)
	}
}

// EncodeCodexResponsesRequestBody builds a native OpenAI/ChatGPT Codex Responses API payload.
func EncodeCodexResponsesRequestBody(model string, turn *CanonicalTurn, tools []CanonicalTool, forceStream bool) ([]byte, error) {
	instructions := strings.TrimSpace(turn.SystemPrompt)
	if instructions == "" {
		instructions = "You are a helpful assistant."
	}

	inputItems := make([]map[string]any, 0, max(1, len(turn.Messages)))
	for _, m := range turn.Messages {
		switch m.Role {
		case "tool":
			inputItems = append(inputItems, map[string]any{
				"type":    "function_call_output",
				"call_id": firstNonEmpty(m.ToolCallID, "call_1"),
				"output":  m.Content,
			})
		case "assistant":
			if m.Content != "" || len(m.ToolCalls) == 0 {
				inputItems = append(inputItems, map[string]any{
					"type": "message",
					"role": "assistant",
					"content": []map[string]any{
						{"type": "output_text", "text": m.Content},
					},
				})
			}
			for _, tc := range m.ToolCalls {
				inputItems = append(inputItems, map[string]any{
					"type":      "function_call",
					"call_id":   firstNonEmpty(tc.ID, "call_1"),
					"name":      tc.Name,
					"arguments": defaultJSONObject(tc.Arguments),
				})
			}
		default:
			inputItems = append(inputItems, map[string]any{
				"type":    "message",
				"role":    "user",
				"content": codexInputContent(m),
			})
		}
	}
	if len(inputItems) == 0 {
		inputItems = append(inputItems, map[string]any{
			"type": "message",
			"role": "user",
			"content": []map[string]any{
				{"type": "input_text", "text": "Hello"},
			},
		})
	}

	payload := map[string]any{
		"model":               model,
		"instructions":        instructions,
		"input":               inputItems,
		"parallel_tool_calls": true,
		"store":               false,
		"stream":              turn.Stream || forceStream,
	}
	if turn.Temperature != nil {
		payload["temperature"] = *turn.Temperature
	}
	// Codex CLI asks for reasoning summaries and, with store=false, the encrypted reasoning that
	// lets a stateless conversation continue. Non-reasoning models reject the parameter.
	if effort := codexReasoningEffort(turn); effort != "" && (forceStream || isOpenAIReasoningModel(model)) {
		reasoning := map[string]any{"effort": effort}
		if effort != "none" {
			reasoning["summary"] = "auto"
		}
		payload["reasoning"] = reasoning
		payload["include"] = []string{"reasoning.encrypted_content"}
	}
	if tier := openAIServiceTier(turn.ServiceTier); tier != "" {
		payload["service_tier"] = tier
	}
	// The caller's session keeps hitting one prompt cache; derived, so its own identifiers stay here.
	if hint := strings.TrimSpace(turn.SessionHint); hint != "" {
		payload["prompt_cache_key"] = DeterministicUUID("slipgate-codex-cache", hint)
	}
	if len(tools) > 0 {
		respTools := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			respTools = append(respTools, map[string]any{
				"type":        "function",
				"name":        t.Name,
				"description": t.Description,
				"parameters":  ensureSchema(t.Parameters),
			})
		}
		payload["tools"] = respTools
		payload["tool_choice"] = "auto"
	}
	return json.Marshal(payload)
}

// codexReasoningEffort is the caller's reasoning effort in Responses terms ("max" is xhigh there),
// or the one its thinking budget implies; "" leaves the upstream default.
func codexReasoningEffort(turn *CanonicalTurn) string {
	switch e := firstNonEmpty(turn.ReasoningEffort, reasoningEffortForBudget(turn.ThinkingBudget)); e {
	case "max":
		return "xhigh"
	default:
		return e
	}
}

// codexInputContent renders a user message as Responses input parts, images and files included.
func codexInputContent(m CanonicalMessage) []map[string]any {
	if !hasMediaParts(m.Parts) {
		return []map[string]any{{"type": "input_text", "text": m.Content}}
	}
	out := make([]map[string]any, 0, len(m.Parts))
	for _, p := range m.Parts {
		switch p.Type {
		case partText:
			out = append(out, map[string]any{"type": "input_text", "text": p.Text})
		case partImage:
			out = append(out, map[string]any{"type": "input_image", "image_url": partDataURL(p)})
		case partDocument:
			if p.Data != "" {
				out = append(out, map[string]any{"type": "input_file", "filename": "document.pdf", "file_data": partDataURL(p)})
			} else {
				out = append(out, map[string]any{"type": "input_text", "text": "[document: " + p.URL + "]"})
			}
		}
	}
	if len(out) == 0 {
		out = append(out, map[string]any{"type": "input_text", "text": m.Content})
	}
	return out
}

// EncodeAntigravityRequestBody wraps a Gemini request payload inside Antigravity Cloud Code's v1internal envelope.
func EncodeAntigravityRequestBody(upstreamModel string, pctx OutboundPersonaContext, secret AccountSecret, turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	innerRaw, err := encodeGeminiRequestBody(turn, tools)
	if err != nil {
		return nil, err
	}
	var innerObj map[string]any
	if err := json.Unmarshal(innerRaw, &innerObj); err != nil {
		return nil, err
	}
	proj := firstNonEmpty(secret.ProjectID, defaultAntigravityProj)
	envelope := map[string]any{
		"project":   proj,
		"model":     StripAntigravityModelPrefix(upstreamModel),
		"userAgent": "antigravity",
		"requestId": AntigravityAgentRequestID(pctx.AccountID, pctx.RequestID),
		"request":   innerObj,
	}
	return json.Marshal(envelope)
}
