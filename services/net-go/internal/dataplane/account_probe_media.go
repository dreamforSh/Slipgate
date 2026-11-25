package dataplane

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

// Account test kinds (ProbeRequest.Kind): text streams a chat completion; image, embedding,
// speech, transcription and video call /v1/images/generations (or /edits), /v1/embeddings,
// /v1/audio/speech, /v1/audio/transcriptions and /v1/videos through the same multimodal /
// extended outbound path as production traffic (persona, uTLS profile, Clash exit).
const (
	ProbeKindText          = "text"
	ProbeKindImage         = "image"
	ProbeKindEmbedding     = "embedding"
	ProbeKindSpeech        = "speech"
	ProbeKindTranscription = "transcription"
	ProbeKindVideo         = "video"
)

// probeMaxMediaBytes caps an image or audio returned to the console as a data: URL.
const probeMaxMediaBytes = 6 * 1024 * 1024

// probeMaxVideoBytes caps a rendered video downloaded for the console preview.
const probeMaxVideoBytes = 8 * 1024 * 1024

// Video tests poll the provider's task until it finishes or probeVideoMaxWait has passed since the
// test started (inside the ingress accountProbeTimeout). Variables so tests can shorten them.
var (
	probeVideoMaxWait      = 70 * time.Second
	probeVideoPollInterval = 3 * time.Second
)

// ProbeKindsFor lists the test kinds a provider's accounts support (text for every provider);
// mirrored by accountTestKinds in packages/contracts.
func ProbeKindsFor(provider string) []string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai":
		return []string{ProbeKindText, ProbeKindImage, ProbeKindEmbedding, ProbeKindSpeech, ProbeKindTranscription, ProbeKindVideo}
	case "gemini":
		return []string{ProbeKindText, ProbeKindImage, ProbeKindEmbedding}
	case "grok":
		return []string{ProbeKindText, ProbeKindImage, ProbeKindVideo}
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
	case ProbeKindImage, ProbeKindEmbedding, ProbeKindSpeech, ProbeKindTranscription, ProbeKindVideo:
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
	case ProbeKindTranscription:
		return "whisper-1"
	case ProbeKindVideo:
		if prov == "grok" {
			return "grok-imagine-video"
		}
		return "sora-2"
	default:
		return DefaultProbeModel(provider)
	}
}

// defaultProbePromptFor is the prompt (or embedding / speech input) of a test of this kind; a
// transcription takes none (the prompt is only an optional hint there).
func defaultProbePromptFor(kind string) string {
	switch kind {
	case ProbeKindImage:
		return "A small red apple on a white table, studio light"
	case ProbeKindEmbedding:
		return "Slipgate account test"
	case ProbeKindSpeech:
		return "Hello from Slipgate."
	case ProbeKindTranscription:
		return ""
	case ProbeKindVideo:
		return "A paper boat drifting slowly across a calm pond, soft morning light"
	default:
		return defaultProbePrompt
	}
}

// probeMedia is a decoded upload of a test (ProbeRequest.ImageDataURL / AudioDataURL).
type probeMedia struct {
	data []byte
	mime string
}

func (m probeMedia) present() bool { return len(m.data) > 0 }

// probeInputs are the uploads a test may carry: a source image (an OpenAI image edit, or a Grok
// video's first frame) and audio to transcribe.
type probeInputs struct {
	image probeMedia
	audio probeMedia
}

// probeMaxInputMediaBytes caps one decoded upload (the BFF's 8 MiB body limit holds its base64).
const probeMaxInputMediaBytes = 5 * 1024 * 1024

// decodeProbeInputs validates the uploads of a test against its kind and provider; it returns the
// event code to report when they do not fit (probe_input_invalid / probe_input_unsupported).
func decodeProbeInputs(provider, kind string, req ProbeRequest) (probeInputs, string, error) {
	var in probeInputs
	prov := strings.ToLower(strings.TrimSpace(provider))
	if raw := strings.TrimSpace(req.ImageDataURL); raw != "" {
		switch {
		case kind == ProbeKindImage && prov == "openai", kind == ProbeKindVideo && prov == "grok":
		default:
			return in, "probe_input_unsupported", fmt.Errorf("a source image is not used by %s %s tests", provider, kind)
		}
		m, err := decodeProbeDataURL(raw, "image/")
		if err != nil {
			return in, "probe_input_invalid", fmt.Errorf("source image: %w", err)
		}
		in.image = m
	}
	if raw := strings.TrimSpace(req.AudioDataURL); raw != "" {
		if kind != ProbeKindTranscription {
			return in, "probe_input_unsupported", fmt.Errorf("audio is only used by transcription tests")
		}
		m, err := decodeProbeDataURL(raw, "audio/", "video/mp4", "video/webm")
		if err != nil {
			return in, "probe_input_invalid", fmt.Errorf("audio: %w", err)
		}
		in.audio = m
	}
	return in, "", nil
}

