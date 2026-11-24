package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CodecKind identifies an AI wire protocol on either ingress or upstream egress.
type CodecKind string

const (
	CodecOpenAIChat           CodecKind = "openai_chat"
	CodecOpenAIResponses      CodecKind = "openai_responses"
	CodecAnthropicMessages    CodecKind = "anthropic_messages"
	CodecAnthropicCountTokens CodecKind = "anthropic_count_tokens"
	CodecGeminiGenerate       CodecKind = "gemini"
	CodecAntigravityInternal  CodecKind = "antigravity_internal"
	CodecMCPJSONRPC           CodecKind = "mcp_jsonrpc"
)

var internalCLITools = map[string]bool{
	"Bash":              true,
	"Read":              true,
	"Write":             true,
	"Edit":              true,
	"Glob":              true,
	"Grep":              true,
	"NotebookEdit":      true,
	"apply_patch":       true,
	"exec_command":      true,
	"write_stdin":       true,
	"update_plan":       true,
	"view_file_outline": true,
	"run_command":       true,
	"browser_subagent":  true,
}

// IsInternalCLITool reports whether toolName is a host/CLI/IDE internal tool guarded under Zero-Injection mode.
func IsInternalCLITool(toolName string) bool {
	return internalCLITools[strings.TrimSpace(toolName)]
}

// ShouldStripInternalTool mirrors services/core-zig/src/guardrail/risk_gate.zig shouldStripInternalTool.
func ShouldStripInternalTool(cleanseMode, toolName string, callerDeclared map[string]bool) bool {
	if !strings.EqualFold(strings.TrimSpace(cleanseMode), "zero") && strings.TrimSpace(cleanseMode) != "" {
		return false
	}
	trimmed := strings.TrimSpace(toolName)
	if !IsInternalCLITool(trimmed) {
		return false
	}
	if callerDeclared != nil && callerDeclared[trimmed] {
		return false
	}
	return true
}

// CanonicalToolCall represents a provider-neutral function/tool invocation.
type CanonicalToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// CanonicalPart is one ordered piece of message content: text, an image, or a document (PDF).
// Media carries either inline base64 Data with its MediaType, or a remote URL.
type CanonicalPart struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	Data      string `json:"data,omitempty"`
	URL       string `json:"url,omitempty"`
}

// CanonicalThinking is one assistant reasoning block. Anthropic requires signed blocks to be
// replayed verbatim on the next turn of a tool loop; Redacted holds redacted_thinking data.
type CanonicalThinking struct {
	Text      string `json:"text,omitempty"`
	Signature string `json:"signature,omitempty"`
	Redacted  string `json:"redacted,omitempty"`
}

// CanonicalMessage represents a provider-neutral conversation message. Content is always the
// joined text; Parts is set only when the message also carries images or documents.
type CanonicalMessage struct {
	Role       string              `json:"role"`
	Content    string              `json:"content"`
	Parts      []CanonicalPart     `json:"parts,omitempty"`
	Thinking   []CanonicalThinking `json:"thinking,omitempty"`
	ToolCalls  []CanonicalToolCall `json:"toolCalls,omitempty"`
	ToolCallID string              `json:"toolCallId,omitempty"`
	ToolName   string              `json:"toolName,omitempty"`
	IsError    bool                `json:"isError,omitempty"`
}

// CanonicalTool represents a caller-declared tool schema.
type CanonicalTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// CanonicalToolChoice is the caller's tool_choice: Mode is auto, none, required or tool (with Name).
type CanonicalToolChoice struct {
	Mode string `json:"mode"`
	Name string `json:"name,omitempty"`
}

// CanonicalResponseFormat is a structured-output request: json_object or json_schema.
type CanonicalResponseFormat struct {
	Type   string          `json:"type"`
	Name   string          `json:"name,omitempty"`
	Schema json.RawMessage `json:"schema,omitempty"`
	Strict bool            `json:"strict,omitempty"`
}

// CanonicalTurn holds the parsed ingress request across OpenAI, Anthropic, Gemini, and MCP.
type CanonicalTurn struct {
	IngressCodec         CodecKind
	PublicModel          string
	Stream               bool
	MaxTokens            uint64
	MaxTokensSet         bool
	Temperature          *float64
	TopP                 *float64
	TopK                 *int
	StopSequences        []string
	ToolChoice           *CanonicalToolChoice
	ParallelToolCalls    *bool
	ResponseFormat       *CanonicalResponseFormat
	ReasoningEffort      string
	ServiceTier          string
	PreviousResponseID   string
	SessionHint          string
	ImageCount           uint32
	VideoSeconds         uint32
	MultipartContentType string
	ThinkingBudget       uint64
	ThinkingAdaptive     bool
	IncludeUsage         bool
	SystemPrompt         string
	Messages             []CanonicalMessage
	Tools                []CanonicalTool
	CallerDeclaredTools  map[string]bool
	EstimatedInputTokens uint64
	BodyExcerpt          string

	// RawBody is the caller's original JSON, forwarded as-is when both sides speak the same protocol.
	RawBody []byte
	// AnthropicVersion and AnthropicBeta are the caller's headers, replayed on native Anthropic passthrough.
	AnthropicVersion string
	AnthropicBeta    string
	// NativePassthrough is set by BuildUpstreamHTTPRequestWithPersona when RawBody was forwarded.
	NativePassthrough bool
	// UpstreamServiceTier is the service tier the upstream request actually carries (set by
	// BuildUpstreamHTTPRequestWithPersona); only that tier is billed.
	UpstreamServiceTier string
	// AnthropicServerTools are the caller's Anthropic-defined tool declarations (web_search, bash,
	// code_execution, ...) verbatim: replayed to Anthropic, which runs them, and dropped elsewhere.
	AnthropicServerTools []json.RawMessage

	MCPMethod string
	MCPID     json.RawMessage
}

// RelayMetrics captures post-turn token accounting, latency, and quota watermark updates.
type RelayMetrics struct {
	UpstreamStatus        int
	InputTokens           uint64
	OutputTokens          uint64
	CacheReadTokens       uint64
	CacheWriteTokens      uint64
	ImageCount            uint32
	VideoSeconds          uint32
	Window5hUsedBps       uint16
	Window7dUsedBps       uint16
	Window5hResetAtUnixMs int64
	Window7dResetAtUnixMs int64
	CooldownDurationMs    uint64
	TTFTMs                uint32
	EgressCodec           CodecKind
	ErrorType             string
	ErrorCode             string
	ErrorMessage          string
	ErrorBody             string
}

// canonicalResult is one complete assistant turn decoded from any upstream protocol. StopReason
// uses the canonical stop constants.
type canonicalResult struct {
	ID           string
	Thinking     []CanonicalThinking
	Text         string
	ToolCalls    []CanonicalToolCall
	StopReason   string
	StopSequence string
	Usage        canonicalUsage
}

// DetectIngressCodec maps an incoming HTTP path and query string to its AI wire protocol.
func DetectIngressCodec(path, rawQuery string) (codec CodecKind, pathModel string, pathStream bool) {
	switch {
	case strings.HasPrefix(path, "/v1/messages/count_tokens"):
		return CodecAnthropicCountTokens, "", false
	case strings.HasPrefix(path, "/v1/messages"):
		return CodecAnthropicMessages, "", false
	case strings.HasPrefix(path, "/v1/responses"):
		return CodecOpenAIResponses, "", false
	case strings.HasPrefix(path, "/v1beta/models/"):
		rest := strings.TrimPrefix(path, "/v1beta/models/")
		model := rest
		stream := false
		if idx := strings.IndexByte(rest, ':'); idx >= 0 {
			model = rest[:idx]
			action := rest[idx+1:]
			if strings.EqualFold(action, "streamGenerateContent") {
				stream = true
			}
		}
		if strings.Contains(strings.ToLower(rawQuery), "alt=sse") {
			stream = true
		}
		return CodecGeminiGenerate, strings.TrimSpace(model), stream
	case path == "/mcp" || strings.HasPrefix(path, "/mcp/"):
		return CodecMCPJSONRPC, "", false
	default:
		return CodecOpenAIChat, "", false
	}
}

// ProviderEgressCodec chooses the native wire protocol for the resolved upstream provider.
func ProviderEgressCodec(provider string, ingress CodecKind) CodecKind {
	return ProviderEgressCodecWithPersona(OutboundPersonaContext{Provider: provider}, AccountSecret{}, ingress)
}

// ProviderEgressCodecWithPersona selects the exact native upstream wire codec including Codex Responses and Antigravity Cloud Code v1internal.
func ProviderEgressCodecWithPersona(pctx OutboundPersonaContext, secret AccountSecret, ingress CodecKind) CodecKind {
	if ingress == CodecAnthropicCountTokens {
		return CodecAnthropicCountTokens
	}
	if IsAntigravitySubscription(pctx) {
		return CodecAntigravityInternal
	}
	if IsCodexSubscription(pctx, secret) {
		return CodecOpenAIResponses
	}
	// Responses callers on an OpenAI API key talk to OpenAI's own /v1/responses (forwarded verbatim)
	// instead of being down-converted to Chat Completions.
	if ingress == CodecOpenAIResponses && strings.EqualFold(strings.TrimSpace(pctx.Provider), "openai") &&
		!strings.EqualFold(pctx.ExecutionMode, "vm_slot") && isOfficialOpenAIBase(secret.BaseURL) {
		return CodecOpenAIResponses
	}
	if mpEgress, _, _, _, ok := resolveMultiProtocolRoute(pctx.Provider, secret, ingress, "", pctx.CatalogProtocols); ok {
		return mpEgress
	}
	switch strings.ToLower(strings.TrimSpace(pctx.Provider)) {
	case "anthropic":
		return CodecAnthropicMessages
	case "gemini":
		return CodecGeminiGenerate
	case "bedrock":
		return CodecBedrockConverse
	default:
		return CodecOpenAIChat
	}
}

// ParseIngressRequest decodes a DataPlane request body into a CanonicalTurn.
func ParseIngressRequest(path, rawQuery string, body []byte) (*CanonicalTurn, error) {
	codec, pathModel, pathStream := DetectIngressCodec(path, rawQuery)
	turn := &CanonicalTurn{
		IngressCodec:        codec,
		PublicModel:         pathModel,
		Stream:              pathStream,
		CallerDeclaredTools: make(map[string]bool),
	}

	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		turn.EstimatedInputTokens = 16
		return turn, nil
	}
	turn.RawBody = trimmed

	switch codec {
	case CodecOpenAIChat:
		if err := parseOpenAIChat(trimmed, turn); err != nil {
			return nil, err
		}
	case CodecOpenAIResponses:
		if err := parseOpenAIResponses(trimmed, turn); err != nil {
			return nil, err
		}
	case CodecAnthropicMessages, CodecAnthropicCountTokens:
		if err := parseAnthropicMessages(trimmed, turn); err != nil {
			return nil, err
		}
	case CodecGeminiGenerate:
		if err := parseGeminiGenerate(trimmed, turn); err != nil {
			return nil, err
		}
	case CodecMCPJSONRPC:
		if err := parseMCPJSONRPC(trimmed, turn); err != nil {
			return nil, err
		}
	}

	var textBuilder strings.Builder
	if turn.SystemPrompt != "" {
		textBuilder.WriteString(turn.SystemPrompt)
		textBuilder.WriteByte('\n')
	}
	// Inline media is billed per image/page, not per base64 byte: take it out of the byte-based
	// estimate and charge a flat allowance per part instead.
	mediaBytes, mediaParts := 0, 0
	for _, m := range turn.Messages {
		textBuilder.WriteString(m.Content)
		textBuilder.WriteByte('\n')
		for _, p := range m.Parts {
			if p.Type != partText {
				mediaParts++
				mediaBytes += len(p.Data)
			}
		}
	}
	combinedText := textBuilder.String()
	rawBytes := max(0, len(trimmed)-mediaBytes)
	turn.EstimatedInputTokens = uint64(max(16, (len(combinedText)+rawBytes/4+3)/4+mediaParts*1600))

	const maxTextExcerpt = 48 * 1024
	const maxRawTail = 16 * 1024
	textSample := combinedText
	if len(textSample) > maxTextExcerpt {
		half := maxTextExcerpt / 2
		textSample = textSample[:half] + "\n...\n" + textSample[len(textSample)-half:]
	}
	rawSample := string(trimmed)
	if len(rawSample) > maxRawTail {
		rawSample = rawSample[len(rawSample)-maxRawTail:]
	}
	turn.BodyExcerpt = textSample + "\n" + rawSample
	return turn, nil
}

