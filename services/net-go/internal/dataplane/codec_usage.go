package dataplane

import "strings"

// Canonical stop reasons shared by every codec; each wire protocol maps to and from these.
const (
	stopEnd      = "end"
	stopLength   = "length"
	stopTool     = "tool"
	stopSequence = "stop_sequence"
	stopFilter   = "content_filter"
	stopRefusal  = "refusal"
)

// canonicalUsage follows Anthropic semantics: InputTokens excludes cache reads and writes, and
// ReasoningTokens is the part of OutputTokens spent on thinking. The Seen flags record whether
// upstream reported a side at all, so estimates are only used when it did not.
type canonicalUsage struct {
	InputTokens      uint64
	OutputTokens     uint64
	CacheReadTokens  uint64
	CacheWriteTokens uint64
	ReasoningTokens  uint64
	InputSeen        bool
	OutputSeen       bool
}

func (u *canonicalUsage) merge(o canonicalUsage) {
	if o.InputSeen {
		u.InputTokens = o.InputTokens
		u.CacheReadTokens = o.CacheReadTokens
		u.CacheWriteTokens = o.CacheWriteTokens
		u.InputSeen = true
	}
	if o.OutputSeen {
		u.OutputTokens = o.OutputTokens
		u.ReasoningTokens = o.ReasoningTokens
		u.OutputSeen = true
	}
}

// promptTotal is the OpenAI/Gemini notion of prompt tokens, which includes cached input.
func (u canonicalUsage) promptTotal() uint64 {
	return u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens
}

// inputFromInclusivePrompt converts OpenAI/Gemini counts, where the prompt total already contains
// the cached tokens, into canonical uncached input plus cache reads.
func inputFromInclusivePrompt(prompt, cached uint64) canonicalUsage {
	cached = min(cached, prompt)
	return canonicalUsage{InputTokens: prompt - cached, CacheReadTokens: cached, InputSeen: true}
}

func stopFromAnthropic(reason string) string {
	switch reason {
	case "max_tokens", "model_context_window_exceeded":
		return stopLength
	case "tool_use":
		return stopTool
	case "stop_sequence":
		return stopSequence
	case "refusal":
		return stopRefusal
	case "":
		return ""
	default:
		return stopEnd
	}
}

func stopFromOpenAI(reason string) string {
	switch reason {
	case "length":
		return stopLength
	case "tool_calls", "function_call":
		return stopTool
	case "content_filter":
		return stopFilter
	case "":
		return ""
	default:
		return stopEnd
	}
}

func stopFromGemini(reason string) string {
	switch strings.ToUpper(reason) {
	case "MAX_TOKENS":
		return stopLength
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY":
		return stopFilter
	case "":
		return ""
	default:
		return stopEnd
	}
}

func stopFromResponsesIncomplete(reason string) string {
	if reason == "content_filter" {
		return stopFilter
	}
	return stopLength
}

func anthropicStopReason(stop string) string {
	switch stop {
	case stopLength:
		return "max_tokens"
	case stopTool:
		return "tool_use"
	case stopSequence:
		return "stop_sequence"
	case stopFilter, stopRefusal:
		return "refusal"
	default:
		return "end_turn"
	}
}

func openAIFinishReason(stop string) string {
	switch stop {
	case stopLength:
		return "length"
	case stopTool:
		return "tool_calls"
	case stopFilter, stopRefusal:
		return "content_filter"
	default:
		return "stop"
	}
}

func geminiFinishReason(stop string) string {
	switch stop {
	case stopLength:
		return "MAX_TOKENS"
	case stopFilter, stopRefusal:
		return "SAFETY"
	default:
		return "STOP"
	}
}

func anthropicUsageJSON(u canonicalUsage) map[string]any {
	return map[string]any{
		"input_tokens":                u.InputTokens,
		"output_tokens":               u.OutputTokens,
		"cache_read_input_tokens":     u.CacheReadTokens,
		"cache_creation_input_tokens": u.CacheWriteTokens,
	}
}

func openAIChatUsageJSON(u canonicalUsage) map[string]any {
	prompt := u.promptTotal()
	return map[string]any{
		"prompt_tokens":             prompt,
		"completion_tokens":         u.OutputTokens,
		"total_tokens":              prompt + u.OutputTokens,
		"prompt_tokens_details":     map[string]any{"cached_tokens": u.CacheReadTokens},
		"completion_tokens_details": map[string]any{"reasoning_tokens": u.ReasoningTokens},
	}
}

func responsesUsageJSON(u canonicalUsage) map[string]any {
	prompt := u.promptTotal()
	return map[string]any{
		"input_tokens":          prompt,
		"input_tokens_details":  map[string]any{"cached_tokens": u.CacheReadTokens},
		"output_tokens":         u.OutputTokens,
		"output_tokens_details": map[string]any{"reasoning_tokens": u.ReasoningTokens},
		"total_tokens":          prompt + u.OutputTokens,
	}
}

func geminiUsageJSON(u canonicalUsage) map[string]any {
	prompt := u.promptTotal()
	out := map[string]any{
		"promptTokenCount":     prompt,
		"candidatesTokenCount": u.OutputTokens - min(u.ReasoningTokens, u.OutputTokens),
		"totalTokenCount":      prompt + u.OutputTokens,
	}
	if u.ReasoningTokens > 0 {
		out["thoughtsTokenCount"] = u.ReasoningTokens
	}
	if u.CacheReadTokens > 0 {
		out["cachedContentTokenCount"] = u.CacheReadTokens
	}
	return out
}

// anthropicErrorType keeps a valid Anthropic error type, deriving one from the status otherwise,
// because Anthropic SDKs and Claude Code branch on error.type.
func anthropicErrorType(errType string, status int) string {
	switch errType {
	case "invalid_request_error", "authentication_error", "billing_error", "permission_error",
		"not_found_error", "request_too_large", "rate_limit_error", "api_error", "timeout_error", "overloaded_error":
		return errType
	}
	switch {
	case status == 401:
		return "authentication_error"
	case status == 402:
		return "billing_error"
	case status == 403:
		return "permission_error"
	case status == 404:
		return "not_found_error"
	case status == 413:
		return "request_too_large"
	case status == 429:
		return "rate_limit_error"
	case status == 504:
		return "timeout_error"
	case status == 503 || status == 529:
		return "overloaded_error"
	case status >= 500:
		return "api_error"
	default:
		return "invalid_request_error"
	}
}

// statusForAnthropicErrorType maps an in-stream Anthropic error event to an HTTP status.
func statusForAnthropicErrorType(errType string) int {
	switch errType {
	case "invalid_request_error":
		return 400
	case "authentication_error":
		return 401
	case "billing_error":
		return 402
	case "permission_error":
		return 403
	case "not_found_error":
		return 404
	case "request_too_large":
		return 413
	case "rate_limit_error":
		return 429
	case "timeout_error":
		return 504
	case "overloaded_error":
		return 529
	default:
		return 500
	}
}
