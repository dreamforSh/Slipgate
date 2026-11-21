package dataplane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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

// CanonicalMessage represents a provider-neutral conversation message.
type CanonicalMessage struct {
	Role       string              `json:"role"`
	Content    string              `json:"content"`
	ToolCalls  []CanonicalToolCall `json:"toolCalls,omitempty"`
	ToolCallID string              `json:"toolCallId,omitempty"`
}

// CanonicalTool represents a caller-declared tool schema.
type CanonicalTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// CanonicalTurn holds the parsed ingress request across OpenAI, Anthropic, Gemini, and MCP.
type CanonicalTurn struct {
	IngressCodec         CodecKind
	PublicModel          string
	Stream               bool
	MaxTokens            uint64
	Temperature          *float64
	SystemPrompt         string
	Messages             []CanonicalMessage
	Tools                []CanonicalTool
	CallerDeclaredTools  map[string]bool
	EstimatedInputTokens uint64
	BodyExcerpt          string

	MCPMethod string
	MCPID     json.RawMessage
}

// RelayMetrics captures post-turn token accounting, latency, and quota watermark updates.
type RelayMetrics struct {
	UpstreamStatus   int
	InputTokens      uint64
	OutputTokens     uint64
	CacheReadTokens  uint64
	CacheWriteTokens uint64
	Window5hUsedBps  uint16
	Window7dUsedBps  uint16
	TTFTMs           uint32
	EgressCodec      CodecKind
}

type canonicalResult struct {
	ID               string
	Text             string
	ToolCalls        []CanonicalToolCall
	StopReason       string
	InputTokens      uint64
	OutputTokens     uint64
	CacheReadTokens  uint64
	CacheWriteTokens uint64
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
	switch strings.ToLower(strings.TrimSpace(pctx.Provider)) {
	case "anthropic":
		return CodecAnthropicMessages
	case "gemini":
		return CodecGeminiGenerate
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
		MaxTokens:           1024,
		CallerDeclaredTools: make(map[string]bool),
	}

	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		turn.EstimatedInputTokens = 16
		return turn, nil
	}

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
	for _, m := range turn.Messages {
		textBuilder.WriteString(m.Content)
		textBuilder.WriteByte('\n')
	}
	combinedText := textBuilder.String()
	turn.EstimatedInputTokens = uint64(max(16, (len(combinedText)+len(trimmed)/4+3)/4))

	excerptSource := combinedText + "\n" + string(trimmed)
	if len(excerptSource) > 4096 {
		excerptSource = excerptSource[:4096]
	}
	turn.BodyExcerpt = excerptSource
	return turn, nil
}

func parseOpenAIChat(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model               string          `json:"model"`
		Stream              bool            `json:"stream"`
		MaxTokens           uint64          `json:"max_tokens"`
		MaxCompletionTokens uint64          `json:"max_completion_tokens"`
		Temperature         *float64        `json:"temperature"`
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
	if payload.MaxCompletionTokens > 0 {
		turn.MaxTokens = payload.MaxCompletionTokens
	} else if payload.MaxTokens > 0 {
		turn.MaxTokens = payload.MaxTokens
	}
	turn.Temperature = payload.Temperature

	var sysParts []string
	for _, msg := range payload.Messages {
		text := extractFlexibleText(msg.Content)
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
			ToolCallID: msg.ToolCallID,
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
		name := strings.TrimSpace(t.Function.Name)
		if name == "" {
			continue
		}
		turn.CallerDeclaredTools[name] = true
		turn.Tools = append(turn.Tools, CanonicalTool{
			Name:        name,
			Description: t.Function.Description,
			Parameters:  ensureSchema(t.Function.Parameters),
		})
	}
	return nil
}