func parseOpenAIChat(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model         string `json:"model"`
		Stream        bool   `json:"stream"`
		StreamOptions *struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
		MaxTokens           uint64          `json:"max_tokens"`
		MaxCompletionTokens uint64          `json:"max_completion_tokens"`
		Temperature         *float64        `json:"temperature"`
		TopP                *float64        `json:"top_p"`
		Stop                json.RawMessage `json:"stop"`
		ToolChoice          json.RawMessage `json:"tool_choice"`
		ParallelToolCalls   *bool           `json:"parallel_tool_calls"`
		ResponseFormat      json.RawMessage `json:"response_format"`
		ReasoningEffort     string          `json:"reasoning_effort"`
		ServiceTier         string          `json:"service_tier"`
		PromptCacheKey      string          `json:"prompt_cache_key"`
		User                string          `json:"user"`
		Messages            []openAIMessage `json:"messages"`
		Tools               []struct {
			Type     string `json:"type"`
			Function struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			} `json:"function"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid OpenAI chat JSON: %w", err)
	}
	if strings.TrimSpace(payload.Model) != "" {
		turn.PublicModel = strings.TrimSpace(payload.Model)
	}
	turn.Stream = payload.Stream
	turn.IncludeUsage = payload.StreamOptions != nil && payload.StreamOptions.IncludeUsage
	if payload.MaxCompletionTokens > 0 {
		turn.MaxTokens = payload.MaxCompletionTokens
	} else if payload.MaxTokens > 0 {
		turn.MaxTokens = payload.MaxTokens
	}
	turn.MaxTokensSet = turn.MaxTokens > 0
	turn.Temperature = payload.Temperature
	turn.TopP = payload.TopP
	turn.StopSequences = parseStopField(payload.Stop)
	turn.ToolChoice = parseOpenAIToolChoice(payload.ToolChoice)
	turn.ParallelToolCalls = payload.ParallelToolCalls
	turn.ResponseFormat = parseOpenAIResponseFormat(payload.ResponseFormat)
	turn.ReasoningEffort = normalizeReasoningEffort(payload.ReasoningEffort)
	turn.ServiceTier = normalizeServiceTier(payload.ServiceTier)
	turn.SessionHint = firstNonEmpty(payload.PromptCacheKey, payload.User)

	var sysParts []string
	for _, msg := range payload.Messages {
		text, parts := parseContentBlocks(msg.Content)
		role := strings.ToLower(strings.TrimSpace(msg.Role))
		if role == "system" || role == "developer" {
			if text != "" {
				sysParts = append(sysParts, text)
			}
			continue
		}
		cm := CanonicalMessage{
			Role:       normalizeRole(role),
			Content:    text,
			Parts:      parts,
			ToolCallID: msg.ToolCallID,
		}
		if cm.Role == "tool" {
			cm.ToolName = msg.Name
		}
		for _, tc := range msg.ToolCalls {
			cm.ToolCalls = append(cm.ToolCalls, CanonicalToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: defaultJSONObject(tc.Function.Arguments),
			})
		}
		turn.Messages = append(turn.Messages, cm)
	}
	turn.SystemPrompt = strings.Join(sysParts, "\n\n")

	for _, t := range payload.Tools {
		addCallerTool(turn, t.Function.Name, t.Function.Description, t.Function.Parameters)
	}
	return nil
}

type openAIMessage struct {
	Role       string          `json:"role"`
	Name       string          `json:"name"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"tool_call_id"`
	ToolCalls  []struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	} `json:"tool_calls"`
}

// responsesInputItem is one entry of a Responses `input` array. Content and Output stay raw because
// each may be a string or an array of parts.
type responsesInputItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments string          `json:"arguments"`
	Output    json.RawMessage `json:"output"`
}

func parseOpenAIResponses(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model             string          `json:"model"`
		Stream            bool            `json:"stream"`
		MaxOutputTokens   uint64          `json:"max_output_tokens"`
		Temperature       *float64        `json:"temperature"`
		TopP              *float64        `json:"top_p"`
		Instructions       string          `json:"instructions"`
		PreviousResponseID string          `json:"previous_response_id"`
		ServiceTier        string          `json:"service_tier"`
		PromptCacheKey     string          `json:"prompt_cache_key"`
		Input              json.RawMessage `json:"input"`
		ToolChoice        json.RawMessage `json:"tool_choice"`
		ParallelToolCalls *bool           `json:"parallel_tool_calls"`
		Text              *struct {
			Format json.RawMessage `json:"format"`
		} `json:"text"`
		Reasoning *struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		Tools []struct {
			Type        string          `json:"type"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
			Function    *struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			} `json:"function"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid OpenAI responses JSON: %w", err)
	}
	if strings.TrimSpace(payload.Model) != "" {
		turn.PublicModel = strings.TrimSpace(payload.Model)
	}
	turn.Stream = payload.Stream
	if payload.MaxOutputTokens > 0 {
		turn.MaxTokens = payload.MaxOutputTokens
		turn.MaxTokensSet = true
	}
	turn.Temperature = payload.Temperature
	turn.TopP = payload.TopP
	turn.PreviousResponseID = strings.TrimSpace(payload.PreviousResponseID)
	turn.ServiceTier = normalizeServiceTier(payload.ServiceTier)
	turn.SessionHint = firstNonEmpty(payload.PromptCacheKey, payload.PreviousResponseID)
	turn.ToolChoice = parseOpenAIToolChoice(payload.ToolChoice)
	turn.ParallelToolCalls = payload.ParallelToolCalls
	if payload.Text != nil {
		turn.ResponseFormat = parseOpenAIResponseFormat(payload.Text.Format)
	}
	if payload.Reasoning != nil {
		turn.ReasoningEffort = normalizeReasoningEffort(payload.Reasoning.Effort)
	}

	var sysParts []string
	if s := strings.TrimSpace(payload.Instructions); s != "" {
		sysParts = append(sysParts, s)
	}
	if len(payload.Input) > 0 {
		var strInput string
		if err := json.Unmarshal(payload.Input, &strInput); err == nil {
			if strInput != "" {
				turn.Messages = append(turn.Messages, CanonicalMessage{Role: "user", Content: strInput})
			}
		} else {
			var rawItems []json.RawMessage
			if err := json.Unmarshal(payload.Input, &rawItems); err != nil {
				return fmt.Errorf("invalid OpenAI responses input: %w", err)
			}
			for _, rawItem := range rawItems {
				// Decode item by item so one unfamiliar entry never drops the whole conversation.
				var item responsesInputItem
				if json.Unmarshal(rawItem, &item) != nil {
					continue
				}
				switch item.Type {
				case "function_call":
					tc := CanonicalToolCall{ID: item.CallID, Name: item.Name, Arguments: defaultJSONObject(item.Arguments)}
					// Parallel calls arrive as consecutive items; keep them on one assistant message so
					// Chat and Anthropic upstreams see every call before the matching results.
					if n := len(turn.Messages); n > 0 && turn.Messages[n-1].Role == "assistant" {
						turn.Messages[n-1].ToolCalls = append(turn.Messages[n-1].ToolCalls, tc)
					} else {
						turn.Messages = append(turn.Messages, CanonicalMessage{Role: "assistant", ToolCalls: []CanonicalToolCall{tc}})
					}
				case "function_call_output":
					text, parts := parseContentBlocks(item.Output)
					turn.Messages = append(turn.Messages, CanonicalMessage{
						Role:       "tool",
						ToolCallID: item.CallID,
						Content:    text,
						Parts:      parts,
					})
				case "", "message":
					text, parts := parseContentBlocks(item.Content)
					role := strings.ToLower(strings.TrimSpace(item.Role))
					if role == "system" || role == "developer" {
						if text != "" {
							sysParts = append(sysParts, text)
						}
						continue
					}
					if text == "" && len(parts) == 0 {
						continue
					}
					turn.Messages = append(turn.Messages, CanonicalMessage{Role: normalizeRole(role), Content: text, Parts: parts})
				}
			}
		}
	}
	turn.SystemPrompt = strings.Join(sysParts, "\n\n")

	for _, t := range payload.Tools {
		if t.Type != "" && t.Type != "function" {
			continue // built-in tools (web_search, file_search, ...) only exist on OpenAI itself
		}
		if t.Function != nil && strings.TrimSpace(t.Name) == "" {
			addCallerTool(turn, t.Function.Name, t.Function.Description, t.Function.Parameters)
			continue
		}
		addCallerTool(turn, t.Name, t.Description, t.Parameters)
	}
	return nil
}

// anthropicBlock is one Anthropic message content block of any type.
type anthropicBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	Thinking  string          `json:"thinking"`
	Signature string          `json:"signature"`
	Data      string          `json:"data"`
	Source    *mediaSource    `json:"source"`
}

func parseAnthropicMessages(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model         string          `json:"model"`
		Stream        bool            `json:"stream"`
		MaxTokens     uint64          `json:"max_tokens"`
		Temperature   *float64        `json:"temperature"`
		TopP          *float64        `json:"top_p"`
		TopK          *int            `json:"top_k"`
		StopSequences []string        `json:"stop_sequences"`
		ServiceTier   string          `json:"service_tier"`
		Metadata      *struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
		System        json.RawMessage `json:"system"`
		Messages      []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
		Tools      []json.RawMessage `json:"tools"`
		ToolChoice *struct {
			Type                   string `json:"type"`
			Name                   string `json:"name"`
			DisableParallelToolUse bool   `json:"disable_parallel_tool_use"`
		} `json:"tool_choice"`
		Thinking *struct {
			Type         string `json:"type"`
			BudgetTokens uint64 `json:"budget_tokens"`
		} `json:"thinking"`
		OutputConfig *struct {
			Effort string `json:"effort"`
			Format *struct {
				Type   string          `json:"type"`
				Schema json.RawMessage `json:"schema"`
			} `json:"format"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid Anthropic messages JSON: %w", err)
	}
	if oc := payload.OutputConfig; oc != nil {
		turn.ReasoningEffort = normalizeReasoningEffort(oc.Effort)
		if oc.Format != nil && oc.Format.Type == "json_schema" && len(bytes.TrimSpace(oc.Format.Schema)) > 0 {
			turn.ResponseFormat = &CanonicalResponseFormat{Type: "json_schema", Name: "response", Schema: oc.Format.Schema}
		}
	}
	if strings.TrimSpace(payload.Model) != "" {
		turn.PublicModel = strings.TrimSpace(payload.Model)
	}
	if turn.IngressCodec != CodecAnthropicCountTokens {
		turn.Stream = payload.Stream
	}
	if payload.MaxTokens > 0 {
		turn.MaxTokens = payload.MaxTokens
		turn.MaxTokensSet = true
	}
	turn.Temperature = payload.Temperature
	turn.TopP = payload.TopP
	turn.TopK = payload.TopK
	turn.StopSequences = payload.StopSequences
	turn.ServiceTier = normalizeServiceTier(payload.ServiceTier)
	if payload.Metadata != nil {
		turn.SessionHint = strings.TrimSpace(payload.Metadata.UserID)
	}
	turn.SystemPrompt, _ = parseContentBlocks(payload.System)
	if tc := payload.ToolChoice; tc != nil {
		switch tc.Type {
		case "auto", "none":
			turn.ToolChoice = &CanonicalToolChoice{Mode: tc.Type}
		case "any":
			turn.ToolChoice = &CanonicalToolChoice{Mode: "required"}
		case "tool":
			if tc.Name != "" {
				turn.ToolChoice = &CanonicalToolChoice{Mode: "tool", Name: tc.Name}
			}
		}
		if tc.DisableParallelToolUse {
			parallel := false
			turn.ParallelToolCalls = &parallel
		}
	}
	if th := payload.Thinking; th != nil {
		switch th.Type {
		case "enabled":
			turn.ThinkingBudget = th.BudgetTokens
		case "adaptive", "between_tools":
			turn.ThinkingAdaptive = true
		}
	}

	for _, m := range payload.Messages {
		role := normalizeRole(m.Role)
		var str string
		if err := json.Unmarshal(m.Content, &str); err == nil {
			turn.Messages = append(turn.Messages, CanonicalMessage{Role: role, Content: str})
			continue
		}
		var rawBlocks []json.RawMessage
		if err := json.Unmarshal(m.Content, &rawBlocks); err != nil {
			continue
		}
		msg := CanonicalMessage{Role: role}
		var parts []CanonicalPart
		var toolResults []CanonicalMessage
		for _, rawBlock := range rawBlocks {
			var b anthropicBlock
			if json.Unmarshal(rawBlock, &b) != nil {
				continue
			}
			if isAnthropicServerBlock(b.Type) {
				parts = append(parts, CanonicalPart{Type: partAnthropicBlock, Data: string(rawBlock)})
				continue
			}
			switch b.Type {
			case "text", "image", "document":
				if p, ok := canonicalPartFromBlock(contentBlock{Type: b.Type, Text: b.Text, Source: b.Source}); ok {
					parts = append(parts, p)
				}
			case "tool_use":
				msg.ToolCalls = append(msg.ToolCalls, CanonicalToolCall{
					ID:        b.ID,
					Name:      b.Name,
					Arguments: defaultJSONObject(string(b.Input)),
				})
			case "tool_result":
				// Every tool_result becomes its own tool message: parallel tool calls answered in one
				// user turn must keep one result per tool_use id.
				text, resultParts := parseContentBlocks(b.Content)
				toolResults = append(toolResults, CanonicalMessage{
					Role:       "tool",
					ToolCallID: b.ToolUseID,
					Content:    text,
					Parts:      resultParts,
					IsError:    b.IsError,
				})
			case "thinking":
				msg.Thinking = append(msg.Thinking, CanonicalThinking{Text: b.Thinking, Signature: b.Signature})
			case "redacted_thinking":
				msg.Thinking = append(msg.Thinking, CanonicalThinking{Redacted: b.Data})
			}
		}
		turn.Messages = append(turn.Messages, toolResults...)
		msg.Content = joinPartText(parts)
		msg.Parts = compactParts(parts)
		if msg.Content != "" || len(msg.Parts) > 0 || len(msg.ToolCalls) > 0 || len(msg.Thinking) > 0 {
			turn.Messages = append(turn.Messages, msg)
		}
	}

	for _, rawTool := range payload.Tools {
		var t struct {
			Type        string          `json:"type"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"input_schema"`
		}
		if json.Unmarshal(rawTool, &t) != nil {
			continue
		}
		if t.Type != "" && t.Type != "custom" {
			// Anthropic-defined tools (web_search, bash, text_editor, ...) have no portable schema:
			// kept verbatim for Anthropic upstreams.
			if name := strings.TrimSpace(t.Name); name != "" {
				turn.CallerDeclaredTools[name] = true
			}
			turn.AnthropicServerTools = append(turn.AnthropicServerTools, rawTool)
			continue
		}
		addCallerTool(turn, t.Name, t.Description, t.InputSchema)
	}
	return nil
}

