package dataplane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	CodecOpenAICompletions        CodecKind = "openai_completions"
	CodecOpenAIAudioSpeech        CodecKind = "openai_audio_speech"
	CodecOpenAIAudioTranscription CodecKind = "openai_audio_transcriptions"
	CodecOpenAIAudioTranslation   CodecKind = "openai_audio_translations"
	CodecOpenAIRerank             CodecKind = "openai_rerank"
	CodecOpenAIModerations        CodecKind = "openai_moderations"
)

func isExtendedEndpoint(path string) bool {
	trimmed := strings.TrimRight(strings.TrimSpace(path), "/")
	switch trimmed {
	case "/v1/completions",
		"/v1/audio/speech",
		"/v1/audio/transcriptions",
		"/v1/audio/translations",
		"/v1/rerank",
		"/v1/moderations":
		return true
	default:
		return false
	}
}

func extendedCodecForPath(path string) CodecKind {
	switch strings.TrimRight(strings.TrimSpace(path), "/") {
	case "/v1/completions":
		return CodecOpenAICompletions
	case "/v1/audio/speech":
		return CodecOpenAIAudioSpeech
	case "/v1/audio/transcriptions":
		return CodecOpenAIAudioTranscription
	case "/v1/audio/translations":
		return CodecOpenAIAudioTranslation
	case "/v1/rerank":
		return CodecOpenAIRerank
	case "/v1/moderations":
		return CodecOpenAIModerations
	default:
		return CodecOpenAIChat
	}
}

func parseExtendedIngress(r *http.Request, rawBody []byte) (*CanonicalTurn, error) {
	path := strings.TrimRight(strings.TrimSpace(r.URL.Path), "/")
	codec := extendedCodecForPath(path)
	turn := &CanonicalTurn{
		IngressCodec:        codec,
		RawBody:             rawBody,
		CallerDeclaredTools: make(map[string]bool),
	}

	ct := strings.TrimSpace(r.Header.Get("Content-Type"))
	if (codec == CodecOpenAIAudioTranscription || codec == CodecOpenAIAudioTranslation) &&
		strings.HasPrefix(strings.ToLower(ct), "multipart/form-data") {
		turn.MultipartContentType = ct
		mediaType, params, err := mime.ParseMediaType(ct)
		if err != nil || !strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
			return nil, fmt.Errorf("invalid multipart/form-data header")
		}
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return nil, fmt.Errorf("missing multipart boundary")
		}
		mr := multipart.NewReader(bytes.NewReader(rawBody), boundary)
		var fileBytes int
		var promptText string
		for {
			part, pErr := mr.NextPart()
			if pErr == io.EOF {
				break
			}
			if pErr != nil {
				return nil, fmt.Errorf("invalid multipart audio form: %w", pErr)
			}
			data, _ := io.ReadAll(io.LimitReader(part, 16*1024*1024))
			_ = part.Close()
			switch part.FormName() {
			case "model":
				turn.PublicModel = strings.TrimSpace(string(data))
			case "prompt":
				promptText = strings.TrimSpace(string(data))
			case "file":
				fileBytes += len(data)
			}
		}
		turn.EstimatedInputTokens = uint64(max(16, (fileBytes/512)+(len(promptText)+3)/4))
		turn.BodyExcerpt = promptText[:min(len(promptText), 8192)]
		return turn, nil
	}

	switch codec {
	case CodecOpenAICompletions:
		var payload struct {
			Model     string          `json:"model"`
			Prompt    json.RawMessage `json:"prompt"`
			Stream    bool            `json:"stream"`
			MaxTokens uint64          `json:"max_tokens"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid completions JSON: %w", err)
		}
		turn.PublicModel = strings.TrimSpace(payload.Model)
		turn.Stream = payload.Stream
		turn.MaxTokens = payload.MaxTokens
		prompt := extractEmbeddingInputText(payload.Prompt)
		turn.EstimatedInputTokens = uint64(max(8, (len(prompt)+3)/4))
		turn.BodyExcerpt = prompt[:min(len(prompt), 8192)]
		return turn, nil

	case CodecOpenAIAudioSpeech:
		var payload struct {
			Model string `json:"model"`
			Input string `json:"input"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid audio speech JSON: %w", err)
		}
		turn.PublicModel = firstNonEmpty(payload.Model, "tts-1")
		turn.EstimatedInputTokens = uint64(max(8, (len(payload.Input)+3)/4))
		turn.BodyExcerpt = payload.Input[:min(len(payload.Input), 8192)]
		return turn, nil

	case CodecOpenAIAudioTranscription, CodecOpenAIAudioTranslation:
		var payload struct {
			Model string `json:"model"`
			Prompt string `json:"prompt"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid audio JSON: %w", err)
		}
		turn.PublicModel = firstNonEmpty(payload.Model, "whisper-1")
		turn.EstimatedInputTokens = uint64(max(16, (len(rawBody)+3)/4))
		turn.BodyExcerpt = payload.Prompt[:min(len(payload.Prompt), 8192)]
		return turn, nil

	case CodecOpenAIRerank:
		var payload struct {
			Model     string   `json:"model"`
			Query     string   `json:"query"`
			Documents []string `json:"documents"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid rerank JSON: %w", err)
		}
		turn.PublicModel = strings.TrimSpace(payload.Model)
		totalLen := len(payload.Query)
		for _, doc := range payload.Documents {
			totalLen += len(doc)
		}
		turn.EstimatedInputTokens = uint64(max(8, (totalLen+3)/4))
		turn.BodyExcerpt = payload.Query[:min(len(payload.Query), 8192)]
		return turn, nil

	case CodecOpenAIModerations:
		var payload struct {
			Model string          `json:"model"`
			Input json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid moderations JSON: %w", err)
		}
		turn.PublicModel = firstNonEmpty(payload.Model, "omni-moderation-latest")
		txt := firstNonEmpty(extractEmbeddingInputText(payload.Input), string(payload.Input))
		turn.EstimatedInputTokens = uint64(max(8, (len(txt)+3)/4))
		turn.BodyExcerpt = txt[:min(len(txt), 8192)]
		return turn, nil
	}

	return nil, fmt.Errorf("unsupported extended route %s", r.URL.Path)
}