type openAIMessage struct {
	Role       string          `json:"role"`
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

func parseOpenAIResponses(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model           string          `json:"model"`
		Stream          bool            `json:"stream"`
		MaxOutputTokens uint64          `json:"max_output_tokens"`
		Temperature     *float64        `json:"temperature"`
		Instructions    string          `json:"instructions"`
		Input           json.RawMessage `json:"input"`
		Tools           []struct {
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
	}
	turn.Temperature = payload.Temperature
	turn.SystemPrompt = strings.TrimSpace(payload.Instructions)

	if len(payload.Input) > 0 {
		var strInput string
		if err := json.Unmarshal(payload.Input, &strInput); err == nil {
			turn.Messages = append(turn.Messages, CanonicalMessage{
				Role:    "user",
				Content: strInput,
			})
		} else {
			var items []struct {
				Type      string          `json:"type"`
				Role      string          `json:"role"`
				Content   json.RawMessage `json:"content"`
				CallID    string          `json:"call_id"`
				Name      string          `json:"name"`
				Arguments string          `json:"arguments"`
				Output    string          `json:"output"`
			}
			if err := json.Unmarshal(payload.Input, &items); err == nil {
				for _, item := range items {
					switch item.Type {
					case "function_call":
						turn.Messages = append(turn.Messages, CanonicalMessage{
							Role: "assistant",
							ToolCalls: []CanonicalToolCall{
								{ID: item.CallID, Name: item.Name, Arguments: defaultJSONObject(item.Arguments)},
							},
						})
					case "function_call_output":
						turn.Messages = append(turn.Messages, CanonicalMessage{
							Role:       "tool",
							ToolCallID: item.CallID,
							Content:    item.Output,
						})
					default:
						turn.Messages = append(turn.Messages, CanonicalMessage{
							Role:    normalizeRole(item.Role),
							Content: extractFlexibleText(item.Content),
						})
					}
				}
			}
		}
	}

	for _, t := range payload.Tools {
		name := strings.TrimSpace(t.Name)
		desc := t.Description
		params := t.Parameters
		if name == "" && t.Function != nil {
			name = strings.TrimSpace(t.Function.Name)
			desc = t.Function.Description
			params = t.Function.Parameters
		}
		if name == "" {
			continue
		}
		turn.CallerDeclaredTools[name] = true
		turn.Tools = append(turn.Tools, CanonicalTool{
			Name:        name,
			Description: desc,
			Parameters:  ensureSchema(params),
		})
	}
	return nil
}

func parseAnthropicMessages(raw []byte, turn *CanonicalTurn) error {
	var payload struct {
		Model       string          `json:"model"`
		Stream      bool            `json:"stream"`
		MaxTokens   uint64          `json:"max_tokens"`
		Temperature *float64        `json:"temperature"`
		System      json.RawMessage `json:"system"`
		Messages    []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
		Tools []struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid Anthropic messages JSON: %w", err)
	}
	if strings.TrimSpace(payload.Model) != "" {
		turn.PublicModel = strings.TrimSpace(payload.Model)
	}
	if turn.IngressCodec != CodecAnthropicCountTokens {
		turn.Stream = payload.Stream
	}
	if payload.MaxTokens > 0 {
		turn.MaxTokens = payload.MaxTokens
	}
	turn.Temperature = payload.Temperature
	turn.SystemPrompt = extractFlexibleText(payload.System)

	for _, m := range payload.Messages {
		cm := CanonicalMessage{Role: normalizeRole(m.Role)}
		var str string
		if err := json.Unmarshal(m.Content, &str); err == nil {
			cm.Content = str
		} else {
			var blocks []struct {
				Type      string          `json:"type"`
				Text      string          `json:"text"`
				ID        string          `json:"id"`
				Name      string          `json:"name"`
				Input     json.RawMessage `json:"input"`
				ToolUseID string          `json:"tool_use_id"`
				Content   json.RawMessage `json:"content"`
			}
			if err := json.Unmarshal(m.Content, &blocks); err == nil {
				var textParts []string
				for _, b := range blocks {
					switch b.Type {
					case "text":
						if b.Text != "" {
							textParts = append(textParts, b.Text)
						}
					case "tool_use":
						cm.ToolCalls = append(cm.ToolCalls, CanonicalToolCall{
							ID:        b.ID,
							Name:      b.Name,
							Arguments: defaultJSONObject(string(b.Input)),
						})
					case "tool_result":
						cm.Role = "tool"
						cm.ToolCallID = b.ToolUseID
						textParts = append(textParts, extractFlexibleText(b.Content))
					}
				}
				cm.Content = strings.Join(textParts, "\n")
			}
		}
		turn.Messages = append(turn.Messages, cm)
	}

	for _, t := range payload.Tools {
		name := strings.TrimSpace(t.Name)
		if name == "" {
			continue
		}
		turn.CallerDeclaredTools[name] = true
		turn.Tools = append(turn.Tools, CanonicalTool{
			Name:        name,
			Description: t.Description,
			Parameters:  ensureSchema(t.InputSchema),
		})
	}
	return nil
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
			Role  string `json:"role"`
			Parts []struct {
				Text         string `json:"text"`
				FunctionCall *struct {
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
				FunctionResponse *struct {
					Name     string          `json:"name"`
					Response json.RawMessage `json:"response"`
				} `json:"functionResponse"`
			} `json:"parts"`
		} `json:"contents"`
		Tools []struct {
			FunctionDeclarations []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			} `json:"functionDeclarations"`
		} `json:"tools"`
		GenerationConfig *struct {
			MaxOutputTokens uint64   `json:"maxOutputTokens"`
			Temperature     *float64 `json:"temperature"`
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
	if payload.GenerationConfig != nil {
		if payload.GenerationConfig.MaxOutputTokens > 0 {
			turn.MaxTokens = payload.GenerationConfig.MaxOutputTokens
		}
		turn.Temperature = payload.GenerationConfig.Temperature
	}
	for _, c := range payload.Contents {
		role := "user"
		if strings.EqualFold(c.Role, "model") || strings.EqualFold(c.Role, "assistant") {
			role = "assistant"
		}
		cm := CanonicalMessage{Role: role}
		var textParts []string
		for idx, p := range c.Parts {
			if p.Text != "" {
				textParts = append(textParts, p.Text)
			}
			if p.FunctionCall != nil && p.FunctionCall.Name != "" {
				cm.ToolCalls = append(cm.ToolCalls, CanonicalToolCall{
					ID:        fmt.Sprintf("call_gem_%d", idx+1),
					Name:      p.FunctionCall.Name,
					Arguments: defaultJSONObject(string(p.FunctionCall.Args)),
				})
			}
			if p.FunctionResponse != nil {
				cm.Role = "tool"
				cm.ToolCallID = p.FunctionResponse.Name
				textParts = append(textParts, string(p.FunctionResponse.Response))
			}
		}
		cm.Content = strings.Join(textParts, "\n")
		turn.Messages = append(turn.Messages, cm)
	}
	for _, tg := range payload.Tools {
		for _, fd := range tg.FunctionDeclarations {
			name := strings.TrimSpace(fd.Name)
			if name == "" {
				continue
			}
			turn.CallerDeclaredTools[name] = true
			turn.Tools = append(turn.Tools, CanonicalTool{
				Name:        name,
				Description: fd.Description,
				Parameters:  ensureSchema(fd.Parameters),
			})
		}
	}
	return nil
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
	egress := ProviderEgressCodecWithPersona(pctx, secret, turn.IngressCodec)
	baseURL := resolveProviderBaseURL(pctx.Provider, secret.BaseURL)
	isClaudeSub := IsClaudeSubscription(pctx, secret)

	filteredTools := make([]CanonicalTool, 0, len(turn.Tools))
	for _, t := range turn.Tools {
		if ShouldStripInternalTool(cleanseMode, t.Name, turn.CallerDeclaredTools) {
			continue
		}
		filteredTools = append(filteredTools, t)
	}

	var (
		fullURL string
		bodyRaw []byte
		err     error
	)

	switch egress {
	case CodecAnthropicCountTokens:
		suffix := "/v1/messages/count_tokens"
		if isClaudeSub {
			suffix += "?beta=true"
		}
		fullURL = joinProviderPath(baseURL, suffix)
		bodyRaw, err = encodeAnthropicRequestBody(upstreamModel, turn, filteredTools, false, false, pctx, isClaudeSub)

	case CodecAnthropicMessages:
		suffix := "/v1/messages"
		if isClaudeSub {
			suffix += "?beta=true"
		}
		fullURL = joinProviderPath(baseURL, suffix)
		bodyRaw, err = encodeAnthropicRequestBody(upstreamModel, turn, filteredTools, turn.Stream, true, pctx, isClaudeSub)

	case CodecOpenAIResponses:
		fullURL = resolveCodexResponsesURL(pctx, secret)
		ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))
		forceStream := ak == "oauth" || ak == "vm_cli_seed" || strings.TrimSpace(secret.ChatGPTAccountID) != "" || strings.Contains(strings.ToLower(fullURL), "/backend-api/codex")
		bodyRaw, err = EncodeCodexResponsesRequestBody(upstreamModel, turn, filteredTools, forceStream)

	case CodecAntigravityInternal:
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = joinProviderPath(baseURL, "/v1internal"+action)
		bodyRaw, err = EncodeAntigravityRequestBody(upstreamModel, pctx, secret, turn, filteredTools)

	case CodecGeminiGenerate:
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = joinProviderPath(baseURL, "/v1beta/models/"+upstreamModel+action)
		bodyRaw, err = encodeGeminiRequestBody(turn, filteredTools)

	default:
		fullURL = joinOpenAIChatPath(baseURL)
		bodyRaw, err = encodeOpenAIChatRequestBody(upstreamModel, turn, filteredTools)
	}
	if err != nil {
		return nil, egress, err
	}

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
			ApplyClaudeSubscriptionHeaders(req, secret)
		} else {
			if secret.APIKey != "" {
				req.Header.Set("x-api-key", secret.APIKey)
			}
			req.Header.Set("anthropic-version", "2023-06-01")
		}
	case CodecOpenAIResponses:
		ApplyCodexSubscriptionHeaders(req, pctx, secret)
	case CodecAntigravityInternal:
		ApplyAntigravityHeaders(req, pctx, secret)
	case CodecGeminiGenerate:
		if secret.APIKey != "" {
			req.Header.Set("x-goog-api-key", secret.APIKey)
		}
	default:
		if secret.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+secret.APIKey)
		}
	}

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
) ([]byte, error) {
	payload := map[string]any{
		"model": model,
	}
	if includeMaxTokens {
		maxTok := turn.MaxTokens
		if maxTok == 0 {
			maxTok = 1024
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
	if turn.Temperature != nil {
		payload["temperature"] = *turn.Temperature
	}
	if isClaudeSub {
		sysBlocks := []map[string]any{
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

	msgs := make([]map[string]any, 0, max(1, len(turn.Messages)))
	for _, m := range turn.Messages {
		switch m.Role {
		case "tool":
			msgs = append(msgs, map[string]any{
				"role": "user",
				"content": []map[string]any{
					{
						"type":        "tool_result",
						"tool_use_id": firstNonEmpty(m.ToolCallID, "toolu_1"),
						"content":     m.Content,
					},
				},
			})
		case "assistant":
			if len(m.ToolCalls) > 0 {
				var blocks []map[string]any
				if m.Content != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
				}
				for _, tc := range m.ToolCalls {
					var inputObj any = map[string]any{}
					_ = json.Unmarshal([]byte(defaultJSONObject(tc.Arguments)), &inputObj)
					blocks = append(blocks, map[string]any{
						"type":  "tool_use",
						"id":    firstNonEmpty(tc.ID, "toolu_call"),
						"name":  tc.Name,
						"input": inputObj,
					})
				}
				msgs = append(msgs, map[string]any{"role": "assistant", "content": blocks})
			} else {
				msgs = append(msgs, map[string]any{"role": "assistant", "content": m.Content})
			}
		default:
			msgs = append(msgs, map[string]any{"role": "user", "content": m.Content})
		}
	}
	if len(msgs) == 0 {
		msgs = append(msgs, map[string]any{"role": "user", "content": "Hello"})
	}
	payload["messages"] = msgs

	if len(tools) > 0 {
		antTools := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			antTools = append(antTools, map[string]any{
				"name":         t.Name,
				"description":  t.Description,
				"input_schema": ensureSchema(t.Parameters),
			})
		}
		payload["tools"] = antTools
	}
	return json.Marshal(payload)
}

func encodeOpenAIChatRequestBody(model string, turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
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
			msgs = append(msgs, map[string]any{"role": "user", "content": m.Content})
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
	if turn.MaxTokens > 0 {
		payload["max_tokens"] = turn.MaxTokens
	}
	if turn.Temperature != nil {
		payload["temperature"] = *turn.Temperature
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
	}
	return json.Marshal(payload)
}

func encodeGeminiRequestBody(turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	payload := map[string]any{}
	if turn.SystemPrompt != "" {
		payload["systemInstruction"] = map[string]any{
			"parts": []map[string]any{{"text": turn.SystemPrompt}},
		}
	}
	var contents []map[string]any
	for _, m := range turn.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		var parts []map[string]any
		if m.Content != "" || len(m.ToolCalls) == 0 {
			parts = append(parts, map[string]any{"text": m.Content})
		}
		for _, tc := range m.ToolCalls {
			var argsObj any = map[string]any{}
			_ = json.Unmarshal([]byte(defaultJSONObject(tc.Arguments)), &argsObj)
			parts = append(parts, map[string]any{
				"functionCall": map[string]any{
					"name": tc.Name,
					"args": argsObj,
				},
			})
		}
		contents = append(contents, map[string]any{
			"role":  role,
			"parts": parts,
		})
	}
	if len(contents) == 0 {
		contents = append(contents, map[string]any{
			"role":  "user",
			"parts": []map[string]any{{"text": "Hello"}},
		})
	}
	payload["contents"] = contents

	genCfg := map[string]any{}
	if turn.MaxTokens > 0 {
		genCfg["maxOutputTokens"] = turn.MaxTokens
	}
	if turn.Temperature != nil {
		genCfg["temperature"] = *turn.Temperature
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
	}
	return json.Marshal(payload)
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

	if resp.StatusCode >= 400 {
		rawErr, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
		WriteProtocolError(w, turn.IngressCodec, resp.StatusCode, "upstream_error", "upstream_http_"+strconv.Itoa(resp.StatusCode), extractErrorMessage(rawErr, resp.Status))
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

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	isUpstreamSSE := strings.Contains(contentType, "text/event-stream")

	if !turn.Stream && isUpstreamSSE {
		// Upstream forced SSE (e.g., ChatGPT Codex OAuth backend) while caller requested unary JSON:
		// transcode SSE into an in-memory Anthropic SSE recorder, then parse into canonical unary result.
		rec := httptest.NewRecorder()
		synthTurn := *turn
		synthTurn.IngressCodec = CodecAnthropicMessages
		synthTurn.Stream = true
		sseMetrics, sseErr := streamTranscodeSSE(rec, resp.Body, egress, &synthTurn, publicModel, cleanseMode, startedAt, metrics, onVisibleToolDelta)
		res := parseRecordedAnthropicSSE(rec.Body.Bytes(), sseMetrics.InputTokens, sseMetrics.OutputTokens)
		writeUnaryIngressResponse(w, turn, publicModel, res)
		return sseMetrics, sseErr
	}

	if !isUpstreamSSE {
		rawBody, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
		if err != nil {
			return metrics, err
		}
		res, parseErr := parseUnaryUpstream(egress, rawBody, turn.EstimatedInputTokens)
		if parseErr != nil {
			return metrics, parseErr
		}
		res.ToolCalls = filterCanonicalToolCalls(res.ToolCalls, cleanseMode, turn.CallerDeclaredTools)
		if len(res.ToolCalls) > 0 && onVisibleToolDelta != nil {
			onVisibleToolDelta()
		}
		if len(res.ToolCalls) == 0 && (res.StopReason == "tool_use" || res.StopReason == "tool_calls") {
			res.StopReason = "stop"
		}

		metrics.InputTokens = res.InputTokens
		metrics.OutputTokens = res.OutputTokens
		metrics.CacheReadTokens = res.CacheReadTokens
		metrics.CacheWriteTokens = res.CacheWriteTokens
		metrics.TTFTMs = elapsedMs(startedAt)

		if turn.Stream {
			emitUnaryAsSSE(w, turn.IngressCodec, publicModel, res)
		} else {
			writeUnaryIngressResponse(w, turn, publicModel, res)
		}
		return metrics, nil
	}

	return streamTranscodeSSE(w, resp.Body, egress, turn, publicModel, cleanseMode, startedAt, metrics, onVisibleToolDelta)
}

func parseRecordedAnthropicSSE(raw []byte, inTok, outTok uint64) canonicalResult {
	res := canonicalResult{
		ID:           fmt.Sprintf("sg_%d", time.Now().UnixNano()),
		StopReason:   "stop",
		InputTokens:  inTok,
		OutputTokens: outTok,
	}
	type blockAcc struct {
		id   string
		name string
		args strings.Builder
	}
	tools := make(map[int]*blockAcc)
	var textBuf strings.Builder

	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var ev struct {
			Type         string `json:"type"`
			Index        int    `json:"index"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
			} `json:"delta"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "content_block_start":
			if ev.ContentBlock.Type == "tool_use" {
				tools[ev.Index] = &blockAcc{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			}
		case "content_block_delta":
			if ev.Delta.Type == "text_delta" {
				textBuf.WriteString(ev.Delta.Text)
			} else if ev.Delta.Type == "input_json_delta" {
				if t, ok := tools[ev.Index]; ok {
					t.args.WriteString(ev.Delta.PartialJSON)
				}
			}
		}
	}
	res.Text = textBuf.String()
	for _, t := range tools {
		res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
			ID:        t.id,
			Name:      t.name,
			Arguments: defaultJSONObject(t.args.String()),
		})
	}
	if len(res.ToolCalls) > 0 {
		res.StopReason = "tool_calls"
	}
	return res
}