type geminiPart struct {
	Text       string `json:"text"`
	Thought    bool   `json:"thought"`
	InlineData *struct {
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	} `json:"inlineData"`
	FileData *struct {
		MimeType string `json:"mimeType"`
		FileURI  string `json:"fileUri"`
	} `json:"fileData"`
	FunctionCall *struct {
		ID   string          `json:"id"`
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	} `json:"functionCall"`
	FunctionResponse *struct {
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Response json.RawMessage `json:"response"`
	} `json:"functionResponse"`
}

func parseGeminiGenerate(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model             string `json:"model"`
		SystemInstruction *struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"systemInstruction"`
		Contents []struct {
			Role  string       `json:"role"`
			Parts []geminiPart `json:"parts"`
		} `json:"contents"`
		Tools []struct {
			FunctionDeclarations []struct {
				Name                 string          `json:"name"`
				Description          string          `json:"description"`
				Parameters           json.RawMessage `json:"parameters"`
				ParametersJSONSchema json.RawMessage `json:"parametersJsonSchema"`
			} `json:"functionDeclarations"`
		} `json:"tools"`
		ToolConfig *struct {
			FunctionCallingConfig *struct {
				Mode                 string   `json:"mode"`
				AllowedFunctionNames []string `json:"allowedFunctionNames"`
			} `json:"functionCallingConfig"`
		} `json:"toolConfig"`
		GenerationConfig *struct {
			MaxOutputTokens    uint64          `json:"maxOutputTokens"`
			Temperature        *float64        `json:"temperature"`
			TopP               *float64        `json:"topP"`
			TopK               *int            `json:"topK"`
			StopSequences      []string        `json:"stopSequences"`
			ResponseMimeType   string          `json:"responseMimeType"`
			ResponseSchema     json.RawMessage `json:"responseSchema"`
			ResponseJSONSchema json.RawMessage `json:"responseJsonSchema"`
			ThinkingConfig     *struct {
				ThinkingBudget int64 `json:"thinkingBudget"`
			} `json:"thinkingConfig"`
		} `json:"generationConfig"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid Gemini generateContent JSON: %w", err)
	}
	if turn.PublicModel == "" && strings.TrimSpace(payload.Model) != "" {
		turn.PublicModel = strings.TrimSpace(payload.Model)
	}
	if payload.SystemInstruction != nil {
		var parts []string
		for _, p := range payload.SystemInstruction.Parts {
			if p.Text != "" {
				parts = append(parts, p.Text)
			}
		}
		turn.SystemPrompt = strings.Join(parts, "\n")
	}
	if gc := payload.GenerationConfig; gc != nil {
		if gc.MaxOutputTokens > 0 {
			turn.MaxTokens = gc.MaxOutputTokens
			turn.MaxTokensSet = true
		}
		turn.Temperature = gc.Temperature
		turn.TopP = gc.TopP
		turn.TopK = gc.TopK
		turn.StopSequences = gc.StopSequences
		if strings.EqualFold(gc.ResponseMimeType, "application/json") {
			schema := gc.ResponseJSONSchema
			if len(bytes.TrimSpace(schema)) == 0 {
				schema = gc.ResponseSchema
			}
			if len(bytes.TrimSpace(schema)) > 0 {
				turn.ResponseFormat = &CanonicalResponseFormat{Type: "json_schema", Name: "response", Schema: schema}
			} else {
				turn.ResponseFormat = &CanonicalResponseFormat{Type: "json_object"}
			}
		}
		if gc.ThinkingConfig != nil && gc.ThinkingConfig.ThinkingBudget > 0 {
			turn.ThinkingBudget = uint64(gc.ThinkingConfig.ThinkingBudget)
		}
	}
	if tc := payload.ToolConfig; tc != nil && tc.FunctionCallingConfig != nil {
		fc := tc.FunctionCallingConfig
		switch strings.ToUpper(fc.Mode) {
		case "AUTO":
			turn.ToolChoice = &CanonicalToolChoice{Mode: "auto"}
		case "NONE":
			turn.ToolChoice = &CanonicalToolChoice{Mode: "none"}
		case "ANY":
			if len(fc.AllowedFunctionNames) == 1 {
				turn.ToolChoice = &CanonicalToolChoice{Mode: "tool", Name: fc.AllowedFunctionNames[0]}
			} else {
				turn.ToolChoice = &CanonicalToolChoice{Mode: "required"}
			}
		}
	}

	// Gemini pairs calls and responses by function name (optionally by id); give each call a
	// unique id and hand it to the next response with the same name.
	pending := make(map[string][]string)
	for ci, c := range payload.Contents {
		isModel := strings.EqualFold(c.Role, "model") || strings.EqualFold(c.Role, "assistant")
		msg := CanonicalMessage{Role: "user"}
		if isModel {
			msg.Role = "assistant"
		}
		var parts []CanonicalPart
		var toolResults []CanonicalMessage
		for pi, p := range c.Parts {
			switch {
			case p.FunctionCall != nil && p.FunctionCall.Name != "":
				id := firstNonEmpty(p.FunctionCall.ID, fmt.Sprintf("call_gem_%d_%d", ci, pi))
				pending[p.FunctionCall.Name] = append(pending[p.FunctionCall.Name], id)
				msg.ToolCalls = append(msg.ToolCalls, CanonicalToolCall{
					ID:        id,
					Name:      p.FunctionCall.Name,
					Arguments: defaultJSONObject(string(p.FunctionCall.Args)),
				})
			case p.FunctionResponse != nil:
				name := p.FunctionResponse.Name
				id := p.FunctionResponse.ID
				if queue := pending[name]; id == "" && len(queue) > 0 {
					id, pending[name] = queue[0], queue[1:]
				}
				toolResults = append(toolResults, CanonicalMessage{
					Role:       "tool",
					ToolCallID: firstNonEmpty(id, name),
					ToolName:   name,
					Content:    string(bytes.TrimSpace(p.FunctionResponse.Response)),
				})
			case p.Thought && p.Text != "":
				msg.Thinking = append(msg.Thinking, CanonicalThinking{Text: p.Text})
			case p.Text != "":
				parts = append(parts, CanonicalPart{Type: partText, Text: p.Text})
			case p.InlineData != nil && p.InlineData.Data != "":
				parts = append(parts, CanonicalPart{Type: geminiMediaKind(p.InlineData.MimeType), MediaType: p.InlineData.MimeType, Data: p.InlineData.Data})
			case p.FileData != nil && p.FileData.FileURI != "":
				parts = append(parts, CanonicalPart{Type: geminiMediaKind(p.FileData.MimeType), MediaType: p.FileData.MimeType, URL: p.FileData.FileURI})
			}
		}
		turn.Messages = append(turn.Messages, toolResults...)
		msg.Content = joinPartText(parts)
		msg.Parts = compactParts(parts)
		if msg.Content != "" || len(msg.Parts) > 0 || len(msg.ToolCalls) > 0 || len(msg.Thinking) > 0 {
			turn.Messages = append(turn.Messages, msg)
		}
	}
	for _, tg := range payload.Tools {
		for _, fd := range tg.FunctionDeclarations {
			params := fd.Parameters
			if len(bytes.TrimSpace(params)) == 0 {
				params = fd.ParametersJSONSchema
			}
			addCallerTool(turn, fd.Name, fd.Description, params)
		}
	}
	return nil
}

