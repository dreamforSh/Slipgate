package dataplane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ProbeEvent is one message of the admin "test account" stream (sent to the console as SSE `data:` lines).
//
//	start → delta* → done           (text: success, or an upstream error reported in done.success=false)
//	start → media* → done           (image / speech: one media event per image or the audio clip)
//	start → progress* → media? → done   (video: task status while it renders, then the clip)
//	start → progress? → delta? → done   (transcription: the transcript as one delta)
//	error                           (the probe could not be dispatched at all)
type ProbeEvent struct {
	Type  string `json:"type"`
	Kind  string `json:"kind,omitempty"`
	Model string `json:"model,omitempty"`
	// Text is a reply delta, a transcript, or the status line of a progress event.
	Text string `json:"text,omitempty"`
	// Progress is a video task's completion percentage (progress events), when the provider reports it.
	Progress     int    `json:"progress,omitempty"`
	Success      bool   `json:"success,omitempty"`
	Status       int    `json:"status,omitempty"`
	Code         string `json:"code,omitempty"`
	Message      string `json:"message,omitempty"`
	TTFTMs       int64  `json:"ttftMs,omitempty"`
	DurationMs   int64  `json:"durationMs,omitempty"`
	InputTokens  uint64 `json:"inputTokens,omitempty"`
	OutputTokens uint64 `json:"outputTokens,omitempty"`
	// MediaURL is a generated image (URL or data: URL) or the speech audio (data: URL).
	MediaURL string `json:"mediaUrl,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	// Dimensions is the vector length an embedding test returned.
	Dimensions int `json:"dimensions,omitempty"`
}

// ProbeRequest selects the kind of test (text by default; see ProbeKindsFor), the model and the
// prompt (the embedding / speech input for those kinds) used to test one upstream account.
// ImageDataURL / AudioDataURL are optional uploads as data: URLs (at most probeMaxInputMediaBytes
// decoded): a source image turns an OpenAI image test into an edit and is a Grok video's first
// frame; audio is what a transcription test transcribes (a built-in silent clip otherwise).
type ProbeRequest struct {
	Kind         string `json:"kind"`
	Model        string `json:"model"`
	Prompt       string `json:"prompt"`
	ImageDataURL string `json:"imageDataUrl,omitempty"`
	AudioDataURL string `json:"audioDataUrl,omitempty"`
}

const (
	defaultProbePrompt    = "Hi"
	probeMaxTokens        = 64
	probeMaxPromptRunes   = 2000
	probeMaxErrorBodySize = 64 * 1024
)

// DefaultProbeModel returns a small, widely available model for each upstream provider.
func DefaultProbeModel(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic":
		return "claude-sonnet-4-5"
	case "codex":
		return "gpt-5-codex"
	case "openai":
		return "gpt-4o-mini"
	case "gemini", "antigravity":
		return "gemini-2.5-flash"
	case "grok":
		return "grok-3-mini"
	case "deepseek":
		return "deepseek-chat"
	case "glm":
		return "glm-4.5-air"
	case "kimi":
		return "kimi-k2-0905-preview"
	case "minimax":
		return "MiniMax-M2"
	case "qwen":
		return "qwen-plus"
	case "bedrock":
		return "anthropic.claude-sonnet-4-5-20250929-v1:0"
	case "vertex":
		return "gemini-2.5-flash"
	case "opencode_go":
		return DefaultOpenCodeGoTestModel
	case "typesafe":
		return TypeSafeJevLatestModel
	case "command_code":
		return DefaultCommandCodeTestModel
	case "cline":
		return DefaultClineTestModel
	default:
		return "gpt-4o-mini"
	}
}

// ProbeAccount sends one short streaming request through the account's real outbound path
// (same persona, uTLS profile and fail-closed Clash exit as production traffic) and reports
// progress through emit. It never touches slipgate-core holds or settlement.
func (c *Coordinator) ProbeAccount(ctx context.Context, accountID string, req ProbeRequest, emit func(ProbeEvent)) {
	meta, ok := c.accountMetaFor(accountID)
	if !ok {
		emit(ProbeEvent{Type: "error", Code: "account_not_synced", Message: "account is not synchronized to the data plane yet"})
		return
	}
	if meta.ExecutionMode == "vm_slot" {
		emit(ProbeEvent{Type: "error", Code: "vm_slot_unsupported", Message: "VM slot accounts are tested from their slot"})
		return
	}
	secret, ok := c.vault.Get(accountID)
	if !ok {
		emit(ProbeEvent{Type: "error", Code: "account_secret_unavailable", Message: "account credentials are not loaded in the vault"})
		return
	}
	var prepErr error
	secret, prepErr = c.prepareCloudProviderSecret(ctx, meta.Platform, secret)
	if prepErr != nil {
		emit(ProbeEvent{Type: "error", Code: "cloud_auth_failed", Message: prepErr.Error()})
		return
	}
	kind := normalizeProbeKind(req.Kind)
	if !probeKindSupported(meta.Platform, kind) {
		emit(ProbeEvent{Type: "error", Kind: kind, Code: "probe_kind_unsupported", Message: fmt.Sprintf("%s accounts cannot run a %s test", meta.Platform, kind)})
		return
	}
	if strings.EqualFold(strings.TrimSpace(meta.Platform), "typesafe") {
		c.probeTypeSafeAccount(ctx, accountID, meta, secret, req, emit)
		return
	}

	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = DefaultProbeModelFor(kind, meta.Platform)
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		prompt = defaultProbePromptFor(kind)
	}
	if r := []rune(prompt); len(r) > probeMaxPromptRunes {
		prompt = string(r[:probeMaxPromptRunes])
	}
	inputs, code, err := decodeProbeInputs(meta.Platform, kind, req)
	if err != nil {
		emit(ProbeEvent{Type: "error", Kind: kind, Code: code, Message: err.Error()})
		return
	}
	if kind != ProbeKindText {
		c.probeMediaAccount(ctx, accountID, meta, secret, c.probePersona(accountID, meta, secret), kind, model, prompt, inputs, emit)
		return
	}

	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"stream":     true,
		"max_tokens": probeMaxTokens,
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
	})
	turn, err := ParseIngressRequest("/v1/chat/completions", "", body)
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "probe_build_failed", Message: err.Error()})
		return
	}

	pctx := c.probePersona(accountID, meta, secret)

	startedAt := time.Now()
	emit(ProbeEvent{Type: "start", Model: model, Kind: ProbeKindText})

	// Report a missing/unhealthy exit explicitly; executeOutbound enforces the same fail-closed guard.
	if meta.ExecutionMode == "stealth_http" && c.pool != nil {
		if _, err := c.pool.ResolveDialTarget(accountID); err != nil {
			emit(ProbeEvent{Type: "error", Code: "egress_unavailable", Message: err.Error()})
			return
		}
	}

	upstreamReq, egressCodec, err := BuildUpstreamHTTPRequestWithPersona(ctx, pctx, model, secret, turn)
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "request_transcode_failed", Message: err.Error()})
		return
	}
	resp, err := c.executeOutbound(ctx, pctx, secret, upstreamReq, model, egressCodec, turn)
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "outbound_dispatch_failed", Message: err.Error()})
		return
	}
	defer resp.Body.Close()

	pw := newProbeWriter(emit, startedAt)
	metrics, relayErr := RelayAndTranscodeResponse(pw, resp, egressCodec, turn, model, "zero", startedAt, nil)

	done := ProbeEvent{
		Type:         "done",
		Status:       pw.statusCode(),
		DurationMs:   max(1, time.Since(startedAt).Milliseconds()),
		TTFTMs:       pw.ttftMs,
		InputTokens:  metrics.InputTokens,
		OutputTokens: metrics.OutputTokens,
	}
	switch {
	case done.Status >= 400:
		done.Code, done.Message = pw.upstreamError()
	case relayErr != nil:
		done.Code = "stream_interrupted"
		done.Message = relayErr.Error()
	default:
		done.Success = true
	}
	emit(done)
}

// probePersona is the outbound persona of a test: the account's own, with a probe request id.
func (c *Coordinator) probePersona(accountID string, meta accountMeta, secret AccountSecret) OutboundPersonaContext {
	return OutboundPersonaContext{
		Provider:         meta.Platform,
		AuthKind:         meta.AuthKind,
		SubscriptionTier: meta.SubscriptionTier,
		TierMultiplier:   meta.TierMultiplier,
		ExecutionMode:    meta.ExecutionMode,
		AccountID:        accountID,
		CleanseMode:      "zero",
		RequestID:        fmt.Sprintf("probe_%s_%d", accountID, time.Now().UnixNano()),
		UTLSProfileID:    c.resolveAccountUTLSProfileID(accountID, meta.Platform, meta.AuthKind, secret),
	}
}

type accountMeta struct {
	Platform         string
	ExecutionMode    string
	AuthKind         string
	SubscriptionTier string
	TierMultiplier   uint16
	TempUnschedRules []TempUnschedRule
}

func (c *Coordinator) accountMetaFor(accountID string) (accountMeta, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	m, ok := c.accountMetas[accountID]
	return m, ok
}

// probeWriter is an http.ResponseWriter that turns the OpenAI-chat SSE produced by
// RelayAndTranscodeResponse into probe "delta" events, and captures error bodies.
type probeWriter struct {
	header    http.Header
	status    int
	pending   bytes.Buffer
	errBody   bytes.Buffer
	emit      func(ProbeEvent)
	startedAt time.Time
	ttftMs    int64
}

func newProbeWriter(emit func(ProbeEvent), startedAt time.Time) *probeWriter {
	return &probeWriter{header: make(http.Header), emit: emit, startedAt: startedAt}
}

func (p *probeWriter) Header() http.Header { return p.header }

func (p *probeWriter) WriteHeader(code int) {
	if p.status == 0 {
		p.status = code
	}
}

func (p *probeWriter) Flush() {}

func (p *probeWriter) statusCode() int {
	if p.status == 0 {
		return http.StatusOK
	}
	return p.status
}

func (p *probeWriter) Write(b []byte) (int, error) {
	if p.status == 0 {
		p.status = http.StatusOK
	}
	if p.status >= 400 {
		if room := probeMaxErrorBodySize - p.errBody.Len(); room > 0 {
			p.errBody.Write(b[:min(len(b), room)])
		}
		return len(b), nil
	}
	p.pending.Write(b)
	p.drainLines()
	return len(b), nil
}

// drainLines consumes complete SSE lines and emits text deltas from chat.completion.chunk payloads.
func (p *probeWriter) drainLines() {
	for {
		data := p.pending.Bytes()
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			return
		}
		line := strings.TrimSpace(string(data[:idx]))
		p.pending.Next(idx + 1)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content == "" {
				continue
			}
			if p.ttftMs == 0 {
				p.ttftMs = max(1, time.Since(p.startedAt).Milliseconds())
			}
			p.emit(ProbeEvent{Type: "delta", Text: ch.Delta.Content})
		}
	}
}

// upstreamError extracts code/message from the OpenAI-style error JSON written by WriteProtocolError.
func (p *probeWriter) upstreamError() (string, string) {
	var envelope struct {
		Error struct {
			Code    any    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	raw := p.errBody.Bytes()
	if json.Unmarshal(raw, &envelope) == nil && envelope.Error.Message != "" {
		code := ""
		if s, ok := envelope.Error.Code.(string); ok {
			code = s
		}
		return code, envelope.Error.Message
	}
	// Fall back to the first non-empty line of whatever the upstream sent.
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			return "", line
		}
	}
	return "", http.StatusText(p.statusCode())
}