func parseUnaryUpstream(egress CodecKind, raw []byte, fallbackIn uint64) (canonicalResult, error) {
	res := canonicalResult{
		ID:         fmt.Sprintf("sg_%d", time.Now().UnixNano()),
		StopReason: "stop",
	}

	switch egress {
	case CodecAnthropicMessages:
		var ant struct {
			ID         string `json:"id"`
			StopReason string `json:"stop_reason"`
			Content    []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				ID    string          `json:"id"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
			Usage struct {
				InputTokens              uint64 `json:"input_tokens"`
				OutputTokens             uint64 `json:"output_tokens"`
				CacheReadInputTokens     uint64 `json:"cache_read_input_tokens"`
				CacheCreationInputTokens uint64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &ant); err != nil {
			return res, fmt.Errorf("decode Anthropic response: %w", err)
		}
		if ant.ID != "" {
			res.ID = ant.ID
		}
		if ant.StopReason != "" {
			res.StopReason = ant.StopReason
		}
		var texts []string
		for _, b := range ant.Content {
			switch b.Type {
			case "text":
				texts = append(texts, b.Text)
			case "tool_use":
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
					ID:        firstNonEmpty(b.ID, "call_1"),
					Name:      b.Name,
					Arguments: defaultJSONObject(string(b.Input)),
				})
			}
		}
		res.Text = strings.Join(texts, "")
		res.InputTokens = max(fallbackIn, ant.Usage.InputTokens)
		res.OutputTokens = ant.Usage.OutputTokens
		res.CacheReadTokens = ant.Usage.CacheReadInputTokens
		res.CacheWriteTokens = ant.Usage.CacheCreationInputTokens

	case CodecOpenAIResponses:
		var respObj struct {
			ID         string `json:"id"`
			OutputText string `json:"output_text"`
			Output     []struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
				Content   []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"output"`
			Usage struct {
				InputTokens        uint64 `json:"input_tokens"`
				OutputTokens       uint64 `json:"output_tokens"`
				InputTokensDetails struct {
					CachedTokens uint64 `json:"cached_tokens"`
				} `json:"input_tokens_details"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &respObj); err != nil {
			return res, fmt.Errorf("decode OpenAI Responses payload: %w", err)
		}
		if respObj.ID != "" {
			res.ID = respObj.ID
		}
		var texts []string
		for _, item := range respObj.Output {
			switch item.Type {
			case "message":
				for _, c := range item.Content {
					if c.Text != "" {
						texts = append(texts, c.Text)
					}
				}
			case "function_call":
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
					ID:        firstNonEmpty(item.CallID, "call_1"),
					Name:      item.Name,
					Arguments: defaultJSONObject(item.Arguments),
				})
			}
		}
		res.Text = strings.Join(texts, "")
		if res.Text == "" && respObj.OutputText != "" {
			res.Text = respObj.OutputText
		}
		if len(res.ToolCalls) > 0 {
			res.StopReason = "tool_calls"
		}
		res.InputTokens = max(fallbackIn, respObj.Usage.InputTokens)
		res.OutputTokens = respObj.Usage.OutputTokens
		res.CacheReadTokens = respObj.Usage.InputTokensDetails.CachedTokens

	case CodecGeminiGenerate, CodecAntigravityInternal:
		payloadRaw := unwrapAntigravityResponse(raw)
		var gem struct {
			Candidates []struct {
				FinishReason string `json:"finishReason"`
				Content      struct {
					Parts []struct {
						Text         string `json:"text"`
						FunctionCall *struct {
							Name string          `json:"name"`
							Args json.RawMessage `json:"args"`
						} `json:"functionCall"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
			UsageMetadata struct {
				PromptTokenCount        uint64 `json:"promptTokenCount"`
				CandidatesTokenCount    uint64 `json:"candidatesTokenCount"`
				CachedContentTokenCount uint64 `json:"cachedContentTokenCount"`
			} `json:"usageMetadata"`
		}
		if err := json.Unmarshal(payloadRaw, &gem); err != nil {
			return res, fmt.Errorf("decode Gemini/Antigravity response: %w", err)
		}
		var texts []string
		for _, cand := range gem.Candidates {
			if cand.FinishReason != "" {
				res.StopReason = strings.ToLower(cand.FinishReason)
			}
			for idx, p := range cand.Content.Parts {
				if p.Text != "" {
					texts = append(texts, p.Text)
				}
				if p.FunctionCall != nil && p.FunctionCall.Name != "" {
					res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
						ID:        fmt.Sprintf("call_gem_%d", idx+1),
						Name:      p.FunctionCall.Name,
						Arguments: defaultJSONObject(string(p.FunctionCall.Args)),
					})
				}
			}
		}
		res.Text = strings.Join(texts, "")
		res.InputTokens = max(fallbackIn, gem.UsageMetadata.PromptTokenCount)
		res.OutputTokens = gem.UsageMetadata.CandidatesTokenCount
		res.CacheReadTokens = gem.UsageMetadata.CachedContentTokenCount

	default:
		var oa struct {
			ID      string `json:"id"`
			Choices []struct {
				FinishReason string `json:"finish_reason"`
				Message      struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"message"`
			} `json:"choices"`
			Usage struct {
				PromptTokens        uint64 `json:"prompt_tokens"`
				CompletionTokens    uint64 `json:"completion_tokens"`
				PromptTokensDetails struct {
					CachedTokens uint64 `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &oa); err != nil {
			return res, fmt.Errorf("decode OpenAI response: %w", err)
		}
		if oa.ID != "" {
			res.ID = oa.ID
		}
		if len(oa.Choices) > 0 {
			ch := oa.Choices[0]
			res.Text = ch.Message.Content
			if ch.FinishReason != "" {
				res.StopReason = ch.FinishReason
			}
			for _, tc := range ch.Message.ToolCalls {
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
					ID:        firstNonEmpty(tc.ID, "call_1"),
					Name:      tc.Function.Name,
					Arguments: defaultJSONObject(tc.Function.Arguments),
				})
			}
		}
		res.InputTokens = max(fallbackIn, oa.Usage.PromptTokens)
		res.OutputTokens = oa.Usage.CompletionTokens
		res.CacheReadTokens = oa.Usage.PromptTokensDetails.CachedTokens
	}

	if res.OutputTokens == 0 && len(res.Text) > 0 {
		res.OutputTokens = uint64(max(1, (len(res.Text)+3)/4))
	}
	return res, nil
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