func geminiMediaKind(mimeType string) string {
	if strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return partImage
	}
	return partDocument
}

// addCallerTool registers a caller-declared function tool, ignoring nameless entries.
func addCallerTool(turn *CanonicalTurn, name, description string, params json.RawMessage) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	turn.CallerDeclaredTools[name] = true
	turn.Tools = append(turn.Tools, CanonicalTool{
		Name:        name,
		Description: description,
		Parameters:  ensureSchema(params),
	})
}

// parseStopField reads OpenAI's stop, which is a string or an array of strings.
func parseStopField(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var one string
	if json.Unmarshal(trimmed, &one) == nil {
		if one == "" {
			return nil
		}
		return []string{one}
	}
	var many []string
	if json.Unmarshal(trimmed, &many) != nil {
		return nil
	}
	out := make([]string, 0, len(many))
	for _, s := range many {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// parseOpenAIToolChoice reads string modes plus the Chat ({"type":"function","function":{"name"}})
// and Responses ({"type":"function","name"}) forced-function shapes.
func parseOpenAIToolChoice(raw json.RawMessage) *CanonicalToolChoice {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var mode string
	if json.Unmarshal(trimmed, &mode) == nil {
		switch mode {
		case "auto", "none", "required":
			return &CanonicalToolChoice{Mode: mode}
		}
		return nil
	}
	var obj struct {
		Type     string `json:"type"`
		Name     string `json:"name"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(trimmed, &obj) != nil {
		return nil
	}
	if name := firstNonEmpty(obj.Function.Name, obj.Name); obj.Type == "function" && name != "" {
		return &CanonicalToolChoice{Mode: "tool", Name: name}
	}
	return nil
}

// parseOpenAIResponseFormat reads Chat response_format and Responses text.format.
func parseOpenAIResponseFormat(raw json.RawMessage) *CanonicalResponseFormat {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var rf struct {
		Type       string          `json:"type"`
		Name       string          `json:"name"`
		Schema     json.RawMessage `json:"schema"`
		Strict     bool            `json:"strict"`
		JSONSchema *struct {
			Name   string          `json:"name"`
			Schema json.RawMessage `json:"schema"`
			Strict bool            `json:"strict"`
		} `json:"json_schema"`
	}
	if json.Unmarshal(raw, &rf) != nil {
		return nil
	}
	switch rf.Type {
	case "json_object":
		return &CanonicalResponseFormat{Type: "json_object"}
	case "json_schema":
		out := &CanonicalResponseFormat{Type: "json_schema", Name: rf.Name, Schema: rf.Schema, Strict: rf.Strict}
		if rf.JSONSchema != nil {
			out.Name, out.Schema, out.Strict = rf.JSONSchema.Name, rf.JSONSchema.Schema, rf.JSONSchema.Strict
		}
		if len(bytes.TrimSpace(out.Schema)) == 0 {
			out.Schema = nil
		}
		return out
	}
	return nil
}

func normalizeReasoningEffort(effort string) string {
	switch e := strings.ToLower(strings.TrimSpace(effort)); e {
	case "none", "minimal", "low", "medium", "high", "xhigh", "max":
		return e
	}
	return ""
}

// normalizeServiceTier drops tiers no upstream protocol defines: the value travels into the core
// hold, the price and the settlement record, so it must never be an arbitrary caller string.
func normalizeServiceTier(tier string) string {
	switch t := strings.ToLower(strings.TrimSpace(tier)); t {
	case "auto", "default", "flex", "priority", "scale", "fast", "standard_only":
		return t
	}
	return ""
}

func parseMCPJSONRPC(raw []byte, turn *CanonicalTurn) error {
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  struct {
			Model     string `json:"model"`
			MaxTokens uint64 `json:"maxTokens"`
			Prompt    string `json:"prompt"`
			Arguments struct {
				Model  string `json:"model"`
				Prompt string `json:"prompt"`
			} `json:"arguments"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &rpc); err != nil {
		return fmt.Errorf("invalid MCP JSON-RPC payload: %w", err)
	}
	turn.MCPMethod = strings.TrimSpace(rpc.Method)
	turn.MCPID = rpc.ID
	if len(turn.MCPID) == 0 {
		turn.MCPID = json.RawMessage("null")
	}

	model := firstNonEmpty(rpc.Params.Model, rpc.Params.Arguments.Model, "claude-sonnet-4-5")
	turn.PublicModel = model
	if rpc.Params.MaxTokens > 0 {
		turn.MaxTokens = rpc.Params.MaxTokens
	}
	prompt := firstNonEmpty(rpc.Params.Prompt, rpc.Params.Arguments.Prompt)
	if prompt != "" {
		turn.Messages = append(turn.Messages, CanonicalMessage{Role: "user", Content: prompt})
	}
	for _, m := range rpc.Params.Messages {
		turn.Messages = append(turn.Messages, CanonicalMessage{
			Role:    normalizeRole(m.Role),
			Content: extractFlexibleText(m.Content),
		})
	}
	if len(turn.Messages) == 0 {
		turn.Messages = append(turn.Messages, CanonicalMessage{Role: "user", Content: "ping"})
	}
	return nil
}

// IsMetadataOnlyMCP reports whether an MCP JSON-RPC request can be answered locally after auth/risk gating.
func (t *CanonicalTurn) IsMetadataOnlyMCP() bool {
	if t.IngressCodec != CodecMCPJSONRPC {
		return false
	}
	switch t.MCPMethod {
	case "initialize", "notifications/initialized", "ping", "tools/list":
		return true
	default:
		return false
	}
}

// WriteMCPMetadataResponse writes a JSON-RPC 2.0 capability or tool-catalog response.
func WriteMCPMetadataResponse(w http.ResponseWriter, turn *CanonicalTurn) {
	var result any
	switch turn.MCPMethod {
	case "initialize":
		result = map[string]any{
			"protocolVersion": "2024-11-05",
			"serverInfo": map[string]any{
				"name":    "slipgate-dataplane-mcp",
				"version": "0.2.0",
			},
			"capabilities": map[string]any{
				"tools": map[string]any{"listChanged": false},
			},
		}
	case "tools/list":
		result = map[string]any{
			"tools": []map[string]any{
				{
					"name":        "slipgate_complete",
					"description": "Execute a routed AI completion turn on Slipgate DataPlane",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"model":  map[string]any{"type": "string"},
							"prompt": map[string]any{"type": "string"},
						},
						"required": []string{"prompt"},
					},
				},
			},
		}
	default:
		result = map[string]any{"ok": true}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      turn.MCPID,
		"result":  result,
	})
}

// BuildUpstreamHTTPRequest encodes turn into the target provider's native HTTP request.
func BuildUpstreamHTTPRequest(
	ctx context.Context,
	provider string,
	upstreamModel string,
	cleanseMode string,
	secret AccountSecret,
	turn *CanonicalTurn,
) (*http.Request, CodecKind, error) {
	return BuildUpstreamHTTPRequestWithPersona(ctx, OutboundPersonaContext{
		Provider:    provider,
		CleanseMode: cleanseMode,
	}, upstreamModel, secret, turn)
}

// BuildUpstreamHTTPRequestWithPersona encodes turn and applies full Claude Code, Codex CLI, or Antigravity subscription mimicry.
func BuildUpstreamHTTPRequestWithPersona(
	ctx context.Context,
	pctx OutboundPersonaContext,
	upstreamModel string,
	secret AccountSecret,
	turn *CanonicalTurn,
) (*http.Request, CodecKind, error) {
	cleanseMode := firstNonEmpty(pctx.CleanseMode, "zero")
	if strings.EqualFold(strings.TrimSpace(pctx.Provider), "opencode_go") && IsOpenCodeUnsupportedModel(upstreamModel) {
		return nil, CodecOpenAIChat, ErrOpenCodeUnsupportedModel{Model: upstreamModel}
	}

	egress := ProviderEgressCodecWithPersona(pctx, secret, turn.IngressCodec)
	baseURL := resolveProviderBaseURL(pctx.Provider, secret.BaseURL)
	responsesPath := ""
	effectiveModel := stripPlatformWrapperPrefix(pctx.Provider, upstreamModel)
	if mpEgress, mpBase, mpRespPath, mpModel, ok := resolveMultiProtocolRoute(
		pctx.Provider,
		secret,
		turn.IngressCodec,
		upstreamModel,
		pctx.CatalogProtocols,
	); ok {
		egress = mpEgress
		if mpBase != "" {
			baseURL = mpBase
		}
		responsesPath = mpRespPath
		effectiveModel = mpModel
	}
	isClaudeSub := IsClaudeSubscription(pctx, secret)
	isCodexSub := IsCodexSubscription(pctx, secret)
	// Lock the Claude CLI version once per request so User-Agent header and system[0] billing block never diverge.
	claudeCLIVer := CLIClaudeVersion()

	filteredTools := make([]CanonicalTool, 0, len(turn.Tools))
	for _, t := range turn.Tools {
		if ShouldStripInternalTool(cleanseMode, t.Name, turn.CallerDeclaredTools) {
			continue
		}
		filteredTools = append(filteredTools, t)
	}

	switch strings.ToLower(strings.TrimSpace(pctx.Provider)) {
	case "bedrock":
		return buildBedrockConverseRequest(ctx, effectiveModel, secret, turn, filteredTools)
	case "vertex":
		return buildVertexRequest(ctx, pctx, effectiveModel, secret, turn, filteredTools)
	}

	var (
		fullURL string
		bodyRaw []byte
		err     error
	)

	turn.NativePassthrough = nativePassthroughEligible(pctx, secret, turn, egress, effectiveModel)
	switch {
	case turn.NativePassthrough:
		fullURL, bodyRaw, err = buildNativePassthrough(baseURL, responsesPath, effectiveModel, turn, egress)

	case egress == CodecAnthropicCountTokens:
		suffix := "/v1/messages/count_tokens"
		if isClaudeSub {
			suffix += "?beta=true"
		}
		fullURL = joinProviderPath(baseURL, suffix)
		bodyRaw, err = encodeAnthropicRequestBody(effectiveModel, turn, filteredTools, false, false, pctx, isClaudeSub, claudeCLIVer)

	case egress == CodecAnthropicMessages:
		suffix := "/v1/messages"
		if isClaudeSub {
			suffix += "?beta=true"
		}
		fullURL = joinProviderPath(baseURL, suffix)
		bodyRaw, err = encodeAnthropicRequestBody(effectiveModel, turn, filteredTools, turn.Stream, true, pctx, isClaudeSub, claudeCLIVer)

	case egress == CodecOpenAIResponses:
		if isCodexSub {
			fullURL = resolveCodexResponsesURL(pctx, secret)
		} else if LookupProviderProfile(pctx.Provider) != nil || responsesPath != "" {
			fullURL = joinResponsesPath(baseURL, responsesPath)
		} else {
			fullURL = resolveCodexResponsesURL(pctx, secret)
		}
		ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))
		forceStream := isCodexSub && (ak == "oauth" || ak == "vm_cli_seed" || strings.TrimSpace(secret.ChatGPTAccountID) != "" || strings.Contains(strings.ToLower(fullURL), "/backend-api/codex"))
		bodyRaw, err = EncodeCodexResponsesRequestBody(effectiveModel, turn, filteredTools, forceStream)

	case egress == CodecAntigravityInternal:
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = joinProviderPath(baseURL, "/v1internal"+action)
		bodyRaw, err = EncodeAntigravityRequestBody(effectiveModel, pctx, secret, turn, filteredTools)

	case egress == CodecGeminiGenerate:
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = joinProviderPath(baseURL, "/v1beta/models/"+effectiveModel+action)
		bodyRaw, err = encodeGeminiRequestBodyForModel(effectiveModel, turn, filteredTools)

	default:
		fullURL = joinOpenAIChatPath(baseURL)
		bodyRaw, err = encodeOpenAIChatRequestBody(pctx.Provider, effectiveModel, turn, filteredTools)
	}
	if err != nil {
		return nil, egress, err
	}
	turn.UpstreamServiceTier = upstreamServiceTier(pctx, secret, turn, egress)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewReader(bodyRaw))
	if err != nil {
		return nil, egress, err
	}
	SanitizeOutboundHeaders(req.Header)
	req.Header.Set("Content-Type", "application/json")
	if turn.Stream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}

	switch egress {
	case CodecAnthropicMessages, CodecAnthropicCountTokens:
		if isClaudeSub {
			ApplyClaudeSubscriptionHeadersWithContext(req, pctx, secret, turn.AnthropicBeta, turn.Stream, egress == CodecAnthropicCountTokens, claudeCLIVer)
		} else {
			if secret.APIKey != "" {
				req.Header.Set("x-api-key", secret.APIKey)
				if !strings.EqualFold(strings.TrimSpace(pctx.Provider), "anthropic") {
					req.Header.Set("Authorization", "Bearer "+secret.APIKey)
				}
			}
			version := "2023-06-01"
			if turn.NativePassthrough {
				// Verbatim requests keep the caller's API version and beta opt-ins (1M context,
				// interleaved thinking, files, ...), which their body may depend on.
				version = firstNonEmpty(sanitizeHeaderToken(turn.AnthropicVersion), version)
				if beta := sanitizeHeaderToken(turn.AnthropicBeta); beta != "" {
					req.Header.Set("anthropic-beta", beta)
				}
			}
			req.Header.Set("anthropic-version", version)
		}
	case CodecOpenAIResponses:
		if isCodexSub && !turn.NativePassthrough {
			ApplyCodexSubscriptionHeaders(req, pctx, secret)
		} else if secret.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+secret.APIKey)
		}
	case CodecAntigravityInternal:
		ApplyAntigravityHeaders(req, pctx, secret)
	case CodecGeminiGenerate:
		if secret.APIKey != "" {
			if strings.EqualFold(strings.TrimSpace(pctx.AuthKind), "oauth") {
				req.Header.Set("Authorization", "Bearer "+secret.APIKey)
			} else {
				req.Header.Set("x-goog-api-key", secret.APIKey)
			}
		}
	default:
		if secret.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+secret.APIKey)
		}
	}

	applyOpenCodeAndCommandCodeHeaders(req, pctx, secret, fullURL, turn)
	ApplyCLIProviderHeaders(req, pctx, secret, fullURL, egress)

	for k, v := range secret.Headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}
	return req, egress, nil
}