// decodeProbeDataURL decodes a base64 data: URL whose media type starts with one of the prefixes.
func decodeProbeDataURL(raw string, mimePrefixes ...string) (probeMedia, error) {
	if !strings.HasPrefix(raw, "data:") {
		return probeMedia{}, fmt.Errorf("expected a data: URL")
	}
	header, payload, ok := strings.Cut(raw[len("data:"):], ",")
	if !ok || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return probeMedia{}, fmt.Errorf("expected a base64 data: URL")
	}
	mime := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	allowed := false
	for _, p := range mimePrefixes {
		if strings.HasPrefix(mime, p) {
			allowed = true
			break
		}
	}
	if !allowed {
		return probeMedia{}, fmt.Errorf("unsupported media type %q", mime)
	}
	if base64.StdEncoding.DecodedLen(len(payload)) > probeMaxInputMediaBytes+3 {
		return probeMedia{}, fmt.Errorf("larger than %d MiB", probeMaxInputMediaBytes>>20)
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return probeMedia{}, fmt.Errorf("invalid base64: %w", err)
	}
	if len(data) == 0 {
		return probeMedia{}, fmt.Errorf("empty file")
	}
	if len(data) > probeMaxInputMediaBytes {
		return probeMedia{}, fmt.Errorf("larger than %d MiB", probeMaxInputMediaBytes>>20)
	}
	return probeMedia{data: data, mime: mime}, nil
}

// probeFileName is the multipart filename of an upload (providers infer the format from it).
func probeFileName(base, mime string) string {
	ext := "bin"
	switch mime {
	case "image/png":
		ext = "png"
	case "image/jpeg", "image/jpg":
		ext = "jpg"
	case "image/webp":
		ext = "webp"
	case "image/gif":
		ext = "gif"
	case "audio/wav", "audio/x-wav", "audio/wave":
		ext = "wav"
	case "audio/mpeg", "audio/mp3":
		ext = "mp3"
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		ext = "m4a"
	case "audio/ogg":
		ext = "ogg"
	case "audio/flac", "audio/x-flac":
		ext = "flac"
	case "audio/webm", "video/webm":
		ext = "webm"
	case "video/mp4":
		ext = "mp4"
	}
	return base + "." + ext
}

// buildProbeMultipart writes form fields and one file part; it returns the body and its content type.
func buildProbeMultipart(fields [][2]string, fileField, fileName, fileMime string, file []byte) ([]byte, string) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, f := range fields {
		_ = mw.WriteField(f[0], f[1])
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, fileField, fileName))
	h.Set("Content-Type", fileMime)
	part, _ := mw.CreatePart(h)
	_, _ = part.Write(file)
	_ = mw.Close()
	return buf.Bytes(), mw.FormDataContentType()
}

// silentProbeWAV is one second of 16 kHz mono 16-bit silence: the clip a transcription test sends
// when nothing was uploaded (it proves the endpoint answers; the transcript is usually empty).
func silentProbeWAV() []byte {
	const sampleRate, seconds = 16000, 1
	dataLen := sampleRate * seconds * 2
	var b bytes.Buffer
	le32 := func(v uint32) { b.Write([]byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}) }
	le16 := func(v uint16) { b.Write([]byte{byte(v), byte(v >> 8)}) }
	b.WriteString("RIFF")
	le32(uint32(36 + dataLen))
	b.WriteString("WAVEfmt ")
	le32(16)
	le16(1) // PCM
	le16(1) // mono
	le32(sampleRate)
	le32(sampleRate * 2)
	le16(2)
	le16(16)
	b.WriteString("data")
	le32(uint32(dataLen))
	b.Write(make([]byte, dataLen))
	return b.Bytes()
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