func writeUnaryIngressResponse(w http.ResponseWriter, turn *CanonicalTurn, publicModel string, res canonicalResult) {
	switch turn.IngressCodec {
	case CodecAnthropicMessages:
		var content []map[string]any
		if res.Text != "" || len(res.ToolCalls) == 0 {
			content = append(content, map[string]any{"type": "text", "text": res.Text})
		}
		for _, tc := range res.ToolCalls {
			var inputObj any = map[string]any{}
			_ = json.Unmarshal([]byte(defaultJSONObject(tc.Arguments)), &inputObj)
			content = append(content, map[string]any{
				"type":  "tool_use",
				"id":    firstNonEmpty(tc.ID, "toolu_01"),
				"name":  tc.Name,
				"input": inputObj,
			})
		}
		stop := "end_turn"
		if len(res.ToolCalls) > 0 {
			stop = "tool_use"
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":          ensurePrefix(res.ID, "msg_"),
			"type":        "message",
			"role":        "assistant",
			"model":       publicModel,
			"content":     content,
			"stop_reason": stop,
			"usage": map[string]any{
				"input_tokens":                res.InputTokens,
				"output_tokens":               res.OutputTokens,
				"cache_read_input_tokens":     res.CacheReadTokens,
				"cache_creation_input_tokens": res.CacheWriteTokens,
			},
		})

	case CodecOpenAIResponses:
		output := []map[string]any{
			{
				"type":   "message",
				"id":     "msg_" + res.ID,
				"status": "completed",
				"role":   "assistant",
				"content": []map[string]any{
					{"type": "output_text", "text": res.Text, "annotations": []any{}},
				},
			},
		}
		for _, tc := range res.ToolCalls {
			output = append(output, map[string]any{
				"type":      "function_call",
				"call_id":   firstNonEmpty(tc.ID, "call_01"),
				"name":      tc.Name,
				"arguments": defaultJSONObject(tc.Arguments),
			})
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":          ensurePrefix(res.ID, "resp_"),
			"object":      "response",
			"created_at":  time.Now().Unix(),
			"status":      "completed",
			"model":       publicModel,
			"output":      output,
			"output_text": res.Text,
			"usage": map[string]any{
				"input_tokens":  res.InputTokens,
				"output_tokens": res.OutputTokens,
				"total_tokens":  res.InputTokens + res.OutputTokens,
			},
		})

	case CodecGeminiGenerate:
		var parts []map[string]any
		if res.Text != "" || len(res.ToolCalls) == 0 {
			parts = append(parts, map[string]any{"text": res.Text})
		}
		for _, tc := range res.ToolCalls {
			var argsObj any = map[string]any{}
			_ = json.Unmarshal([]byte(defaultJSONObject(tc.Arguments)), &argsObj)
			parts = append(parts, map[string]any{
				"functionCall": map[string]any{"name": tc.Name, "args": argsObj},
			})
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"candidates": []map[string]any{
				{
					"index":        0,
					"content":      map[string]any{"role": "model", "parts": parts},
					"finishReason": "STOP",
				},
			},
			"usageMetadata": map[string]any{
				"promptTokenCount":     res.InputTokens,
				"candidatesTokenCount": res.OutputTokens,
				"totalTokenCount":      res.InputTokens + res.OutputTokens,
			},
		})

	case CodecMCPJSONRPC:
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      turn.MCPID,
			"result": map[string]any{
				"model": publicModel,
				"content": []map[string]any{
					{"type": "text", "text": res.Text},
				},
				"isError": false,
			},
		})

	default:
		msg := map[string]any{
			"role":    "assistant",
			"content": res.Text,
		}
		finish := "stop"
		if len(res.ToolCalls) > 0 {
			var calls []map[string]any
			for _, tc := range res.ToolCalls {
				calls = append(calls, map[string]any{
					"id":   firstNonEmpty(tc.ID, "call_01"),
					"type": "function",
					"function": map[string]any{
						"name":      tc.Name,
						"arguments": defaultJSONObject(tc.Arguments),
					},
				})
			}
			msg["tool_calls"] = calls
			finish = "tool_calls"
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":      ensurePrefix(res.ID, "chatcmpl_"),
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   publicModel,
			"choices": []map[string]any{
				{"index": 0, "message": msg, "finish_reason": finish},
			},
			"usage": map[string]any{
				"prompt_tokens":     res.InputTokens,
				"completion_tokens": res.OutputTokens,
				"total_tokens":      res.InputTokens + res.OutputTokens,
			},
		})
	}
}