func encodeAnthropicRequestBody(
	model string,
	turn *CanonicalTurn,
	tools []CanonicalTool,
	stream bool,
	includeMaxTokens bool,
	pctx OutboundPersonaContext,
	isClaudeSub bool,
	claudeCLIVersion string,
) ([]byte, error) {
	payload := map[string]any{
		"model": model,
	}
	legacy := anthropicLegacyParams(model)
	var thinkingBudget uint64
	if legacy {
		thinkingBudget = anthropicThinkingBudget(turn)
	}
	if includeMaxTokens {
		maxTok := turn.MaxTokens
		if maxTok == 0 {
			maxTok = defaultAnthropicMaxTokens(model)
		}
		if thinkingBudget > 0 && maxTok <= thinkingBudget {
			maxTok = thinkingBudget + 4096
		}
		payload["max_tokens"] = maxTok
		if stream {
			payload["stream"] = true
		}
		if isClaudeSub {
			payload["metadata"] = map[string]any{
				"user_id": ClaudeMetadataUserID(pctx.AccountID, pctx.GuestMachineID),
			}
		}
	}
	switch {
	case !legacy:
		// Current Claude models take no sampling parameters; thinking is adaptive and its depth (and
		// structured output) lives in output_config.
		outputConfig := map[string]any{}
		if effort := anthropicEffort(turn); effort != "" {
			outputConfig["effort"] = effort
		}
		if anthropicThinkingAllowed(turn) && (turn.ThinkingAdaptive || turn.ThinkingBudget > 0 || outputConfig["effort"] != nil) {
			payload["thinking"] = map[string]any{"type": "adaptive"}
		}
		if rf := turn.ResponseFormat; rf != nil && rf.Type == "json_schema" && len(rf.Schema) > 0 {
			outputConfig["format"] = map[string]any{"type": "json_schema", "schema": rf.Schema}
		}
		if len(outputConfig) > 0 {
			payload["output_config"] = outputConfig
		}
	case thinkingBudget > 0:
		// Extended thinking rejects temperature and top_k, and only allows top_p >= 0.95.
		payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": thinkingBudget}
		if turn.TopP != nil && *turn.TopP >= 0.95 {
			payload["top_p"] = *turn.TopP
		}
	default:
		// Current Claude models reject temperature and top_p together; temperature wins.
		if turn.Temperature != nil {
			payload["temperature"] = *turn.Temperature
		} else if turn.TopP != nil {
			payload["top_p"] = *turn.TopP
		}
		if turn.TopK != nil {
			payload["top_k"] = *turn.TopK
		}
	}
	if len(turn.StopSequences) > 0 {
		payload["stop_sequences"] = turn.StopSequences
	}
	if isClaudeSub {
		sysBlocks := []map[string]any{
			{
				"type": "text",
				"text": BuildClaudeBillingHeader(firstUserMessageText(turn), claudeCLIVersion),
			},
			{
				"type":          "text",
				"text":          claudeCodeSystemPreamble,
				"cache_control": map[string]any{"type": "ephemeral"},
			},
		}
		if strings.TrimSpace(turn.SystemPrompt) != "" {
			sysBlocks = append(sysBlocks, map[string]any{
				"type": "text",
				"text": turn.SystemPrompt,
			})
		}
		payload["system"] = sysBlocks
	} else if turn.SystemPrompt != "" {
		payload["system"] = turn.SystemPrompt
	}

	_, thinkingOn := payload["thinking"]
	payload["messages"] = encodeAnthropicMessages(turn.Messages, thinkingOn)

	if len(tools) > 0 || len(turn.AnthropicServerTools) > 0 {
		antTools := make([]any, 0, len(tools)+len(turn.AnthropicServerTools))
		for _, t := range tools {
			antTools = append(antTools, map[string]any{
				"name":         t.Name,
				"description":  t.Description,
				"input_schema": ensureSchema(t.Parameters),
			})
		}
		for _, raw := range turn.AnthropicServerTools {
			antTools = append(antTools, raw)
		}
		payload["tools"] = antTools
		if choice := anthropicToolChoice(turn); choice != nil {
			payload["tool_choice"] = choice
		}
	}
	if tier := anthropicServiceTier(turn.ServiceTier); tier != "" && includeMaxTokens && !isClaudeSub {
		payload["service_tier"] = tier
	}
	return json.Marshal(payload)
}

// anthropicServiceTier is the caller's tier when Anthropic defines it ("" otherwise).
func anthropicServiceTier(tier string) string {
	switch tier {
	case "auto", "standard_only":
		return tier
	}
	return ""
}

// openAIServiceTier is the caller's tier in OpenAI's terms ("fast" is Codex CLI's name for
// priority; "" when OpenAI defines no such tier).
func openAIServiceTier(tier string) string {
	switch tier {
	case "auto", "default", "flex", "priority", "scale":
		return tier
	case "fast":
		return "priority"
	}
	return ""
}

// billedServiceTier is the tier slipgate-core settles at: the one sent upstream. A requested tier
// that never left the edge settles as "default", since an empty value falls back to the hold's.
func billedServiceTier(turn *CanonicalTurn) string {
	if turn.UpstreamServiceTier == "" && turn.ServiceTier != "" {
		return "default"
	}
	return turn.UpstreamServiceTier
}

// upstreamServiceTier is the tier the upstream request carries: the caller's own when its body is
// forwarded verbatim, else what the egress encoder wrote. Only that tier may be billed.
func upstreamServiceTier(pctx OutboundPersonaContext, secret AccountSecret, turn *CanonicalTurn, egress CodecKind) string {
	switch {
	case turn.ServiceTier == "":
		return ""
	case turn.NativePassthrough:
		return turn.ServiceTier
	case egress == CodecOpenAIResponses:
		return openAIServiceTier(turn.ServiceTier)
	case egress == CodecOpenAIChat && strings.EqualFold(strings.TrimSpace(pctx.Provider), "openai"):
		return openAIServiceTier(turn.ServiceTier)
	case egress == CodecAnthropicMessages && !IsClaudeSubscription(pctx, secret):
		return anthropicServiceTier(turn.ServiceTier)
	}
	return ""
}

// encodeAnthropicMessages renders canonical messages as Anthropic turns. Consecutive same-role
// messages are merged, so the results of parallel tool calls share one user turn and precede any
// text that follows them.
func encodeAnthropicMessages(msgs []CanonicalMessage, thinkingOn bool) []map[string]any {
	out := make([]map[string]any, 0, max(1, len(msgs)))
	appendBlocks := func(role string, blocks []map[string]any) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1]["role"] == role {
			out[n-1]["content"] = append(out[n-1]["content"].([]map[string]any), blocks...)
			return
		}
		out = append(out, map[string]any{"role": role, "content": blocks})
	}
	for _, m := range msgs {
		switch m.Role {
		case "tool":
			block := map[string]any{"type": "tool_result", "tool_use_id": firstNonEmpty(m.ToolCallID, "toolu_1")}
			if hasMediaParts(m.Parts) {
				block["content"] = anthropicContentBlocks(m.Parts)
			} else if m.Content != "" {
				block["content"] = m.Content
			}
			if m.IsError {
				block["is_error"] = true
			}
			appendBlocks("user", []map[string]any{block})
		case "assistant":
			var blocks []map[string]any
			if thinkingOn {
				// Only signed or redacted blocks can be replayed; unsigned text came from another provider.
				for _, th := range m.Thinking {
					switch {
					case th.Redacted != "":
						blocks = append(blocks, map[string]any{"type": "redacted_thinking", "data": th.Redacted})
					case th.Signature != "":
						blocks = append(blocks, map[string]any{"type": "thinking", "thinking": th.Text, "signature": th.Signature})
					}
				}
			}
			blocks = append(blocks, anthropicContentBlocks(messageParts(m))...)
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    firstNonEmpty(tc.ID, "toolu_call"),
					"name":  tc.Name,
					"input": jsonObjectValue(tc.Arguments),
				})
			}
			appendBlocks("assistant", blocks)
		default:
			appendBlocks("user", anthropicContentBlocks(messageParts(m)))
		}
	}
	if len(out) == 0 {
		out = append(out, map[string]any{"role": "user", "content": "Hello"})
	}
	return out
}

func anthropicToolChoice(turn *CanonicalTurn) map[string]any {
	disableParallel := turn.ParallelToolCalls != nil && !*turn.ParallelToolCalls
	var choice map[string]any
	if tc := turn.ToolChoice; tc != nil {
		switch tc.Mode {
		case "none":
			return map[string]any{"type": "none"}
		case "required":
			choice = map[string]any{"type": "any"}
		case "tool":
			choice = map[string]any{"type": "tool", "name": tc.Name}
		default:
			choice = map[string]any{"type": "auto"}
		}
	} else if disableParallel {
		choice = map[string]any{"type": "auto"}
	}
	if choice != nil && disableParallel {
		choice["disable_parallel_tool_use"] = true
	}
	return choice
}

