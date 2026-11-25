package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	CodecOpenAIEmbeddings CodecKind = "openai_embeddings"
	CodecOpenAIImages     CodecKind = "openai_images"
	CodecOpenAIVideos     CodecKind = "openai_videos"
)

type mediaTaskAffinity struct {
	taskID        string
	ownerKeyID    string
	userID        string
	groupID       string
	accountID     string
	provider      string
	publicModel   string
	upstreamModel string
	expiresAt     time.Time
}

type mediaTaskStore struct {
	mu         sync.Mutex
	tasks      map[string]mediaTaskAffinity
	order      []string
	persistPut func(entry mediaTaskAffinity)
	persistGet func(apiKeyID, taskID string) (mediaTaskAffinity, bool)
}

func (m *mediaTaskStore) storeLocal(entry mediaTaskAffinity) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tasks == nil {
		m.tasks = make(map[string]mediaTaskAffinity)
	}
	now := time.Now()
	kept := m.order[:0]
	for _, id := range m.order {
		if e, ok := m.tasks[id]; ok && now.Before(e.expiresAt) {
			kept = append(kept, id)
		} else {
			delete(m.tasks, id)
		}
	}
	m.order = kept
	for len(m.tasks) >= 2048 && len(m.order) > 0 {
		evict := m.order[0]
		m.order = m.order[1:]
		delete(m.tasks, evict)
	}
	if _, exists := m.tasks[entry.taskID]; !exists {
		m.order = append(m.order, entry.taskID)
	}
	m.tasks[entry.taskID] = entry
}

func (m *mediaTaskStore) put(entry mediaTaskAffinity) {
	if m == nil || entry.taskID == "" {
		return
	}
	m.storeLocal(entry)
	m.mu.Lock()
	putFn := m.persistPut
	m.mu.Unlock()
	if putFn != nil {
		putFn(entry)
	}
}

func (m *mediaTaskStore) get(apiKeyID, taskID string) (mediaTaskAffinity, bool) {
	if m == nil || apiKeyID == "" || taskID == "" {
		return mediaTaskAffinity{}, false
	}
	m.mu.Lock()
	ent, ok := m.tasks[taskID]
	fetchFn := m.persistGet
	if ok && ent.ownerKeyID == apiKeyID && time.Now().Before(ent.expiresAt) {
		m.mu.Unlock()
		return ent, true
	}
	m.mu.Unlock()
	if fetchFn == nil {
		return mediaTaskAffinity{}, false
	}
	loaded, found := fetchFn(apiKeyID, taskID)
	if !found || time.Now().After(loaded.expiresAt) {
		return mediaTaskAffinity{}, false
	}
	m.storeLocal(loaded)
	return loaded, true
}

func isEmbeddingsEndpoint(path string) bool {
	trimmed := strings.TrimSuffix(path, "/")
	if trimmed == "/v1/embeddings" {
		return true
	}
	if strings.HasPrefix(trimmed, "/v1beta/models/") {
		return strings.HasSuffix(trimmed, ":embedContent") || strings.HasSuffix(trimmed, ":batchEmbedContents")
	}
	return false
}

func isImagesEndpoint(path string) bool {
	switch strings.TrimSuffix(path, "/") {
	case "/v1/images/generations", "/v1/images/edits":
		return true
	default:
		return false
	}
}

func isVideosPostEndpoint(path string) bool {
	switch strings.TrimSuffix(path, "/") {
	case "/v1/videos", "/v1/videos/generations":
		return true
	default:
		return false
	}
}