type sseSink struct {
	w                  http.ResponseWriter
	flusher            http.Flusher
	ingress            CodecKind
	model              string
	streamID           string
	started            bool
	anthropicTextOpen  bool
	anthropicNextIndex int
	openAIToolIndex    int
	emittedToolCalls   int
	emittedChars       int
}

func newSSESink(w http.ResponseWriter, ingress CodecKind, model string) *sseSink {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	return &sseSink{
		w:        w,
		flusher:  flusher,
		ingress:  ingress,
		model:    model,
		streamID: fmt.Sprintf("sg_%d", time.Now().UnixNano()),
	}
}

func (s *sseSink) ensureStarted(inTokens uint64) {
	if s.started {
		return
	}
	s.started = true
	switch s.ingress {
	case CodecAnthropicMessages:
		writeSSEEvent(s.w, "message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id":      "msg_" + s.streamID,
				"type":    "message",
				"role":    "assistant",
				"model":   s.model,
				"content": []any{},
				"usage":   map[string]any{"input_tokens": inTokens, "output_tokens": 0},
			},
		})
	case CodecOpenAIResponses:
		writeSSEEvent(s.w, "response.created", map[string]any{
			"type": "response.created",
			"response": map[string]any{
				"id":     "resp_" + s.streamID,
				"object": "response",
				"status": "in_progress",
				"model":  s.model,
			},
		})
	case CodecOpenAIChat:
		writeSSEData(s.w, map[string]any{
			"id":      "chatcmpl_" + s.streamID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   s.model,
			"choices": []map[string]any{
				{"index": 0, "delta": map[string]any{"role": "assistant"}},
			},
		})
	}
	s.flush()
}

