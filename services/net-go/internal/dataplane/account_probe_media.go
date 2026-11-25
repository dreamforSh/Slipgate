package dataplane

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Account test kinds (ProbeRequest.Kind): text streams a chat completion; image, embedding and
// speech call /v1/images/generations, /v1/embeddings and /v1/audio/speech through the same
// multimodal / extended outbound path as production traffic (persona, uTLS profile, Clash exit).
const (
	ProbeKindText      = "text"
	ProbeKindImage     = "image"
	ProbeKindEmbedding = "embedding"
	ProbeKindSpeech    = "speech"
)

// probeMaxMediaBytes caps an image or audio returned to the console as a data: URL.
const probeMaxMediaBytes = 6 * 1024 * 1024

// ProbeKindsFor lists the test kinds a provider's accounts support (text for every provider);
// mirrored by accountTestKinds in packages/contracts.
func ProbeKindsFor(provider string) []string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai":
		return []string{ProbeKindText, ProbeKindImage, ProbeKindEmbedding, ProbeKindSpeech}
	case "gemini":
		return []string{ProbeKindText, ProbeKindImage, ProbeKindEmbedding}
	case "grok":
		return []string{ProbeKindText, ProbeKindImage}
	case "qwen":
		return []string{ProbeKindText, ProbeKindEmbedding}
	default:
		return []string{ProbeKindText}
	}
}

func probeKindSupported(provider, kind string) bool {
	for _, k := range ProbeKindsFor(provider) {
		if k == kind {
			return true
		}
	}
	return false
}

// normalizeProbeKind maps an empty or unknown kind to text.
func normalizeProbeKind(kind string) string {
	switch k := strings.ToLower(strings.TrimSpace(kind)); k {
	case ProbeKindImage, ProbeKindEmbedding, ProbeKindSpeech:
		return k
	default:
		return ProbeKindText
	}
}

// DefaultProbeModelFor is the model a test of this kind uses when none is given.
func DefaultProbeModelFor(kind, provider string) string {
	prov := strings.ToLower(strings.TrimSpace(provider))
	switch normalizeProbeKind(kind) {
	case ProbeKindImage:
		switch prov {
		case "gemini":
			return "imagen-4.0-generate-001"
		case "grok":
			return "grok-2-image-1212"
		default:
			return "gpt-image-1"
		}
	case ProbeKindEmbedding:
		switch prov {
		case "gemini":
			return "gemini-embedding-001"
		case "qwen":
			return "text-embedding-v4"
		default:
			return "text-embedding-3-small"
		}
	case ProbeKindSpeech:
		return "gpt-4o-mini-tts"
	default:
		return DefaultProbeModel(provider)
	}
}

// defaultProbePromptFor is the prompt (or embedding / speech input) of a test of this kind.
func defaultProbePromptFor(kind string) string {
	switch kind {
	case ProbeKindImage:
		return "A small red apple on a white table, studio light"
	case ProbeKindEmbedding:
		return "Slipgate account test"
	case ProbeKindSpeech:
		return "Hello from Slipgate."
	default:
		return defaultProbePrompt
	}
}

// probeCapture collects a relayed (non-streaming) media response.
type probeCapture struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newProbeCapture() *probeCapture { return &probeCapture{header: make(http.Header)} }

func (p *probeCapture) Header() http.Header { return p.header }
func (p *probeCapture) WriteHeader(code int) {
	if p.status == 0 {
		p.status = code
	}
}
func (p *probeCapture) Write(b []byte) (int, error) {
	if p.status == 0 {
		p.status = http.StatusOK
	}
	return p.body.Write(b)
}
func (p *probeCapture) Flush() {}

func (p *probeCapture) statusCode() int {
	if p.status == 0 {
		return http.StatusOK
	}
	return p.status
}