func buildExtendedUpstreamRequest(
	ctx context.Context,
	reqPath string,
	pctx OutboundPersonaContext,
	upstreamModel string,
	secret AccountSecret,
	turn *CanonicalTurn,
) (*http.Request, CodecKind, error) {
	baseURL := resolveProviderBaseURL(pctx.Provider, secret.BaseURL)
	trimmedPath := strings.TrimRight(strings.TrimSpace(reqPath), "/")
	targetURL := joinProviderPath(baseURL, trimmedPath)
	egress := extendedCodecForPath(trimmedPath)

	var body []byte
	contentType := "application/json"
	if turn.MultipartContentType != "" {
		body = turn.RawBody
		contentType = turn.MultipartContentType
	} else {
		body = rewriteJSONModel(turn.RawBody, upstreamModel)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		return nil, egress, err
	}
	applyUpstreamAuthHeaders(req, pctx, secret)
	req.Header.Set("Content-Type", contentType)
	if turn.Stream {
		req.Header.Set("Accept", "text/event-stream")
	} else if egress != CodecOpenAIAudioSpeech {
		req.Header.Set("Accept", "application/json")
	}
	return req, egress, nil
}

func executeMockExtendedTurn(turn *CanonicalTurn, upstreamModel string) *http.Response {
	headers := make(http.Header)
	inTok := max(uint64(8), turn.EstimatedInputTokens)
	outTok := uint64(12)

	switch turn.IngressCodec {
	case CodecOpenAICompletions:
		if turn.Stream {
			headers.Set("Content-Type", "text/event-stream; charset=utf-8")
			var sse bytes.Buffer
			writeSSEData(&sse, map[string]any{
				"id":      "cmpl_mock_stream_01",
				"object":  "text_completion",
				"model":   upstreamModel,
				"choices": []map[string]any{{"index": 0, "text": "Slipgate completion ", "finish_reason": nil}},
			})
			writeSSEData(&sse, map[string]any{
				"id":      "cmpl_mock_stream_01",
				"object":  "text_completion",
				"model":   upstreamModel,
				"choices": []map[string]any{{"index": 0, "text": "ok", "finish_reason": "stop"}},
				"usage":   map[string]any{"prompt_tokens": inTok, "completion_tokens": outTok, "total_tokens": inTok + outTok},
			})
			sse.WriteString("data: [DONE]\n\n")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     headers,
				Body:       io.NopCloser(bytes.NewReader(sse.Bytes())),
			}
		}
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"id":      "cmpl_mock_01",
			"object":  "text_completion",
			"created": time.Now().Unix(),
			"model":   upstreamModel,
			"choices": []map[string]any{
				{"text": "Slipgate completion ok", "index": 0, "finish_reason": "stop"},
			},
			"usage": map[string]any{
				"prompt_tokens":     inTok,
				"completion_tokens": outTok,
				"total_tokens":      inTok + outTok,
			},
		})

	case CodecOpenAIAudioSpeech:
		headers.Set("Content-Type", "audio/mpeg")
		audio := []byte("ID3\x03\x00\x00\x00\x00\x00\x00slipgate-mock-mp3")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     headers,
			Body:       io.NopCloser(bytes.NewReader(audio)),
		}

	case CodecOpenAIAudioTranscription:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"text": "Slipgate audio transcription ok",
		})

	case CodecOpenAIAudioTranslation:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"text": "Slipgate audio translation ok",
		})

	case CodecOpenAIRerank:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"id": "rerank_mock_01",
			"results": []map[string]any{
				{"index": 0, "relevance_score": 0.96},
			},
			"usage": map[string]any{
				"total_tokens": inTok,
			},
		})

	case CodecOpenAIModerations:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"id":    "modr_mock_01",
			"model": upstreamModel,
			"results": []map[string]any{
				{
					"flagged": false,
					"categories": map[string]bool{
						"hate":     false,
						"violence": false,
					},
					"category_scores": map[string]float64{
						"hate":     0.001,
						"violence": 0.001,
					},
				},
			},
		})
	}
	return jsonHTTPResponse(http.StatusOK, headers, map[string]any{"ok": true})
}