func (s *sseSink) emitText(delta string, inTokens uint64) {
	if delta == "" {
		return
	}
	s.ensureStarted(inTokens)
	s.emittedChars += len(delta)

	switch s.ingress {
	case CodecAnthropicMessages:
		if !s.anthropicTextOpen {
			s.anthropicTextOpen = true
			writeSSEEvent(s.w, "content_block_start", map[string]any{
				"type":          "content_block_start",
				"index":         s.anthropicNextIndex,
				"content_block": map[string]any{"type": "text", "text": ""},
			})
		}
		writeSSEEvent(s.w, "content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": s.anthropicNextIndex,
			"delta": map[string]any{"type": "text_delta", "text": delta},
		})
	case CodecOpenAIResponses:
		writeSSEEvent(s.w, "response.output_text.delta", map[string]any{
			"type":  "response.output_text.delta",
			"delta": delta,
		})
	case CodecGeminiGenerate:
		writeSSEData(s.w, map[string]any{
			"candidates": []map[string]any{
				{"index": 0, "content": map[string]any{"role": "model", "parts": []map[string]any{{"text": delta}}}},
			},
		})
	default:
		writeSSEData(s.w, map[string]any{
			"id":      "chatcmpl_" + s.streamID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   s.model,
			"choices": []map[string]any{
				{"index": 0, "delta": map[string]any{"content": delta}},
			},
		})
	}
	s.flush()
}

func (s *sseSink) emitToolCall(tc CanonicalToolCall, inTokens uint64) {
	s.ensureStarted(inTokens)
	s.emittedToolCalls++
	argsJSON := defaultJSONObject(tc.Arguments)

	switch s.ingress {
	case CodecAnthropicMessages:
		if s.anthropicTextOpen {
			writeSSEEvent(s.w, "content_block_stop", map[string]any{
				"type":  "content_block_stop",
				"index": s.anthropicNextIndex,
			})
			s.anthropicTextOpen = false
			s.anthropicNextIndex++
		}
		idx := s.anthropicNextIndex
		s.anthropicNextIndex++
		writeSSEEvent(s.w, "content_block_start", map[string]any{
			"type":          "content_block_start",
			"index":         idx,
			"content_block": map[string]any{"type": "tool_use", "id": firstNonEmpty(tc.ID, "toolu_01"), "name": tc.Name, "input": map[string]any{}},
		})
		writeSSEEvent(s.w, "content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": idx,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": argsJSON},
		})
		writeSSEEvent(s.w, "content_block_stop", map[string]any{
			"type":  "content_block_stop",
			"index": idx,
		})
	case CodecOpenAIResponses:
		writeSSEEvent(s.w, "response.output_item.done", map[string]any{
			"type": "response.output_item.done",
			"item": map[string]any{
				"type":      "function_call",
				"call_id":   firstNonEmpty(tc.ID, "call_01"),
				"name":      tc.Name,
				"arguments": argsJSON,
			},
		})
	case CodecGeminiGenerate:
		var argsObj any = map[string]any{}
		_ = json.Unmarshal([]byte(argsJSON), &argsObj)
		writeSSEData(s.w, map[string]any{
			"candidates": []map[string]any{
				{
					"index": 0,
					"content": map[string]any{
						"role":  "model",
						"parts": []map[string]any{{"functionCall": map[string]any{"name": tc.Name, "args": argsObj}}},
					},
				},
			},
		})
	default:
		idx := s.openAIToolIndex
		s.openAIToolIndex++
		writeSSEData(s.w, map[string]any{
			"id":      "chatcmpl_" + s.streamID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   s.model,
			"choices": []map[string]any{
				{
					"index": 0,
					"delta": map[string]any{
						"tool_calls": []map[string]any{
							{
								"index": idx,
								"id":    firstNonEmpty(tc.ID, fmt.Sprintf("call_%d", idx+1)),
								"type":  "function",
								"function": map[string]any{
									"name":      tc.Name,
									"arguments": argsJSON,
								},
							},
						},
					},
				},
			},
		})
	}
	s.flush()
}