// probeMediaRequest is the ingress request a non-text test sends through the production path.
type probeMediaRequest struct {
	path        string
	body        []byte
	contentType string
	// extended: the /v1/audio/* family (parseExtendedIngress); otherwise the multimodal one.
	extended bool
	// note is an optional status line reported before the request (e.g. the built-in clip).
	note string
}

// buildProbeMediaRequest shapes the request of an image, embedding, speech, transcription or
// video test, with the uploads when the test carries any.
func buildProbeMediaRequest(provider, kind, model, prompt string, in probeInputs) probeMediaRequest {
	prov := strings.ToLower(strings.TrimSpace(provider))
	asJSON := func(path string, payload map[string]any, extended bool) probeMediaRequest {
		body, _ := json.Marshal(payload)
		return probeMediaRequest{path: path, body: body, contentType: "application/json", extended: extended}
	}
	switch kind {
	case ProbeKindImage:
		if in.image.present() {
			body, ct := buildProbeMultipart(
				[][2]string{{"model", model}, {"prompt", prompt}, {"n", "1"}, {"size", "1024x1024"}},
				"image", probeFileName("source", in.image.mime), in.image.mime, in.image.data,
			)
			return probeMediaRequest{path: "/v1/images/edits", body: body, contentType: ct}
		}
		return asJSON("/v1/images/generations", map[string]any{"model": model, "prompt": prompt, "n": 1, "size": "1024x1024"}, false)
	case ProbeKindEmbedding:
		return asJSON("/v1/embeddings", map[string]any{"model": model, "input": prompt}, false)
	case ProbeKindTranscription:
		audio, note := in.audio, ""
		if !audio.present() {
			audio = probeMedia{data: silentProbeWAV(), mime: "audio/wav"}
			note = "no audio uploaded: sending a built-in 1-second silent clip"
		}
		fields := [][2]string{{"model", model}, {"response_format", "json"}}
		if prompt != "" {
			fields = append(fields, [2]string{"prompt", prompt})
		}
		body, ct := buildProbeMultipart(fields, "file", probeFileName("audio", audio.mime), audio.mime, audio.data)
		return probeMediaRequest{path: "/v1/audio/transcriptions", body: body, contentType: ct, extended: true, note: note}
	case ProbeKindVideo:
		if prov == "grok" {
			payload := map[string]any{"model": model, "prompt": prompt, "duration": 6, "aspect_ratio": "16:9", "resolution": "480p"}
			if in.image.present() {
				payload["image"] = map[string]any{"url": "data:" + in.image.mime + ";base64," + base64.StdEncoding.EncodeToString(in.image.data)}
			}
			return asJSON("/v1/videos/generations", payload, false)
		}
		return asJSON("/v1/videos", map[string]any{"model": model, "prompt": prompt, "seconds": "4", "size": "720x1280"}, false)
	default:
		return asJSON("/v1/audio/speech", map[string]any{"model": model, "input": prompt, "voice": "alloy", "response_format": "mp3"}, true)
	}
}