// probeMediaAccount runs an image, embedding or speech test and reports the result: media events
// (an image or the audio as a URL / data: URL) and a done event with the status, timing and, for
// embeddings, the vector length.
func (c *Coordinator) probeMediaAccount(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	pctx OutboundPersonaContext,
	kind, model, prompt string,
	emit func(ProbeEvent),
) {
	var path string
	var payload map[string]any
	switch kind {
	case ProbeKindImage:
		path = "/v1/images/generations"
		payload = map[string]any{"model": model, "prompt": prompt, "n": 1, "size": "1024x1024"}
	case ProbeKindEmbedding:
		path = "/v1/embeddings"
		payload = map[string]any{"model": model, "input": prompt}
	default:
		path = "/v1/audio/speech"
		payload = map[string]any{"model": model, "input": prompt, "voice": "alloy", "response_format": "mp3"}
	}
	body, _ := json.Marshal(payload)
	ingress, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://probe.local"+path, bytes.NewReader(body))
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "probe_build_failed", Message: err.Error()})
		return
	}
	ingress.Header.Set("Content-Type", "application/json")
	extended := kind == ProbeKindSpeech
	var turn *CanonicalTurn
	if extended {
		turn, err = parseExtendedIngress(ingress, body)
	} else {
		turn, err = parseMultimodalIngress(ingress, body)
	}
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "probe_build_failed", Message: err.Error()})
		return
	}

	startedAt := time.Now()
	emit(ProbeEvent{Type: "start", Model: model, Kind: kind})
	if meta.ExecutionMode == "stealth_http" && c.pool != nil {
		if _, err := c.pool.ResolveDialTarget(accountID); err != nil {
			emit(ProbeEvent{Type: "error", Code: "egress_unavailable", Message: err.Error()})
			return
		}
	}

	var resp *http.Response
	var egress CodecKind
	switch {
	case secret.IsMock() && extended:
		resp, egress = executeMockExtendedTurn(turn, model), turn.IngressCodec
	case secret.IsMock():
		resp, egress = executeMockMultimodalTurn(turn, model), turn.IngressCodec
	default:
		var upstreamReq *http.Request
		if extended {
			upstreamReq, egress, err = buildExtendedUpstreamRequest(ctx, path, pctx, model, secret, turn)
		} else {
			upstreamReq, egress, err = buildMultimodalUpstreamRequest(ctx, path, pctx, model, secret, turn)
		}
		if err != nil {
			emit(ProbeEvent{Type: "error", Code: "request_transcode_failed", Message: err.Error()})
			return
		}
		resp, err = c.executeOutbound(ctx, pctx, secret, upstreamReq, model, egress, turn)
		if err != nil {
			emit(ProbeEvent{Type: "error", Code: "outbound_dispatch_failed", Message: err.Error()})
			return
		}
	}
	defer resp.Body.Close()

	capture := newProbeCapture()
	directive := &coreDispatchDirective{PublicModel: model, UpstreamModel: model, Provider: meta.Platform}
	var metrics RelayMetrics
	if extended {
		metrics, err = relayExtendedResponse(capture, resp, egress, turn, directive, startedAt)
	} else {
		metrics, err = relayMultimodalResponse(capture, resp, egress, turn, directive, startedAt, &c.mediaTasks)
	}
	elapsed := max(1, time.Since(startedAt).Milliseconds())
	done := ProbeEvent{
		Type:        "done",
		Kind:        kind,
		Status:      capture.statusCode(),
		DurationMs:  elapsed,
		TTFTMs:      elapsed,
		InputTokens: metrics.InputTokens,
	}
	switch {
	case done.Status >= 400:
		done.Code, done.Message = probeErrorFromBody(capture.body.Bytes(), done.Status)
	case err != nil:
		done.Code, done.Message = "stream_interrupted", err.Error()
	default:
		done.Success = true
		switch kind {
		case ProbeKindImage:
			n := emitProbeImages(capture.body.Bytes(), emit)
			if n == 0 {
				done.Success = false
				done.Code, done.Message = "probe_empty_result", "the provider returned no image"
			}
		case ProbeKindEmbedding:
			done.Dimensions = embeddingDimensions(capture.body.Bytes())
			if done.Dimensions == 0 {
				done.Success = false
				done.Code, done.Message = "probe_empty_result", "the provider returned no embedding"
			}
		case ProbeKindSpeech:
			audio := capture.body.Bytes()
			if len(audio) == 0 {
				done.Success = false
				done.Code, done.Message = "probe_empty_result", "the provider returned no audio"
			} else if len(audio) <= probeMaxMediaBytes {
				mime := strings.TrimSpace(strings.Split(capture.header.Get("Content-Type"), ";")[0])
				if mime == "" {
					mime = "audio/mpeg"
				}
				emit(ProbeEvent{Type: "media", Kind: kind, MimeType: mime, MediaURL: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(audio)})
			}
		}
	}
	emit(done)
}

// emitProbeImages sends one media event per generated image (its URL, or a data: URL for
// base64 results within probeMaxMediaBytes) and returns how many images the response held.
func emitProbeImages(raw []byte, emit func(ProbeEvent)) int {
	var out struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
		OutputFormat string `json:"output_format"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return 0
	}
	mime := "image/png"
	switch strings.ToLower(out.OutputFormat) {
	case "jpeg", "jpg":
		mime = "image/jpeg"
	case "webp":
		mime = "image/webp"
	}
	for _, d := range out.Data {
		switch {
		case strings.TrimSpace(d.URL) != "":
			emit(ProbeEvent{Type: "media", Kind: ProbeKindImage, MimeType: mime, MediaURL: d.URL})
		case d.B64JSON != "" && base64.StdEncoding.DecodedLen(len(d.B64JSON)) <= probeMaxMediaBytes:
			emit(ProbeEvent{Type: "media", Kind: ProbeKindImage, MimeType: mime, MediaURL: "data:" + mime + ";base64," + d.B64JSON})
		}
	}
	return len(out.Data)
}

// embeddingDimensions is the length of the first vector of an OpenAI-shaped embeddings response.
func embeddingDimensions(raw []byte) int {
	var out struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Data) == 0 {
		return 0
	}
	return len(out.Data[0].Embedding)
}

// probeErrorFromBody reads the error code and message of a relayed error response.
func probeErrorFromBody(raw []byte, status int) (string, string) {
	errType, errCode, message := extractUpstreamError(raw, http.StatusText(status))
	code := firstNonEmpty(errCode, errType, fmt.Sprintf("upstream_http_%d", status))
	if len(message) > 500 {
		message = message[:500]
	}
	return code, message
}