func (s *sseSink) finish(inTokens, outTokens uint64) {
	s.ensureStarted(inTokens)
	switch s.ingress {
	case CodecAnthropicMessages:
		if s.anthropicTextOpen {
			writeSSEEvent(s.w, "content_block_stop", map[string]any{
				"type":  "content_block_stop",
				"index": s.anthropicNextIndex,
			})
			s.anthropicTextOpen = false
		}
		stop := "end_turn"
		if s.emittedToolCalls > 0 {
			stop = "tool_use"
		}
		writeSSEEvent(s.w, "message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": stop},
			"usage": map[string]any{"output_tokens": outTokens},
		})
		writeSSEEvent(s.w, "message_stop", map[string]any{"type": "message_stop"})
	case CodecOpenAIResponses:
		writeSSEEvent(s.w, "response.completed", map[string]any{
			"type": "response.completed",
			"response": map[string]any{
				"id":     "resp_" + s.streamID,
				"object": "response",
				"status": "completed",
				"model":  s.model,
				"usage": map[string]any{
					"input_tokens":  inTokens,
					"output_tokens": outTokens,
					"total_tokens":  inTokens + outTokens,
				},
			},
		})
	case CodecGeminiGenerate:
		writeSSEData(s.w, map[string]any{
			"candidates": []map[string]any{
				{"index": 0, "content": map[string]any{"role": "model", "parts": []any{}}, "finishReason": "STOP"},
			},
			"usageMetadata": map[string]any{
				"promptTokenCount":     inTokens,
				"candidatesTokenCount": outTokens,
				"totalTokenCount":      inTokens + outTokens,
			},
		})
	default:
		finish := "stop"
		if s.emittedToolCalls > 0 {
			finish = "tool_calls"
		}
		writeSSEData(s.w, map[string]any{
			"id":      "chatcmpl_" + s.streamID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   s.model,
			"choices": []map[string]any{
				{"index": 0, "delta": map[string]any{}, "finish_reason": finish},
			},
			"usage": map[string]any{
				"prompt_tokens":     inTokens,
				"completion_tokens": outTokens,
				"total_tokens":      inTokens + outTokens,
			},
		})
		_, _ = io.WriteString(s.w, "data: [DONE]\n\n")
	}
	s.flush()
}

func (s *sseSink) flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

func emitUnaryAsSSE(w http.ResponseWriter, ingress CodecKind, model string, res canonicalResult) {
	sink := newSSESink(w, ingress, model)
	if res.Text != "" {
		sink.emitText(res.Text, res.InputTokens)
	}
	for _, tc := range res.ToolCalls {
		sink.emitToolCall(tc, res.InputTokens)
	}
	sink.finish(res.InputTokens, res.OutputTokens)
}