var anthropicLegacyModelRe = regexp.MustCompile(`^claude-(opus|sonnet|haiku)-4(-[0-5])?(-\d{8})?$`)

// anthropicLegacyParams reports whether model still takes the classic Messages parameters
// (temperature/top_p/top_k and thinking.type=enabled with a token budget). Claude 4.6+ and 5.x
// models dropped sampling parameters and use adaptive thinking with output_config.effort.
// Non-Claude names (Anthropic-compatible vendors) keep the classic surface.
func anthropicLegacyParams(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if !strings.HasPrefix(m, "claude-") {
		return true
	}
	return strings.HasPrefix(m, "claude-3") || strings.HasPrefix(m, "claude-2") ||
		strings.HasPrefix(m, "claude-instant") || anthropicLegacyModelRe.MatchString(m)
}

// anthropicThinkingAllowed reports whether thinking may be enabled for this turn at all.
func anthropicThinkingAllowed(turn *CanonicalTurn) bool {
	if tc := turn.ToolChoice; tc != nil && (tc.Mode == "required" || tc.Mode == "tool") {
		return false // Anthropic rejects thinking combined with forced tool use
	}
	if turn.ReasoningEffort == "none" {
		return false
	}
	// A tool loop can only continue with thinking on if its last assistant turn carried a signed
	// thinking block, which history from another provider never has.
	for i := len(turn.Messages) - 1; i >= 0; i-- {
		m := turn.Messages[i]
		if m.Role != "assistant" {
			continue
		}
		if len(m.ToolCalls) == 0 {
			return true
		}
		for _, th := range m.Thinking {
			if th.Signature != "" || th.Redacted != "" {
				return true
			}
		}
		return false
	}
	return true
}

// anthropicThinkingBudget derives the classic extended-thinking budget from the caller's thinking
// budget or reasoning effort, or 0 when thinking must stay off.
func anthropicThinkingBudget(turn *CanonicalTurn) uint64 {
	if !anthropicThinkingAllowed(turn) {
		return 0
	}
	budget := turn.ThinkingBudget
	if budget == 0 {
		budget = thinkingBudgetForEffort(turn.ReasoningEffort)
	}
	if budget == 0 && turn.ThinkingAdaptive {
		budget = thinkingBudgetForEffort("medium")
	}
	if budget == 0 {
		return 0
	}
	return max(budget, 1024)
}

// anthropicEffort maps the caller's effort (or thinking budget) onto output_config.effort.
func anthropicEffort(turn *CanonicalTurn) string {
	switch e := turn.ReasoningEffort; e {
	case "minimal":
		return "low"
	case "low", "medium", "high", "xhigh", "max":
		return e
	case "none":
		return ""
	}
	return reasoningEffortForBudget(turn.ThinkingBudget)
}

// thinkingBudgetForEffort sizes classic thinking budgets; it stays at 24k for the top levels so
// budget plus answer still fits older models' output limits.
func thinkingBudgetForEffort(effort string) uint64 {
	switch effort {
	case "minimal":
		return 1024
	case "low":
		return 2048
	case "medium":
		return 8192
	case "high", "xhigh", "max":
		return 24576
	default:
		return 0
	}
}

func reasoningEffortForBudget(budget uint64) string {
	switch {
	case budget == 0:
		return ""
	case budget < 4096:
		return "low"
	case budget < 16384:
		return "medium"
	default:
		return "high"
	}
}

// defaultAnthropicMaxTokens is used when the caller (an OpenAI or Gemini client) set no limit;
// Anthropic requires one. Claude 3 (not 3.5/3.7) models cap output at 4096.
func defaultAnthropicMaxTokens(model string) uint64 {
	m := strings.ToLower(model)
	if strings.Contains(m, "claude-3-opus") || strings.Contains(m, "claude-3-sonnet") || strings.Contains(m, "claude-3-haiku") {
		return 4096
	}
	return 8192
}

// isOpenAIReasoningModel matches OpenAI models that reject temperature/top_p and take reasoning_effort.
func isOpenAIReasoningModel(model string) bool {
	m := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "openai/")
	switch {
	case strings.HasPrefix(m, "o1"), strings.HasPrefix(m, "o3"), strings.HasPrefix(m, "o4"):
		return true
	case strings.HasPrefix(m, "gpt-5"):
		return !strings.Contains(m, "chat")
	default:
		return false
	}
}

func encodeOpenAIChatRequestBody(provider, model string, turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	isOpenAI := strings.EqualFold(strings.TrimSpace(provider), "openai")
	reasoningModel := isOpenAI && isOpenAIReasoningModel(model)

	var msgs []map[string]any
	if turn.SystemPrompt != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": turn.SystemPrompt})
	}
	for _, m := range turn.Messages {
		switch m.Role {
		case "tool":
			msgs = append(msgs, map[string]any{
				"role":         "tool",
				"tool_call_id": firstNonEmpty(m.ToolCallID, "call_1"),
				"content":      m.Content,
			})
		case "assistant":
			entry := map[string]any{"role": "assistant", "content": m.Content}
			if len(m.ToolCalls) > 0 {
				var calls []map[string]any
				for _, tc := range m.ToolCalls {
					calls = append(calls, map[string]any{
						"id":   firstNonEmpty(tc.ID, "call_1"),
						"type": "function",
						"function": map[string]any{
							"name":      tc.Name,
							"arguments": defaultJSONObject(tc.Arguments),
						},
					})
				}
				entry["tool_calls"] = calls
			}
			msgs = append(msgs, entry)
		default:
			msgs = append(msgs, map[string]any{"role": "user", "content": openAIChatContent(m)})
		}
	}
	if len(msgs) == 0 {
		msgs = append(msgs, map[string]any{"role": "user", "content": "Hello"})
	}

	payload := map[string]any{
		"model":    model,
		"messages": msgs,
		"stream":   turn.Stream,
	}
	if turn.Stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}
	if turn.MaxTokensSet && turn.MaxTokens > 0 {
		// OpenAI deprecated max_tokens (reasoning models reject it); compatible vendors still expect it.
		if isOpenAI {
			payload["max_completion_tokens"] = turn.MaxTokens
		} else {
			payload["max_tokens"] = turn.MaxTokens
		}
	}
	if tier := openAIServiceTier(turn.ServiceTier); tier != "" && isOpenAI {
		payload["service_tier"] = tier
	}
	if reasoningModel {
		if effort := firstNonEmpty(turn.ReasoningEffort, reasoningEffortForBudget(turn.ThinkingBudget)); effort != "" {
			payload["reasoning_effort"] = effort
		}
	} else {
		if turn.Temperature != nil {
			payload["temperature"] = *turn.Temperature
		}
		if turn.TopP != nil {
			payload["top_p"] = *turn.TopP
		}
	}
	if stops := turn.StopSequences; len(stops) > 0 {
		payload["stop"] = stops[:min(4, len(stops))]
	}
	if rf := turn.ResponseFormat; rf != nil {
		switch rf.Type {
		case "json_object":
			payload["response_format"] = map[string]any{"type": "json_object"}
		case "json_schema":
			schema := rf.Schema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			payload["response_format"] = map[string]any{
				"type":        "json_schema",
				"json_schema": map[string]any{"name": firstNonEmpty(rf.Name, "response"), "schema": schema, "strict": rf.Strict},
			}
		}
	}
	if len(tools) > 0 {
		oaTools := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			oaTools = append(oaTools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"parameters":  ensureSchema(t.Parameters),
				},
			})
		}
		payload["tools"] = oaTools
		if tc := turn.ToolChoice; tc != nil {
			if tc.Mode == "tool" {
				payload["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": tc.Name}}
			} else {
				payload["tool_choice"] = tc.Mode
			}
		}
		if turn.ParallelToolCalls != nil {
			payload["parallel_tool_calls"] = *turn.ParallelToolCalls
		}
	}
	return json.Marshal(payload)
}

// encodeGeminiRequestBody keeps the model-agnostic signature the Antigravity envelope encoder uses.
func encodeGeminiRequestBody(turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	return encodeGeminiRequestBodyForModel("", turn, tools)
}

// encodeGeminiRequestBodyForModel enables thinking only for models known to support thinkingConfig.
func encodeGeminiRequestBodyForModel(model string, turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	payload := map[string]any{}
	if turn.SystemPrompt != "" {
		payload["systemInstruction"] = map[string]any{
			"parts": []map[string]any{{"text": turn.SystemPrompt}},
		}
	}
	// Gemini answers function calls by name and wants every response to a parallel call in one
	// user turn, so consecutive same-role contents are merged.
	callNames := make(map[string]string)
	var contents []map[string]any
	appendContent := func(role string, parts []map[string]any) {
		if len(parts) == 0 {
			return
		}
		if n := len(contents); n > 0 && contents[n-1]["role"] == role {
			contents[n-1]["parts"] = append(contents[n-1]["parts"].([]map[string]any), parts...)
			return
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}
	for _, m := range turn.Messages {
		switch m.Role {
		case "assistant":
			parts := geminiContentParts(messageParts(m))
			for _, tc := range m.ToolCalls {
				callNames[tc.ID] = tc.Name
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{"name": tc.Name, "args": jsonObjectValue(tc.Arguments)},
				})
			}
			appendContent("model", parts)
		case "tool":
			name := firstNonEmpty(m.ToolName, callNames[m.ToolCallID], m.ToolCallID)
			appendContent("user", []map[string]any{{
				"functionResponse": map[string]any{"name": name, "response": geminiFunctionResponse(m)},
			}})
		default:
			appendContent("user", geminiContentParts(messageParts(m)))
		}
	}
	if len(contents) == 0 {
		contents = append(contents, map[string]any{
			"role":  "user",
			"parts": []map[string]any{{"text": "Hello"}},
		})
	}
	payload["contents"] = contents

	genCfg := map[string]any{}
	if turn.MaxTokensSet && turn.MaxTokens > 0 {
		genCfg["maxOutputTokens"] = turn.MaxTokens
	}
	if turn.Temperature != nil {
		genCfg["temperature"] = *turn.Temperature
	}
	if turn.TopP != nil {
		genCfg["topP"] = *turn.TopP
	}
	if turn.TopK != nil {
		genCfg["topK"] = *turn.TopK
	}
	if len(turn.StopSequences) > 0 {
		genCfg["stopSequences"] = turn.StopSequences
	}
	if turn.ResponseFormat != nil {
		genCfg["responseMimeType"] = "application/json"
	}
	budget := turn.ThinkingBudget
	if budget == 0 {
		budget = thinkingBudgetForEffort(turn.ReasoningEffort)
	}
	if m := strings.ToLower(model); budget > 0 && (strings.Contains(m, "gemini-2.5") || strings.Contains(m, "gemini-3")) {
		genCfg["thinkingConfig"] = map[string]any{"thinkingBudget": budget, "includeThoughts": true}
	}
	if len(genCfg) > 0 {
		payload["generationConfig"] = genCfg
	}
	if len(tools) > 0 {
		var decls []map[string]any
		for _, t := range tools {
			decls = append(decls, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  ensureSchema(t.Parameters),
			})
		}
		payload["tools"] = []map[string]any{{"functionDeclarations": decls}}
		if tc := turn.ToolChoice; tc != nil {
			fcc := map[string]any{}
			switch tc.Mode {
			case "none":
				fcc["mode"] = "NONE"
			case "required":
				fcc["mode"] = "ANY"
			case "tool":
				fcc["mode"] = "ANY"
				fcc["allowedFunctionNames"] = []string{tc.Name}
			default:
				fcc["mode"] = "AUTO"
			}
			payload["toolConfig"] = map[string]any{"functionCallingConfig": fcc}
		}
	}
	return json.Marshal(payload)
}