// probeMediaAccount runs an image, embedding, speech, transcription or video test and reports the
// result: media events (images, the audio or video clip as a URL / data: URL), the transcript as
// a delta, video task progress, and a done event with the status, timing and, for embeddings, the
// vector length.
func (c *Coordinator) probeMediaAccount(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	pctx OutboundPersonaContext,
	kind, model, prompt string,
	in probeInputs,
	emit func(ProbeEvent),
) {
	mreq := buildProbeMediaRequest(meta.Platform, kind, model, prompt, in)
	ingress, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://probe.local"+mreq.path, bytes.NewReader(mreq.body))
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "probe_build_failed", Message: err.Error()})
		return
	}
	ingress.Header.Set("Content-Type", mreq.contentType)
	var turn *CanonicalTurn
	if mreq.extended {
		turn, err = parseExtendedIngress(ingress, mreq.body)
	} else {
		turn, err = parseMultimodalIngress(ingress, mreq.body)
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
	if mreq.note != "" {
		emit(ProbeEvent{Type: "progress", Kind: kind, Text: mreq.note})
	}
	if in.image.present() {
		emit(ProbeEvent{Type: "progress", Kind: kind, Text: fmt.Sprintf("using the uploaded image (%s, %d KiB)", in.image.mime, max(1, len(in.image.data)>>10))})
	}

	var resp *http.Response
	var egress CodecKind
	switch {
	case secret.IsMock() && mreq.extended:
		resp, egress = executeMockExtendedTurn(turn, model), turn.IngressCodec
	case secret.IsMock():
		resp, egress = executeMockMultimodalTurn(turn, model), turn.IngressCodec
	default:
		var upstreamReq *http.Request
		if mreq.extended {
			upstreamReq, egress, err = buildExtendedUpstreamRequest(ctx, mreq.path, pctx, model, secret, turn)
		} else {
			upstreamReq, egress, err = buildMultimodalUpstreamRequest(ctx, mreq.path, pctx, model, secret, turn)
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
	if mreq.extended {
		metrics, err = relayExtendedResponse(capture, resp, egress, turn, directive, startedAt)
	} else {
		// No media task store: a test's video task is polled right here, never by a client.
		metrics, err = relayMultimodalResponse(capture, resp, egress, turn, directive, startedAt, nil)
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
		case ProbeKindTranscription:
			var out struct {
				Text *string `json:"text"`
			}
			switch {
			case json.Unmarshal(capture.body.Bytes(), &out) != nil || out.Text == nil:
				done.Success = false
				done.Code, done.Message = "probe_empty_result", "the provider returned no transcript"
			case strings.TrimSpace(*out.Text) != "":
				emit(ProbeEvent{Type: "delta", Text: strings.TrimSpace(*out.Text)})
			default:
				emit(ProbeEvent{Type: "progress", Kind: kind, Text: "the transcript is empty (no speech detected)"})
			}
		case ProbeKindVideo:
			c.awaitProbeVideo(ctx, accountID, meta, secret, pctx, capture.body.Bytes(), startedAt, emit, &done)
			done.DurationMs = max(1, time.Since(startedAt).Milliseconds())
		}
	}
	emit(done)
}

// probeVideoTask is the part of a video task object (create or status response) a test reads.
type probeVideoTask struct {
	ID        string          `json:"id"`
	RequestID string          `json:"request_id"`
	Status    string          `json:"status"`
	Progress  json.RawMessage `json:"progress"`
	URL       string          `json:"url"`
	VideoURL  string          `json:"video_url"`
	Download  string          `json:"download_url"`
	Video     struct {
		URL string `json:"url"`
	} `json:"video"`
	Error json.RawMessage `json:"error"`
}

func (t probeVideoTask) taskID() string {
	return firstNonEmpty(strings.TrimSpace(t.ID), strings.TrimSpace(t.RequestID))
}

func (t probeVideoTask) state() string { return strings.ToLower(strings.TrimSpace(t.Status)) }

// progressPercent reads a 0-100 progress (a number or numeric string; 0-1 fractions are scaled).
func (t probeVideoTask) progressPercent() int {
	raw := strings.Trim(strings.TrimSpace(string(t.Progress)), `"`)
	if raw == "" || raw == "null" {
		return 0
	}
	var f float64
	if _, err := fmt.Sscanf(raw, "%g", &f); err != nil || f < 0 {
		return 0
	}
	if f > 0 && f <= 1 && strings.Contains(raw, ".") {
		f *= 100
	}
	return min(100, int(f+0.5))
}

func (t probeVideoTask) mediaURL() string {
	for _, u := range []string{t.Video.URL, t.URL, t.VideoURL, t.Download} {
		u = strings.TrimSpace(u)
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "data:") {
			return u
		}
	}
	return ""
}

func probeVideoFinished(state string) bool {
	switch state {
	case "completed", "succeeded", "success", "done":
		return true
	}
	return false
}

func probeVideoFailed(state string) bool {
	switch state {
	case "failed", "error", "canceled", "cancelled", "expired":
		return true
	}
	return false
}