func relayExtendedResponse(
	w http.ResponseWriter,
	resp *http.Response,
	egress CodecKind,
	turn *CanonicalTurn,
	directive *coreDispatchDirective,
	startedAt time.Time,
) (RelayMetrics, error) {
	metrics := RelayMetrics{
		UpstreamStatus: resp.StatusCode,
		EgressCodec:    egress,
	}
	metrics.Window5hUsedBps, metrics.Window7dUsedBps = extractQuotaWatermarks(resp.Header)

	if resp.StatusCode >= 400 {
		rawErr, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
		if err != nil {
			return metrics, err
		}
		copyRetryHeaders(w.Header(), resp.Header)
		errType, errCode, message := extractUpstreamError(rawErr, resp.Status)
		metrics.ErrorType = errType
		metrics.ErrorCode = errCode
		metrics.ErrorMessage = message
		metrics.ErrorBody = truncateUTF8(string(rawErr), requestErrorMaxBodyLen)
		metrics.TTFTMs = elapsedMs(startedAt)
		WriteProtocolError(w, CodecOpenAIChat, resp.StatusCode, firstNonEmpty(errType, "upstream_error"),
			firstNonEmpty(errCode, "upstream_http_"+strconv.Itoa(resp.StatusCode)), message)
		return metrics, nil
	}

	if egress == CodecOpenAIAudioSpeech {
		metrics.InputTokens = turn.EstimatedInputTokens
		if ct := strings.TrimSpace(resp.Header.Get("Content-Type")); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "audio/mpeg")
		}
		w.WriteHeader(resp.StatusCode)
		n, copyErr := io.Copy(w, resp.Body)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		metrics.TTFTMs = elapsedMs(startedAt)
		if n > 0 {
			metrics.OutputTokens = uint64(max(int64(1), n/256))
		}
		return metrics, copyErr
	}

	if egress == CodecOpenAICompletions &&
		strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(resp.StatusCode)
		flusher, _ := w.(http.Flusher)

		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 32*1024), 4*1024*1024)
		var outChars uint64
		for sc.Scan() {
			if metrics.TTFTMs == 0 {
				metrics.TTFTMs = elapsedMs(startedAt)
			}
			line := sc.Text()
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if payload != "" && payload != "[DONE]" {
					var chunk struct {
						Choices []struct {
							Text string `json:"text"`
						} `json:"choices"`
						Usage *openAIWireUsage `json:"usage"`
					}
					if json.Unmarshal([]byte(payload), &chunk) == nil {
						for _, ch := range chunk.Choices {
							outChars += uint64(len(ch.Text))
						}
						if chunk.Usage != nil {
							u := chunk.Usage.canonical()
							if u.InputSeen {
								metrics.InputTokens = u.InputTokens
							}
							if u.OutputSeen {
								metrics.OutputTokens = u.OutputTokens
							}
						}
					}
				}
			}
			_, _ = io.WriteString(w, line+"\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		if metrics.TTFTMs == 0 {
			metrics.TTFTMs = elapsedMs(startedAt)
		}
		if metrics.InputTokens == 0 {
			metrics.InputTokens = turn.EstimatedInputTokens
		}
		if metrics.OutputTokens == 0 && outChars > 0 {
			metrics.OutputTokens = uint64(max(1, (outChars+3)/4))
		}
		return metrics, sc.Err()
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if err != nil {
		return metrics, err
	}
	metrics.TTFTMs = elapsedMs(startedAt)
	metrics.InputTokens = turn.EstimatedInputTokens

	switch egress {
	case CodecOpenAICompletions:
		var cmpl struct {
			Usage *openAIWireUsage `json:"usage"`
		}
		if json.Unmarshal(raw, &cmpl) == nil && cmpl.Usage != nil {
			u := cmpl.Usage.canonical()
			if u.InputTokens > 0 {
				metrics.InputTokens = u.InputTokens
			}
			metrics.OutputTokens = u.OutputTokens
		}
		raw = rewriteTopLevelModel(raw, CodecOpenAIChat, directive.PublicModel)

	case CodecOpenAIAudioTranscription, CodecOpenAIAudioTranslation:
		var tr struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &tr) == nil && tr.Text != "" {
			metrics.OutputTokens = uint64(max(1, (len(tr.Text)+3)/4))
		}

	case CodecOpenAIRerank:
		var rr struct {
			Usage *struct {
				TotalTokens uint64 `json:"total_tokens"`
			} `json:"usage"`
			Meta *struct {
				BilledUnits *struct {
					SearchUnits uint64 `json:"search_units"`
					InputTokens uint64 `json:"input_tokens"`
				} `json:"billed_units"`
				Tokens *struct {
					InputTokens uint64 `json:"input_tokens"`
				} `json:"tokens"`
			} `json:"meta"`
		}
		if json.Unmarshal(raw, &rr) == nil {
			switch {
			case rr.Usage != nil && rr.Usage.TotalTokens > 0:
				metrics.InputTokens = rr.Usage.TotalTokens
			case rr.Meta != nil && rr.Meta.Tokens != nil && rr.Meta.Tokens.InputTokens > 0:
				metrics.InputTokens = rr.Meta.Tokens.InputTokens
			case rr.Meta != nil && rr.Meta.BilledUnits != nil && rr.Meta.BilledUnits.InputTokens > 0:
				metrics.InputTokens = rr.Meta.BilledUnits.InputTokens
			}
		}

	case CodecOpenAIModerations:
		raw = rewriteTopLevelModel(raw, CodecOpenAIChat, directive.PublicModel)
	}

	w.Header().Set("Content-Type", firstNonEmpty(resp.Header.Get("Content-Type"), "application/json; charset=utf-8"))
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(raw)
	return metrics, nil
}