// geminiFunctionResponse wraps a tool result as the JSON object Gemini requires.
func geminiFunctionResponse(m CanonicalMessage) any {
	trimmed := strings.TrimSpace(m.Content)
	if !m.IsError && strings.HasPrefix(trimmed, "{") && json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	if m.IsError {
		return map[string]any{"error": m.Content}
	}
	return map[string]any{"content": m.Content}
}

// ExecuteMockTurn synthesizes a deterministic upstream *http.Response (`mock://ok`, `mock://echo`, `mock://tool-leak`, `mock://400`, `mock://409`, `mock://410`).
func ExecuteMockTurn(mockTarget, upstreamModel string, egress CodecKind, turn *CanonicalTurn) *http.Response {
	mode := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(mockTarget), "mock://"))
	headers := make(http.Header)

	switch mode {
	case "400":
		return jsonHTTPResponse(http.StatusBadRequest, headers, map[string]any{
			"error": map[string]any{"type": "invalid_request_error", "message": "mock ordinary upstream 400 validation error"},
		})
	case "409":
		return jsonHTTPResponse(http.StatusConflict, headers, map[string]any{
			"error": map[string]any{"type": "tool_result_replayed", "message": "tool_result already consumed on native slot"},
		})
	case "410":
		return jsonHTTPResponse(http.StatusGone, headers, map[string]any{
			"error": map[string]any{"type": "continuation_expired", "message": "native continuation session expired"},
		})
	}

	effModel := StripAntigravityModelPrefix(upstreamModel)
	replyText := fmt.Sprintf("Slipgate verified response from %s", effModel)
	if mode == "echo" && len(turn.Messages) > 0 {
		replyText = "echo: " + turn.Messages[len(turn.Messages)-1].Content
	}
	leakTools := mode == "tool-leak"
	inTok := max(uint64(12), turn.EstimatedInputTokens)
	outTok := uint64(max(8, (len(replyText)+3)/4))

	if egress == CodecAnthropicCountTokens {
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"input_tokens": inTok,
		})
	}

	// Codex OAuth backend always streams SSE even on unary client turns; emulate that faithfully!
	if !turn.Stream && egress != CodecOpenAIResponses {
		switch egress {
		case CodecAnthropicMessages:
			headers.Set("anthropic-ratelimit-unified-5h-utilization", "0.22")
			headers.Set("anthropic-ratelimit-unified-7d-utilization", "0.41")
			content := []map[string]any{{"type": "text", "text": replyText}}
			stopReason := "end_turn"
			if leakTools {
				content = append(content,
					map[string]any{"type": "tool_use", "id": "toolu_internal_read", "name": "Read", "input": map[string]any{"file_path": "/etc/passwd"}},
					map[string]any{"type": "tool_use", "id": "toolu_user_fn", "name": "lookup_weather", "input": map[string]any{"city": "Tokyo"}},
				)
				stopReason = "tool_use"
			}
			return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
				"id":          "msg_mock_01",
				"type":        "message",
				"role":        "assistant",
				"model":       effModel,
				"content":     content,
				"stop_reason": stopReason,
				"usage": map[string]any{
					"input_tokens":  inTok,
					"output_tokens": outTok,
				},
			})

		case CodecAntigravityInternal:
			headers.Set("x-antigravity-quota-used-percent", "14.5")
			parts := []map[string]any{{"text": replyText}}
			if leakTools {
				parts = append(parts,
					map[string]any{"functionCall": map[string]any{"name": "browser_subagent", "args": map[string]any{"url": "http://localhost"}}},
					map[string]any{"functionCall": map[string]any{"name": "lookup_weather", "args": map[string]any{"city": "Tokyo"}}},
				)
			}
			return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
				"response": map[string]any{
					"candidates": []map[string]any{
						{
							"content":      map[string]any{"role": "model", "parts": parts},
							"finishReason": "STOP",
						},
					},
					"usageMetadata": map[string]any{
						"promptTokenCount":     inTok,
						"candidatesTokenCount": outTok,
						"totalTokenCount":      inTok + outTok,
					},
				},
			})

		case CodecGeminiGenerate:
			parts := []map[string]any{{"text": replyText}}
			if leakTools {
				parts = append(parts,
					map[string]any{"functionCall": map[string]any{"name": "Bash", "args": map[string]any{"command": "id"}}},
					map[string]any{"functionCall": map[string]any{"name": "lookup_weather", "args": map[string]any{"city": "Tokyo"}}},
				)
			}
			return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
				"candidates": []map[string]any{
					{
						"content":      map[string]any{"role": "model", "parts": parts},
						"finishReason": "STOP",
					},
				},
				"usageMetadata": map[string]any{
					"promptTokenCount":     inTok,
					"candidatesTokenCount": outTok,
					"totalTokenCount":      inTok + outTok,
				},
			})

		case CodecBedrockConverse:
			blocks := []map[string]any{{"text": replyText}}
			stopReason := "end_turn"
			if leakTools {
				blocks = append(blocks,
					map[string]any{"toolUse": map[string]any{"toolUseId": "tooluse_internal_bash", "name": "Bash", "input": map[string]any{"command": "id"}}},
					map[string]any{"toolUse": map[string]any{"toolUseId": "tooluse_user_fn", "name": "lookup_weather", "input": map[string]any{"city": "Tokyo"}}},
				)
				stopReason = "tool_use"
			}
			return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
				"output": map[string]any{
					"message": map[string]any{
						"role":    "assistant",
						"content": blocks,
					},
				},
				"stopReason": stopReason,
				"usage": map[string]any{
					"inputTokens":  inTok,
					"outputTokens": outTok,
					"totalTokens":  inTok + outTok,
				},
			})

		default:
			msg := map[string]any{"role": "assistant", "content": replyText}
			finishReason := "stop"
			if leakTools {
				msg["tool_calls"] = []map[string]any{
					{"id": "call_internal_bash", "type": "function", "function": map[string]any{"name": "Bash", "arguments": `{"command":"whoami"}`}},
					{"id": "call_user_fn", "type": "function", "function": map[string]any{"name": "lookup_weather", "arguments": `{"city":"Tokyo"}`}},
				}
				finishReason = "tool_calls"
			}
			return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
				"id":      "chatcmpl_mock_01",
				"object":  "chat.completion",
				"created": time.Now().Unix(),
				"model":   effModel,
				"choices": []map[string]any{
					{"index": 0, "message": msg, "finish_reason": finishReason},
				},
				"usage": map[string]any{
					"prompt_tokens":     inTok,
					"completion_tokens": outTok,
					"total_tokens":      inTok + outTok,
				},
			})
		}
	}

	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	var sse bytes.Buffer
	mid := len(replyText) / 2
	part1, part2 := replyText[:mid], replyText[mid:]

	switch egress {
	case CodecAnthropicMessages:
		headers.Set("anthropic-ratelimit-unified-5h-utilization", "0.22")
		headers.Set("anthropic-ratelimit-unified-7d-utilization", "0.41")
		writeSSEEvent(&sse, "message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id":    "msg_mock_stream_01",
				"type":  "message",
				"role":  "assistant",
				"model": effModel,
				"usage": map[string]any{"input_tokens": inTok, "output_tokens": 0},
			},
		})
		writeSSEEvent(&sse, "content_block_start", map[string]any{
			"type":          "content_block_start",
			"index":         0,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		writeSSEEvent(&sse, "content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]any{"type": "text_delta", "text": part1},
		})
		writeSSEEvent(&sse, "content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]any{"type": "text_delta", "text": part2},
		})
		if leakTools {
			writeSSEEvent(&sse, "content_block_start", map[string]any{
				"type":          "content_block_start",
				"index":         1,
				"content_block": map[string]any{"type": "tool_use", "id": "toolu_leak_1", "name": "Read", "input": map[string]any{"file_path": "/etc/shadow"}},
			})
			writeSSEEvent(&sse, "content_block_stop", map[string]any{"type": "content_block_stop", "index": 1})
			writeSSEEvent(&sse, "content_block_start", map[string]any{
				"type":          "content_block_start",
				"index":         2,
				"content_block": map[string]any{"type": "tool_use", "id": "toolu_ok_1", "name": "lookup_weather", "input": map[string]any{"city": "Tokyo"}},
			})
			writeSSEEvent(&sse, "content_block_stop", map[string]any{"type": "content_block_stop", "index": 2})
		}
		writeSSEEvent(&sse, "message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": outTok},
		})
		writeSSEEvent(&sse, "message_stop", map[string]any{"type": "message_stop"})

	case CodecOpenAIResponses:
		headers.Set("x-codex-primary-used-percent", "18.5")
		headers.Set("x-codex-secondary-used-percent", "31.0")
		writeSSEEvent(&sse, "response.created", map[string]any{
			"type":     "response.created",
			"response": map[string]any{"id": "resp_mock_codex_s1", "model": effModel, "status": "in_progress"},
		})
		writeSSEEvent(&sse, "response.output_text.delta", map[string]any{
			"type":  "response.output_text.delta",
			"delta": part1,
		})
		writeSSEEvent(&sse, "response.output_text.delta", map[string]any{
			"type":  "response.output_text.delta",
			"delta": part2,
		})
		if leakTools {
			writeSSEEvent(&sse, "response.output_item.done", map[string]any{
				"type": "response.output_item.done",
				"item": map[string]any{"type": "function_call", "call_id": "call_leak_exec", "name": "exec_command", "arguments": `{"cmd":"id"}`},
			})
			writeSSEEvent(&sse, "response.output_item.done", map[string]any{
				"type": "response.output_item.done",
				"item": map[string]any{"type": "function_call", "call_id": "call_ok_weather", "name": "lookup_weather", "arguments": `{"city":"Tokyo"}`},
			})
		}
		writeSSEEvent(&sse, "response.completed", map[string]any{
			"type": "response.completed",
			"response": map[string]any{
				"id":     "resp_mock_codex_s1",
				"status": "completed",
				"usage":  map[string]any{"input_tokens": inTok, "output_tokens": outTok, "total_tokens": inTok + outTok},
			},
		})

	case CodecAntigravityInternal:
		headers.Set("x-antigravity-quota-used-percent", "14.5")
		writeSSEData(&sse, map[string]any{
			"response": map[string]any{
				"candidates": []map[string]any{
					{"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": part1}}}},
				},
			},
		})
		parts2 := []map[string]any{{"text": part2}}
		if leakTools {
			parts2 = append(parts2,
				map[string]any{"functionCall": map[string]any{"name": "run_command", "args": map[string]any{"cmd": "ls"}}},
				map[string]any{"functionCall": map[string]any{"name": "lookup_weather", "args": map[string]any{"city": "Tokyo"}}},
			)
		}
		writeSSEData(&sse, map[string]any{
			"response": map[string]any{
				"candidates": []map[string]any{
					{"content": map[string]any{"role": "model", "parts": parts2}, "finishReason": "STOP"},
				},
				"usageMetadata": map[string]any{
					"promptTokenCount":     inTok,
					"candidatesTokenCount": outTok,
					"totalTokenCount":      inTok + outTok,
				},
			},
		})

	case CodecGeminiGenerate:
		writeSSEData(&sse, map[string]any{
			"candidates": []map[string]any{
				{"content": map[string]any{"role": "model", "parts": []map[string]any{{"text": part1}}}},
			},
		})
		parts2 := []map[string]any{{"text": part2}}
		if leakTools {
			parts2 = append(parts2,
				map[string]any{"functionCall": map[string]any{"name": "Edit", "args": map[string]any{"file": "x"}}},
				map[string]any{"functionCall": map[string]any{"name": "lookup_weather", "args": map[string]any{"city": "Tokyo"}}},
			)
		}
		writeSSEData(&sse, map[string]any{
			"candidates": []map[string]any{
				{"content": map[string]any{"role": "model", "parts": parts2}, "finishReason": "STOP"},
			},
			"usageMetadata": map[string]any{
				"promptTokenCount":     inTok,
				"candidatesTokenCount": outTok,
				"totalTokenCount":      inTok + outTok,
			},
		})

	case CodecBedrockConverse:
		headers.Set("Content-Type", "application/vnd.amazon.eventstream")
		var ev bytes.Buffer
		p1, _ := json.Marshal(map[string]any{"delta": map[string]any{"text": part1}})
		p2, _ := json.Marshal(map[string]any{"delta": map[string]any{"text": part2}})
		ev.Write(encodeBedrockEventFrame("contentBlockDelta", p1))
		ev.Write(encodeBedrockEventFrame("contentBlockDelta", p2))
		stopReason := "end_turn"
		if leakTools {
			tStart1, _ := json.Marshal(map[string]any{"start": map[string]any{"toolUse": map[string]any{"toolUseId": "tooluse_leak_1", "name": "Read"}}})
			tIn1, _ := json.Marshal(map[string]any{"delta": map[string]any{"toolUse": map[string]any{"input": `{"file_path":"/etc/passwd"}`}}})
			tStart2, _ := json.Marshal(map[string]any{"start": map[string]any{"toolUse": map[string]any{"toolUseId": "tooluse_ok_1", "name": "lookup_weather"}}})
			tIn2, _ := json.Marshal(map[string]any{"delta": map[string]any{"toolUse": map[string]any{"input": `{"city":"Tokyo"}`}}})
			ev.Write(encodeBedrockEventFrame("contentBlockStart", tStart1))
			ev.Write(encodeBedrockEventFrame("contentBlockDelta", tIn1))
			ev.Write(encodeBedrockEventFrame("contentBlockStop", []byte(`{}`)))
			ev.Write(encodeBedrockEventFrame("contentBlockStart", tStart2))
			ev.Write(encodeBedrockEventFrame("contentBlockDelta", tIn2))
			ev.Write(encodeBedrockEventFrame("contentBlockStop", []byte(`{}`)))
			stopReason = "tool_use"
		}
		stopPayload, _ := json.Marshal(map[string]any{"stopReason": stopReason})
		metaPayload, _ := json.Marshal(map[string]any{"usage": map[string]any{"inputTokens": inTok, "outputTokens": outTok, "totalTokens": inTok + outTok}})
		ev.Write(encodeBedrockEventFrame("messageStop", stopPayload))
		ev.Write(encodeBedrockEventFrame("metadata", metaPayload))
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     headers,
			Body:       io.NopCloser(bytes.NewReader(ev.Bytes())),
		}

	default:
		writeSSEData(&sse, map[string]any{
			"id":      "chatcmpl_mock_stream_01",
			"object":  "chat.completion.chunk",
			"model":   effModel,
			"choices": []map[string]any{{"index": 0, "delta": map[string]any{"role": "assistant", "content": part1}}},
		})
		writeSSEData(&sse, map[string]any{
			"id":      "chatcmpl_mock_stream_01",
			"object":  "chat.completion.chunk",
			"model":   effModel,
			"choices": []map[string]any{{"index": 0, "delta": map[string]any{"content": part2}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": inTok, "completion_tokens": outTok, "total_tokens": inTok + outTok},
		})
		sse.WriteString("data: [DONE]\n\n")
	}

	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     headers,
		Body:       io.NopCloser(bytes.NewReader(sse.Bytes())),
	}
}