// awaitProbeVideo follows a created video task: progress events while it renders, the clip as a
// media event when it is done (its URL, or the downloaded content when small enough), and the
// outcome in done. A task still rendering when probeVideoMaxWait runs out passes: the provider
// accepted and started the job, which is what the account test checks.
func (c *Coordinator) awaitProbeVideo(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	pctx OutboundPersonaContext,
	created []byte,
	startedAt time.Time,
	emit func(ProbeEvent),
	done *ProbeEvent,
) {
	var task probeVideoTask
	if json.Unmarshal(created, &task) != nil || task.taskID() == "" {
		done.Success = false
		done.Code, done.Message = "probe_empty_result", "the provider returned no video task id"
		return
	}
	id := task.taskID()
	report := func(t probeVideoTask) {
		state := firstNonEmpty(t.state(), "queued")
		emit(ProbeEvent{Type: "progress", Kind: ProbeKindVideo, Text: fmt.Sprintf("task %s: %s", id, state), Progress: t.progressPercent()})
	}
	report(task)
	if secret.IsMock() {
		// The mock provider has no task API: it renders instantly, with nothing to preview.
		emit(ProbeEvent{Type: "progress", Kind: ProbeKindVideo, Text: fmt.Sprintf("task %s: completed", id), Progress: 100})
		return
	}

	baseURL := resolveProviderBaseURL(meta.Platform, secret.BaseURL)
	get := func(path string, limit int64) (int, []byte, string, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, joinProviderPath(baseURL, path), nil)
		if err != nil {
			return 0, nil, "", err
		}
		applyUpstreamAuthHeaders(req, pctx, secret)
		resp, err := c.executeControlHTTPRequest(ctx, accountID, meta, secret, req)
		if err != nil {
			return 0, nil, "", err
		}
		defer resp.Body.Close()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(io.LimitReader(resp.Body, limit+1))
		return resp.StatusCode, buf.Bytes(), resp.Header.Get("Content-Type"), nil
	}

	deadline := startedAt.Add(probeVideoMaxWait)
	for !probeVideoFinished(task.state()) {
		if probeVideoFailed(task.state()) {
			done.Success = false
			done.Code = "video_failed"
			done.Message = firstNonEmpty(probeVideoError(task.Error), "the provider reported the video task as "+task.state())
			return
		}
		if time.Now().Add(probeVideoPollInterval).After(deadline) {
			emit(ProbeEvent{Type: "progress", Kind: ProbeKindVideo, Text: fmt.Sprintf("task %s is still rendering after %ds; the account accepted the job", id, int(probeVideoMaxWait.Seconds()))})
			return
		}
		select {
		case <-ctx.Done():
			done.Success = false
			done.Code, done.Message = "probe_timeout", "the test was cancelled while the video rendered"
			return
		case <-time.After(probeVideoPollInterval):
		}
		status, body, _, err := get("/v1/videos/"+id, 1<<20)
		if err != nil {
			done.Success = false
			done.Code, done.Message = "outbound_dispatch_failed", err.Error()
			return
		}
		if status >= 400 {
			done.Success = false
			done.Status = status
			done.Code, done.Message = probeErrorFromBody(body, status)
			return
		}
		var next probeVideoTask
		if json.Unmarshal(body, &next) != nil {
			done.Success = false
			done.Code, done.Message = "probe_empty_result", "unreadable video task status"
			return
		}
		task = next
		report(task)
	}

	if u := task.mediaURL(); u != "" {
		emit(ProbeEvent{Type: "media", Kind: ProbeKindVideo, MimeType: "video/mp4", MediaURL: u})
		return
	}
	status, body, ct, err := get("/v1/videos/"+id+"/content", probeMaxVideoBytes)
	switch {
	case err != nil || status >= 400:
		emit(ProbeEvent{Type: "progress", Kind: ProbeKindVideo, Text: "the video is ready but its content could not be downloaded for a preview"})
	case len(body) > probeMaxVideoBytes:
		emit(ProbeEvent{Type: "progress", Kind: ProbeKindVideo, Text: fmt.Sprintf("the video is ready (over %d MiB, too large to preview)", probeMaxVideoBytes>>20)})
	case len(body) > 0:
		mime := strings.TrimSpace(strings.Split(ct, ";")[0])
		if mime == "" || mime == "application/octet-stream" {
			mime = "video/mp4"
		}
		emit(ProbeEvent{Type: "media", Kind: ProbeKindVideo, MimeType: mime, MediaURL: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)})
	}
}

// probeVideoError reads the message of a failed task's `error` (an object or a string).
func probeVideoError(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var obj struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	if json.Unmarshal(raw, &obj) == nil && (obj.Message != "" || obj.Code != "") {
		return firstNonEmpty(obj.Message, obj.Code)
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
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