// videoSecondsValue reads a video length given as a JSON number or a numeric string (rounded up
// to whole seconds); 0 when absent or not a positive number.
func videoSecondsValue(raw json.RawMessage) uint32 {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if text == "" || text == "null" {
		return 0
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || f <= 0 || f > 1e6 {
		return 0
	}
	return uint32(math.Ceil(f))
}

func parseMultimodalIngress(r *http.Request, rawBody []byte) (*CanonicalTurn, error) {
	path := r.URL.Path
	ct := r.Header.Get("Content-Type")
	switch {
	case isEmbeddingsEndpoint(path):
		turn := &CanonicalTurn{
			IngressCodec: CodecOpenAIEmbeddings,
			MaxTokens:    64,
			RawBody:      rawBody,
		}
		if strings.HasPrefix(path, "/v1beta/models/") {
			turn.IngressCodec = CodecGeminiGenerate
			rest := strings.TrimPrefix(path, "/v1beta/models/")
			if idx := strings.IndexByte(rest, ':'); idx > 0 {
				turn.PublicModel = strings.TrimSpace(rest[:idx])
			}
		}
		var payload struct {
			Model string          `json:"model"`
			Input json.RawMessage `json:"input"`
		}
		if len(bytes.TrimSpace(rawBody)) > 0 {
			if err := json.Unmarshal(rawBody, &payload); err != nil {
				return nil, fmt.Errorf("invalid embeddings JSON: %w", err)
			}
		}
		if strings.TrimSpace(payload.Model) != "" {
			turn.PublicModel = strings.TrimSpace(payload.Model)
		}
		textSample := extractEmbeddingInputText(payload.Input)
		if textSample == "" {
			textSample = string(rawBody)
		}
		turn.EstimatedInputTokens = uint64(max(16, (len(textSample)+3)/4))
		turn.BodyExcerpt = textSample[:min(len(textSample), 8192)]
		return turn, nil

	case isImagesEndpoint(path):
		turn := &CanonicalTurn{
			IngressCodec: CodecOpenAIImages,
			MaxTokens:    64,
			ImageCount:   1,
			RawBody:      rawBody,
		}
		mediaType, params, _ := mime.ParseMediaType(ct)
		if strings.HasPrefix(strings.ToLower(mediaType), "multipart/") && params["boundary"] != "" {
			mr := multipart.NewReader(bytes.NewReader(rawBody), params["boundary"])
			var prompt string
			for {
				part, err := mr.NextPart()
				if err != nil {
					break
				}
				name := part.FormName()
				if name == "model" || name == "n" || name == "prompt" {
					valBytes, _ := io.ReadAll(io.LimitReader(part, 16*1024))
					val := strings.TrimSpace(string(valBytes))
					switch name {
					case "model":
						turn.PublicModel = val
					case "n":
						if n, nerr := strconv.Atoi(val); nerr == nil && n > 0 && n <= 16 {
							turn.ImageCount = uint32(n)
						}
					case "prompt":
						prompt = val
					}
				}
				_ = part.Close()
			}
			turn.MultipartContentType = ct
			turn.EstimatedInputTokens = uint64(max(32, (len(prompt)+3)/4))
			turn.BodyExcerpt = prompt
			return turn, nil
		}

		var payload struct {
			Model  string `json:"model"`
			Prompt string `json:"prompt"`
			N      int    `json:"n"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid image generation JSON: %w", err)
		}
		turn.PublicModel = strings.TrimSpace(payload.Model)
		if payload.N > 0 && payload.N <= 16 {
			turn.ImageCount = uint32(payload.N)
		}
		turn.EstimatedInputTokens = uint64(max(32, (len(payload.Prompt)+3)/4))
		turn.BodyExcerpt = payload.Prompt[:min(len(payload.Prompt), 8192)]
		return turn, nil

	case isVideosPostEndpoint(path):
		turn := &CanonicalTurn{
			IngressCodec: CodecOpenAIVideos,
			MaxTokens:    64,
			VideoSeconds: 5,
			RawBody:      rawBody,
		}
		var payload struct {
			Model  string `json:"model"`
			Prompt string `json:"prompt"`
			// OpenAI's Videos API sends seconds as a string ("4"); others send a number.
			Seconds  json.RawMessage `json:"seconds"`
			Duration json.RawMessage `json:"duration"`
		}
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			return nil, fmt.Errorf("invalid video generation JSON: %w", err)
		}
		turn.PublicModel = strings.TrimSpace(payload.Model)
		if s := videoSecondsValue(payload.Seconds); s > 0 && s <= 120 {
			turn.VideoSeconds = s
		} else if d := videoSecondsValue(payload.Duration); d > 0 && d <= 120 {
			turn.VideoSeconds = d
		}
		turn.EstimatedInputTokens = uint64(max(32, (len(payload.Prompt)+3)/4))
		turn.BodyExcerpt = payload.Prompt[:min(len(payload.Prompt), 8192)]
		return turn, nil
	}
	return nil, fmt.Errorf("unsupported multimodal route %s", path)
}

func extractEmbeddingInputText(raw json.RawMessage) string {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return strings.Join(list, "\n")
	}
	return ""
}

func buildMultimodalUpstreamRequest(
	ctx context.Context,
	reqPath string,
	pctx OutboundPersonaContext,
	upstreamModel string,
	secret AccountSecret,
	turn *CanonicalTurn,
) (*http.Request, CodecKind, error) {
	baseURL := resolveProviderBaseURL(pctx.Provider, secret.BaseURL)
	prov := strings.ToLower(strings.TrimSpace(pctx.Provider))

	switch {
	case isEmbeddingsEndpoint(reqPath):
		if prov == "gemini" {
			var gemBody []byte
			if turn.IngressCodec == CodecGeminiGenerate {
				gemBody = turn.RawBody
			} else {
				var oa struct {
					Input json.RawMessage `json:"input"`
				}
				_ = json.Unmarshal(turn.RawBody, &oa)
				text := extractEmbeddingInputText(oa.Input)
				gemBody, _ = json.Marshal(map[string]any{
					"model": "models/" + upstreamModel,
					"content": map[string]any{
						"parts": []map[string]any{{"text": text}},
					},
				})
			}
			targetURL := joinProviderPath(baseURL, "/v1beta/models/"+upstreamModel+":embedContent")
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(gemBody))
			if err != nil {
				return nil, CodecGeminiGenerate, err
			}
			applyUpstreamAuthHeaders(req, pctx, secret)
			req.Header.Set("Content-Type", "application/json")
			return req, CodecGeminiGenerate, nil
		}

		rewritten := rewriteJSONModel(turn.RawBody, upstreamModel)
		targetURL := joinProviderPath(baseURL, "/v1/embeddings")
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(rewritten))
		if err != nil {
			return nil, CodecOpenAIEmbeddings, err
		}
		applyUpstreamAuthHeaders(req, pctx, secret)
		req.Header.Set("Content-Type", "application/json")
		return req, CodecOpenAIEmbeddings, nil

	case isImagesEndpoint(reqPath):
		if turn.MultipartContentType != "" {
			suffix := "/v1/images/edits"
			targetURL := joinProviderPath(baseURL, suffix)
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(turn.RawBody))
			if err != nil {
				return nil, CodecOpenAIImages, err
			}
			applyUpstreamAuthHeaders(req, pctx, secret)
			req.Header.Set("Content-Type", turn.MultipartContentType)
			return req, CodecOpenAIImages, nil
		}

		if prov == "gemini" {
			var oa struct {
				Prompt string `json:"prompt"`
				N      int    `json:"n"`
			}
			_ = json.Unmarshal(turn.RawBody, &oa)
			count := max(1, oa.N)
			gemBody, _ := json.Marshal(map[string]any{
				"instances":  []map[string]any{{"prompt": oa.Prompt}},
				"parameters": map[string]any{"sampleCount": count},
			})
			targetURL := joinProviderPath(baseURL, "/v1beta/models/"+upstreamModel+":predict")
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(gemBody))
			if err != nil {
				return nil, CodecGeminiGenerate, err
			}
			applyUpstreamAuthHeaders(req, pctx, secret)
			req.Header.Set("Content-Type", "application/json")
			return req, CodecGeminiGenerate, nil
		}

		rewritten := rewriteJSONModel(turn.RawBody, upstreamModel)
		suffix := "/v1/images/generations"
		if strings.HasSuffix(strings.TrimSuffix(reqPath, "/"), "/edits") {
			suffix = "/v1/images/edits"
		}
		targetURL := joinProviderPath(baseURL, suffix)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(rewritten))
		if err != nil {
			return nil, CodecOpenAIImages, err
		}
		applyUpstreamAuthHeaders(req, pctx, secret)
		req.Header.Set("Content-Type", "application/json")
		return req, CodecOpenAIImages, nil

	default:
		rewritten := rewriteJSONModel(turn.RawBody, upstreamModel)
		suffix := "/v1/videos"
		if strings.HasSuffix(strings.TrimSuffix(reqPath, "/"), "/generations") {
			suffix = "/v1/videos/generations"
		}
		targetURL := joinProviderPath(baseURL, suffix)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(rewritten))
		if err != nil {
			return nil, CodecOpenAIVideos, err
		}
		applyUpstreamAuthHeaders(req, pctx, secret)
		req.Header.Set("Content-Type", "application/json")
		return req, CodecOpenAIVideos, nil
	}
}

func applyUpstreamAuthHeaders(req *http.Request, pctx OutboundPersonaContext, secret AccountSecret) {
	prov := strings.ToLower(strings.TrimSpace(pctx.Provider))
	switch prov {
	case "gemini":
		if strings.EqualFold(pctx.AuthKind, "oauth") {
			req.Header.Set("Authorization", "Bearer "+secret.APIKey)
		} else if secret.APIKey != "" {
			req.Header.Set("x-goog-api-key", secret.APIKey)
		}
	case "anthropic":
		if IsClaudeSubscription(pctx, secret) {
			ApplyClaudeSubscriptionHeadersWithContext(req, pctx, secret, "", false, false, CLIClaudeVersion())
		} else if secret.APIKey != "" {
			req.Header.Set("x-api-key", secret.APIKey)
			req.Header.Set("anthropic-version", "2023-06-01")
		}
	default:
		if secret.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+secret.APIKey)
		}
	}
	targetURL := ""
	if req != nil && req.URL != nil {
		targetURL = req.URL.String()
	}
	applyOpenCodeAndCommandCodeHeaders(req, pctx, secret, targetURL, &CanonicalTurn{})
	ApplyCLIProviderHeaders(req, pctx, secret, targetURL, CodecOpenAIChat)
	for k, v := range secret.Headers {
		if strings.EqualFold(k, "x-oauth-token-url") {
			continue
		}
		req.Header.Set(k, v)
	}
	SanitizeOutboundHeaders(req.Header)
}

func rewriteJSONModel(raw []byte, upstreamModel string) []byte {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return raw
	}
	mRaw, _ := json.Marshal(upstreamModel)
	obj["model"] = mRaw
	out, err := marshalNoEscape(obj)
	if err != nil {
		return raw
	}
	return out
}

func executeMockMultimodalTurn(turn *CanonicalTurn, upstreamModel string) *http.Response {
	headers := make(http.Header)
	switch turn.IngressCodec {
	case CodecOpenAIEmbeddings, CodecGeminiGenerate:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"object": "list",
			"model":  upstreamModel,
			"data": []map[string]any{
				{"object": "embedding", "index": 0, "embedding": []float64{0.0125, -0.035, 0.0875, 0.042}},
			},
			"usage": map[string]any{
				"prompt_tokens": turn.EstimatedInputTokens,
				"total_tokens":  turn.EstimatedInputTokens,
			},
		})
	case CodecOpenAIImages:
		items := make([]map[string]any, 0, max(1, int(turn.ImageCount)))
		for range max(1, int(turn.ImageCount)) {
			items = append(items, map[string]any{"b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="})
		}
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"created": time.Now().Unix(),
			"data":    items,
		})
	default:
		return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
			"id":         fmt.Sprintf("vid_%d", time.Now().UnixNano()),
			"object":     "video",
			"status":     "queued",
			"model":      upstreamModel,
			"created_at": time.Now().Unix(),
		})
	}
}

func relayMultimodalResponse(
	w http.ResponseWriter,
	resp *http.Response,
	egress CodecKind,
	turn *CanonicalTurn,
	directive *coreDispatchDirective,
	startedAt time.Time,
	tasks *mediaTaskStore,
) (RelayMetrics, error) {
	metrics := RelayMetrics{
		UpstreamStatus: resp.StatusCode,
		EgressCodec:    egress,
		TTFTMs:         elapsedMs(startedAt),
	}
	metrics.Window5hUsedBps, metrics.Window7dUsedBps = extractQuotaWatermarks(resp.Header)

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return metrics, err
	}
	if resp.StatusCode >= 400 {
		copyRetryHeaders(w.Header(), resp.Header)
		errType, errCode, message := extractUpstreamError(raw, resp.Status)
		metrics.ErrorType = errType
		metrics.ErrorCode = errCode
		metrics.ErrorMessage = message
		metrics.ErrorBody = truncateUTF8(string(raw), requestErrorMaxBodyLen)
		WriteProtocolError(w, turn.IngressCodec, resp.StatusCode, firstNonEmpty(errType, "upstream_error"),
			firstNonEmpty(errCode, "upstream_http_"+strconv.Itoa(resp.StatusCode)), message)
		return metrics, nil
	}

	switch turn.IngressCodec {
	case CodecOpenAIEmbeddings:
		if egress == CodecGeminiGenerate {
			var gem struct {
				Embedding struct {
					Values []float64 `json:"values"`
				} `json:"embedding"`
			}
			_ = json.Unmarshal(raw, &gem)
			metrics.InputTokens = turn.EstimatedInputTokens
			writeJSONResponse(w, http.StatusOK, map[string]any{
				"object": "list",
				"model":  directive.PublicModel,
				"data": []map[string]any{
					{"object": "embedding", "index": 0, "embedding": gem.Embedding.Values},
				},
				"usage": map[string]any{
					"prompt_tokens": metrics.InputTokens,
					"total_tokens":  metrics.InputTokens,
				},
			})
			return metrics, nil
		}
		var oa struct {
			Usage *struct {
				PromptTokens uint64 `json:"prompt_tokens"`
				TotalTokens  uint64 `json:"total_tokens"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(raw, &oa)
		if oa.Usage != nil && oa.Usage.PromptTokens > 0 {
			metrics.InputTokens = oa.Usage.PromptTokens
		} else {
			metrics.InputTokens = turn.EstimatedInputTokens
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(rewriteTopLevelModel(raw, CodecOpenAIChat, directive.PublicModel))
		return metrics, nil

	case CodecOpenAIImages:
		if egress == CodecGeminiGenerate {
			var gem struct {
				Predictions []struct {
					BytesBase64 string `json:"bytesBase64Encoded"`
				} `json:"predictions"`
			}
			_ = json.Unmarshal(raw, &gem)
			data := make([]map[string]any, 0, len(gem.Predictions))
			for _, p := range gem.Predictions {
				if p.BytesBase64 != "" {
					data = append(data, map[string]any{"b64_json": p.BytesBase64})
				}
			}
			metrics.ImageCount = uint32(max(1, len(data)))
			writeJSONResponse(w, http.StatusOK, map[string]any{
				"created": time.Now().Unix(),
				"data":    data,
			})
			return metrics, nil
		}
		var imgResp struct {
			Data  []json.RawMessage `json:"data"`
			Usage *struct {
				InputTokens  uint64 `json:"input_tokens"`
				OutputTokens uint64 `json:"output_tokens"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(raw, &imgResp)
		if len(imgResp.Data) > 0 {
			metrics.ImageCount = uint32(len(imgResp.Data))
		} else {
			metrics.ImageCount = max(1, turn.ImageCount)
		}
		if imgResp.Usage != nil {
			metrics.InputTokens = imgResp.Usage.InputTokens
			metrics.OutputTokens = imgResp.Usage.OutputTokens
		}
		w.Header().Set("Content-Type", firstNonEmpty(resp.Header.Get("Content-Type"), "application/json; charset=utf-8"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		return metrics, nil

	case CodecOpenAIVideos:
		metrics.VideoSeconds = max(1, turn.VideoSeconds)
		var vidResp struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &vidResp) == nil && strings.TrimSpace(vidResp.ID) != "" && tasks != nil {
			tasks.put(mediaTaskAffinity{
				taskID:        strings.TrimSpace(vidResp.ID),
				ownerKeyID:    directive.APIKeyID,
				userID:        directive.UserID,
				groupID:       directive.GroupID,
				accountID:     directive.AccountID,
				provider:      directive.Provider,
				publicModel:   directive.PublicModel,
				upstreamModel: directive.UpstreamModel,
				expiresAt:     time.Now().Add(24 * time.Hour),
			})
		}
		w.Header().Set("Content-Type", firstNonEmpty(resp.Header.Get("Content-Type"), "application/json; charset=utf-8"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(rewriteTopLevelModel(raw, CodecOpenAIChat, directive.PublicModel))
		return metrics, nil

	default:
		metrics.InputTokens = turn.EstimatedInputTokens
		w.Header().Set("Content-Type", firstNonEmpty(resp.Header.Get("Content-Type"), "application/json; charset=utf-8"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		return metrics, nil
	}
}