// WriteProtocolError writes a wire-compatible error JSON response matching the caller's ingress protocol.
func WriteProtocolError(w http.ResponseWriter, codec CodecKind, status int, errType, errCode, message string) {
	if status < 400 {
		status = http.StatusBadRequest
	}
	if errType == "" {
		errType = "api_error"
	}
	if message == "" {
		message = http.StatusText(status)
	}

	switch codec {
	case CodecAnthropicMessages, CodecAnthropicCountTokens:
		writeJSONResponse(w, status, map[string]any{
			"type": "error",
			"error": map[string]any{
				"type":    anthropicErrorType(errType, status),
				"code":    errCode,
				"message": message,
			},
		})
	case CodecGeminiGenerate:
		writeJSONResponse(w, status, map[string]any{
			"error": map[string]any{
				"code":    status,
				"status":  strings.ToUpper(errType),
				"message": message,
			},
		})
	default:
		writeJSONResponse(w, status, map[string]any{
			"error": map[string]any{
				"message": message,
				"type":    errType,
				"code":    errCode,
			},
		})
	}
}

func filterCanonicalToolCalls(in []CanonicalToolCall, cleanseMode string, callerDeclared map[string]bool) []CanonicalToolCall {
	if len(in) == 0 {
		return nil
	}
	out := make([]CanonicalToolCall, 0, len(in))
	for _, tc := range in {
		if ShouldStripInternalTool(cleanseMode, tc.Name, callerDeclared) {
			continue
		}
		out = append(out, tc)
	}
	return out
}

func resolveProviderBaseURL(provider, custom string) string {
	if trimmed := strings.TrimRight(strings.TrimSpace(custom), "/"); trimmed != "" {
		return trimmed
	}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic":
		return "https://api.anthropic.com"
	case "antigravity":
		return "https://cloudcode-pa.googleapis.com"
	case "gemini":
		return "https://generativelanguage.googleapis.com"
	case "grok":
		return "https://api.x.ai/v1"
	case "deepseek":
		return "https://api.deepseek.com"
	case "glm", "zhipu":
		return "https://open.bigmodel.cn/api/paas/v4"
	case "kimi":
		return "https://api.moonshot.cn/v1"
	case "minimax":
		return "https://api.minimaxi.com/v1"
	case "qwen":
		return "https://dashscope.aliyuncs.com/compatible-mode/v1"
	case "bedrock":
		return "https://bedrock-runtime.us-east-1.amazonaws.com"
	case "vertex":
		return "https://us-central1-aiplatform.googleapis.com"
	case "opencode_go":
		return "https://opencode.ai/zen/go/v1"
	case "typesafe":
		return DefaultTypeSafeBaseURL
	case "command_code":
		return "https://api.commandcode.ai/provider/v1"
	case "cline":
		return "https://api.cline.bot/api/v1"
	default:
		return "https://api.openai.com"
	}
}

func resolveCodexResponsesURL(pctx OutboundPersonaContext, secret AccountSecret) string {
	custom := strings.TrimRight(strings.TrimSpace(secret.BaseURL), "/")
	if custom != "" {
		if strings.HasSuffix(custom, "/responses") {
			return custom
		}
		if strings.HasSuffix(custom, "/v1") || strings.HasSuffix(custom, "/codex") {
			return custom + "/responses"
		}
		return custom + "/v1/responses"
	}
	ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))
	if ak != "api_key" {
		return "https://chatgpt.com/backend-api/codex/responses"
	}
	return "https://api.openai.com/v1/responses"
}

func joinProviderPath(baseURL, suffixPath string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/v1") && strings.HasPrefix(suffixPath, "/v1/") {
		return base + strings.TrimPrefix(suffixPath, "/v1")
	}
	if strings.HasSuffix(base, "/v1beta") && strings.HasPrefix(suffixPath, "/v1beta/") {
		return base + strings.TrimPrefix(suffixPath, "/v1beta")
	}
	if strings.HasSuffix(base, "/v1internal") && strings.HasPrefix(suffixPath, "/v1internal") {
		return base + strings.TrimPrefix(suffixPath, "/v1internal")
	}
	return base + suffixPath
}

func joinOpenAIChatPath(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	if strings.HasSuffix(base, "/v1") || strings.HasSuffix(base, "/v4") {
		return base + "/chat/completions"
	}
	return base + "/v1/chat/completions"
}

func extractFlexibleText(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var str string
	if err := json.Unmarshal(trimmed, &str); err == nil {
		return str
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func normalizeRole(r string) string {
	switch strings.ToLower(strings.TrimSpace(r)) {
	case "assistant", "model":
		return "assistant"
	case "tool":
		return "tool"
	default:
		return "user"
	}
}

func defaultJSONObject(s string) string {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		return "{}"
	}
	return trimmed
}

func ensureSchema(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return json.RawMessage(`{"type":"object","properties":{}}`)
	}
	return trimmed
}

func ensurePrefix(id, prefix string) string {
	if strings.HasPrefix(id, prefix) {
		return id
	}
	return prefix + id
}

func extractQuotaWatermarks(h http.Header) (uint16, uint16) {
	if strings.EqualFold(strings.TrimSpace(h.Get("anthropic-ratelimit-unified-status")), "rejected") {
		return 10000, 10000
	}
	parseRatioOrBps := func(raw string) uint16 {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return 0
		}
		if f, err := strconv.ParseFloat(trimmed, 64); err == nil && f > 0 {
			if f <= 1.0 {
				return uint16(min(10000, int(f*10000)))
			}
			return uint16(min(10000, int(f)))
		}
		return 0
	}
	parsePercent := func(raw string) uint16 {
		trimmed := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(raw), "%"))
		if trimmed == "" {
			return 0
		}
		if f, err := strconv.ParseFloat(trimmed, 64); err == nil && f > 0 {
			return uint16(min(10000, int(f*100)))
		}
		return 0
	}

	w5 := parseRatioOrBps(firstNonEmpty(
		h.Get("X-Slipgate-Window-5h-Bps"),
		h.Get("x-goog-quota-5h-bps"),
		h.Get("anthropic-ratelimit-unified-5h-utilization"),
	))
	if w5 == 0 {
		w5 = parsePercent(firstNonEmpty(
			h.Get("x-codex-primary-used-percent"),
			h.Get("x-antigravity-quota-used-percent"),
		))
	}

	w7 := parseRatioOrBps(firstNonEmpty(
		h.Get("X-Slipgate-Window-7d-Bps"),
		h.Get("x-goog-quota-7d-bps"),
		h.Get("anthropic-ratelimit-unified-7d-utilization"),
	))
	if w7 == 0 {
		w7 = parsePercent(h.Get("x-codex-secondary-used-percent"))
	}
	return w5, w7
}

func extractErrorMessage(raw []byte, fallback string) string {
	var parsed struct {
		Message string `json:"message"`
		Error   any    `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		if parsed.Message != "" {
			return parsed.Message
		}
		switch e := parsed.Error.(type) {
		case string:
			if e != "" {
				return e
			}
		case map[string]any:
			if m, ok := e["message"].(string); ok && m != "" {
				return m
			}
		}
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed != "" && len(trimmed) < 512 {
		return trimmed
	}
	return fallback
}

func elapsedMs(start time.Time) uint32 {
	return uint32(max(1, int(time.Since(start).Milliseconds())))
}

func jsonHTTPResponse(status int, h http.Header, body any) *http.Response {
	h.Set("Content-Type", "application/json; charset=utf-8")
	raw, _ := json.Marshal(body)
	return &http.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(bytes.NewReader(raw)),
	}
}

func writeJSONResponse(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeSSEEvent(w io.Writer, event string, data any) {
	raw, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
}

func writeSSEData(w io.Writer, data any) {
	raw, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
}