func streamTranscodeSSE(
	w http.ResponseWriter,
	body io.Reader,
	egress CodecKind,
	turn *CanonicalTurn,
	publicModel string,
	cleanseMode string,
	startedAt time.Time,
	metrics RelayMetrics,
	onVisibleToolDelta func(),
) (RelayMetrics, error) {
	sink := newSSESink(w, turn.IngressCodec, publicModel)
	metrics.InputTokens = turn.EstimatedInputTokens

	type partialTool struct {
		id       string
		name     string
		argsBuf  strings.Builder
		stripped bool
		emitted  bool
	}
	activeTools := make(map[int]*partialTool)

	flushTool := func(pt *partialTool) {
		if pt == nil || pt.emitted || pt.name == "" || pt.stripped {
			return
		}
		pt.emitted = true
		if onVisibleToolDelta != nil {
			onVisibleToolDelta()
		}
		if metrics.TTFTMs == 0 {
			metrics.TTFTMs = elapsedMs(startedAt)
		}
		sink.emitToolCall(CanonicalToolCall{
			ID:        pt.id,
			Name:      pt.name,
			Arguments: defaultJSONObject(pt.argsBuf.String()),
		}, metrics.InputTokens)
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		dataStr := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if dataStr == "" || dataStr == "[DONE]" {
			continue
		}

		switch egress {
		case CodecAnthropicMessages:
			var ev struct {
				Type    string `json:"type"`
				Index   int    `json:"index"`
				Message struct {
					Usage struct {
						InputTokens              uint64 `json:"input_tokens"`
						OutputTokens             uint64 `json:"output_tokens"`
						CacheReadInputTokens     uint64 `json:"cache_read_input_tokens"`
						CacheCreationInputTokens uint64 `json:"cache_creation_input_tokens"`
					} `json:"usage"`
				} `json:"message"`
				ContentBlock struct {
					Type  string          `json:"type"`
					ID    string          `json:"id"`
					Name  string          `json:"name"`
					Input json.RawMessage `json:"input"`
				} `json:"content_block"`
				Delta struct {
					Type        string `json:"type"`
					Text        string `json:"text"`
					PartialJSON string `json:"partial_json"`
				} `json:"delta"`
				Usage struct {
					OutputTokens uint64 `json:"output_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(dataStr), &ev) != nil {
				continue
			}
			switch ev.Type {
			case "message_start":
				if ev.Message.Usage.InputTokens > 0 {
					metrics.InputTokens = ev.Message.Usage.InputTokens
				}
				metrics.CacheReadTokens += ev.Message.Usage.CacheReadInputTokens
				metrics.CacheWriteTokens += ev.Message.Usage.CacheCreationInputTokens
			case "content_block_start":
				if ev.ContentBlock.Type == "tool_use" {
					pt := &partialTool{
						id:       ev.ContentBlock.ID,
						name:     ev.ContentBlock.Name,
						stripped: ShouldStripInternalTool(cleanseMode, ev.ContentBlock.Name, turn.CallerDeclaredTools),
					}
					if len(ev.ContentBlock.Input) > 0 && string(ev.ContentBlock.Input) != "{}" {
						pt.argsBuf.Write(ev.ContentBlock.Input)
					}
					activeTools[ev.Index] = pt
				}
			case "content_block_delta":
				if ev.Delta.Type == "text_delta" && ev.Delta.Text != "" {
					if metrics.TTFTMs == 0 {
						metrics.TTFTMs = elapsedMs(startedAt)
					}
					sink.emitText(ev.Delta.Text, metrics.InputTokens)
				} else if ev.Delta.Type == "input_json_delta" {
					if pt, ok := activeTools[ev.Index]; ok {
						pt.argsBuf.WriteString(ev.Delta.PartialJSON)
					}
				}
			case "content_block_stop":
				if pt, ok := activeTools[ev.Index]; ok {
					flushTool(pt)
				}
			case "message_delta":
				if ev.Usage.OutputTokens > 0 {
					metrics.OutputTokens = ev.Usage.OutputTokens
				}
			}

		case CodecOpenAIResponses:
			var ev struct {
				Type  string `json:"type"`
				Delta string `json:"delta"`
				Item  struct {
					Type      string `json:"type"`
					CallID    string `json:"call_id"`
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"item"`
				Response struct {
					Usage struct {
						InputTokens        uint64 `json:"input_tokens"`
						OutputTokens       uint64 `json:"output_tokens"`
						InputTokensDetails struct {
							CachedTokens uint64 `json:"cached_tokens"`
						} `json:"input_tokens_details"`
					} `json:"usage"`
				} `json:"response"`
			}
			if json.Unmarshal([]byte(dataStr), &ev) != nil {
				continue
			}
			switch ev.Type {
			case "response.output_text.delta":
				if ev.Delta != "" {
					if metrics.TTFTMs == 0 {
						metrics.TTFTMs = elapsedMs(startedAt)
					}
					sink.emitText(ev.Delta, metrics.InputTokens)
				}
			case "response.output_item.done":
				if ev.Item.Type == "function_call" && ev.Item.Name != "" {
					if !ShouldStripInternalTool(cleanseMode, ev.Item.Name, turn.CallerDeclaredTools) {
						if onVisibleToolDelta != nil {
							onVisibleToolDelta()
						}
						if metrics.TTFTMs == 0 {
							metrics.TTFTMs = elapsedMs(startedAt)
						}
						sink.emitToolCall(CanonicalToolCall{
							ID:        firstNonEmpty(ev.Item.CallID, "call_codex_1"),
							Name:      ev.Item.Name,
							Arguments: defaultJSONObject(ev.Item.Arguments),
						}, metrics.InputTokens)
					}
				}
			case "response.completed":
				if ev.Response.Usage.InputTokens > 0 {
					metrics.InputTokens = ev.Response.Usage.InputTokens
				}
				if ev.Response.Usage.OutputTokens > 0 {
					metrics.OutputTokens = ev.Response.Usage.OutputTokens
				}
				if ev.Response.Usage.InputTokensDetails.CachedTokens > 0 {
					metrics.CacheReadTokens = ev.Response.Usage.InputTokensDetails.CachedTokens
				}
			}

		case CodecGeminiGenerate, CodecAntigravityInternal:
			unwrapped := unwrapAntigravityResponse([]byte(dataStr))
			var chunk struct {
				Candidates []struct {
					Content struct {
						Parts []struct {
							Text         string `json:"text"`
							FunctionCall *struct {
								Name string          `json:"name"`
								Args json.RawMessage `json:"args"`
							} `json:"functionCall"`
						} `json:"parts"`
					} `json:"content"`
				} `json:"candidates"`
				UsageMetadata struct {
					PromptTokenCount     uint64 `json:"promptTokenCount"`
					CandidatesTokenCount uint64 `json:"candidatesTokenCount"`
				} `json:"usageMetadata"`
			}
			if json.Unmarshal(unwrapped, &chunk) != nil {
				continue
			}
			if chunk.UsageMetadata.PromptTokenCount > 0 {
				metrics.InputTokens = chunk.UsageMetadata.PromptTokenCount
			}
			if chunk.UsageMetadata.CandidatesTokenCount > 0 {
				metrics.OutputTokens = chunk.UsageMetadata.CandidatesTokenCount
			}
			for _, cand := range chunk.Candidates {
				for idx, p := range cand.Content.Parts {
					if p.Text != "" {
						if metrics.TTFTMs == 0 {
							metrics.TTFTMs = elapsedMs(startedAt)
						}
						sink.emitText(p.Text, metrics.InputTokens)
					}
					if p.FunctionCall != nil && p.FunctionCall.Name != "" {
						if !ShouldStripInternalTool(cleanseMode, p.FunctionCall.Name, turn.CallerDeclaredTools) {
							if onVisibleToolDelta != nil {
								onVisibleToolDelta()
							}
							if metrics.TTFTMs == 0 {
								metrics.TTFTMs = elapsedMs(startedAt)
							}
							sink.emitToolCall(CanonicalToolCall{
								ID:        fmt.Sprintf("call_gem_%d", idx+1),
								Name:      p.FunctionCall.Name,
								Arguments: defaultJSONObject(string(p.FunctionCall.Args)),
							}, metrics.InputTokens)
						}
					}
				}
			}

		default:
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content   string `json:"content"`
						ToolCalls []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
				} `json:"choices"`
				Usage *struct {
					PromptTokens     uint64 `json:"prompt_tokens"`
					CompletionTokens uint64 `json:"completion_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(dataStr), &chunk) != nil {
				continue
			}
			if chunk.Usage != nil {
				if chunk.Usage.PromptTokens > 0 {
					metrics.InputTokens = chunk.Usage.PromptTokens
				}
				if chunk.Usage.CompletionTokens > 0 {
					metrics.OutputTokens = chunk.Usage.CompletionTokens
				}
			}
			for _, ch := range chunk.Choices {
				if ch.Delta.Content != "" {
					if metrics.TTFTMs == 0 {
						metrics.TTFTMs = elapsedMs(startedAt)
					}
					sink.emitText(ch.Delta.Content, metrics.InputTokens)
				}
				for _, tc := range ch.Delta.ToolCalls {
					pt, ok := activeTools[tc.Index]
					if !ok {
						pt = &partialTool{}
						activeTools[tc.Index] = pt
					}
					if tc.ID != "" {
						pt.id = tc.ID
					}
					if tc.Function.Name != "" {
						pt.name = tc.Function.Name
						pt.stripped = ShouldStripInternalTool(cleanseMode, pt.name, turn.CallerDeclaredTools)
					}
					if tc.Function.Arguments != "" {
						pt.argsBuf.WriteString(tc.Function.Arguments)
					}
				}
			}
		}
	}

	for _, pt := range activeTools {
		flushTool(pt)
	}
	if metrics.OutputTokens == 0 && sink.emittedChars > 0 {
		metrics.OutputTokens = uint64(max(1, (sink.emittedChars+3)/4))
	}
	if metrics.TTFTMs == 0 {
		metrics.TTFTMs = elapsedMs(startedAt)
	}
	sink.finish(metrics.InputTokens, metrics.OutputTokens)
	return metrics, scanner.Err()
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
				"type":    errType,
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
		return "https://api.minimax.chat/v1"
	case "qwen":
		return "https://dashscope.aliyuncs.com/compatible-mode/v1"
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
