package dataplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
)

// CodecBedrockConverse represents AWS Bedrock Runtime's /converse and /converse-stream protocol.
const CodecBedrockConverse CodecKind = "bedrock_converse"

const (
	awsV4Algorithm     = "AWS4-HMAC-SHA256"
	defaultBedrockReg  = "us-east-1"
	defaultVertexLoc   = "us-central1"
	defaultVertexScope = "https://www.googleapis.com/auth/cloud-platform"
	defaultVertexTok   = "https://oauth2.googleapis.com/token"
)

// -----------------------------------------------------------------------------
// AWS SigV4 Request Signer
// -----------------------------------------------------------------------------

// SignAWSV4Request signs req in place using AWS Signature Version 4 (HMAC-SHA256).
func SignAWSV4Request(
	req *http.Request,
	body []byte,
	accessKeyID string,
	secretAccessKey string,
	sessionToken string,
	region string,
	service string,
	now time.Time,
) error {
	ak := strings.TrimSpace(accessKeyID)
	sk := strings.TrimSpace(secretAccessKey)
	reg := strings.TrimSpace(region)
	svc := strings.TrimSpace(service)
	if ak == "" || sk == "" {
		return errors.New("bedrock: awsAccessKeyId and awsSecretAccessKey are required for SigV4 signing")
	}
	if reg == "" {
		reg = defaultBedrockReg
	}
	if svc == "" {
		svc = "bedrock"
	}
	if req == nil || req.URL == nil {
		return errors.New("bedrock: nil request")
	}

	ts := now.UTC()
	amzDate := ts.Format("20060102T150405Z")
	dateStamp := ts.Format("20060102")

	sum := sha256.Sum256(body)
	payloadHash := hex.EncodeToString(sum[:])

	host := strings.TrimSpace(req.Host)
	if host == "" {
		host = req.URL.Host
	}
	req.Host = host
	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if st := strings.TrimSpace(sessionToken); st != "" {
		req.Header.Set("X-Amz-Security-Token", st)
	} else {
		req.Header.Del("X-Amz-Security-Token")
	}

	canonicalURI := awsCanonicalURI(req.URL)
	canonicalQuery := awsCanonicalQuery(req.URL.Query())

	headerMap := make(map[string]string, 8)
	headerNames := make([]string, 0, 8)
	for k, vals := range req.Header {
		lk := strings.ToLower(strings.TrimSpace(k))
		if lk == "" || lk == "authorization" || lk == "connection" || lk == "user-agent" {
			continue
		}
		if lk == "host" || strings.HasPrefix(lk, "x-amz-") || lk == "content-type" {
			joined := make([]string, 0, len(vals))
			for _, v := range vals {
				joined = append(joined, collapseSpaces(v))
			}
			headerMap[lk] = strings.Join(joined, ",")
			headerNames = append(headerNames, lk)
		}
	}
	if _, ok := headerMap["host"]; !ok {
		headerMap["host"] = host
		headerNames = append(headerNames, "host")
	}
	sort.Strings(headerNames)

	var canonicalHeaders strings.Builder
	for _, name := range headerNames {
		canonicalHeaders.WriteString(name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(headerMap[name])
		canonicalHeaders.WriteByte('\n')
	}
	signedHeaders := strings.Join(headerNames, ";")

	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	crSum := sha256.Sum256([]byte(canonicalRequest))
	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, reg, svc)
	stringToSign := strings.Join([]string{
		awsV4Algorithm,
		amzDate,
		credentialScope,
		hex.EncodeToString(crSum[:]),
	}, "\n")

	signingKey := awsV4DeriveKey(sk, dateStamp, reg, svc)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	req.Header.Set("Authorization", fmt.Sprintf(
		"%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		awsV4Algorithm, ak, credentialScope, signedHeaders, signature,
	))
	return nil
}

func awsCanonicalURI(u *url.URL) string {
	raw := u.EscapedPath()
	if raw == "" || raw == "/" {
		return "/"
	}
	segments := strings.Split(raw, "/")
	for i, seg := range segments {
		if seg == "" {
			continue
		}
		segments[i] = awsURIEscape(seg)
	}
	return strings.Join(segments, "/")
}

func awsURIEscape(s string) string {
	var b strings.Builder
	b.Grow(len(s) * 2)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func awsCanonicalQuery(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var pairs []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		ek := awsURIEscape(k)
		for _, v := range vals {
			pairs = append(pairs, ek+"="+awsURIEscape(v))
		}
	}
	return strings.Join(pairs, "&")
}

func collapseSpaces(s string) string {
	fields := strings.Fields(strings.TrimSpace(s))
	return strings.Join(fields, " ")
}

func awsV4DeriveKey(secret, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	_, _ = m.Write(data)
	return m.Sum(nil)
}

// -----------------------------------------------------------------------------
// AWS Bedrock Converse Request / Unary / EventStream Binary Decoder
// -----------------------------------------------------------------------------

func normalizeBedrockModelID(model string) string {
	m := strings.TrimSpace(model)
	lower := strings.ToLower(m)
	if strings.HasPrefix(lower, "bedrock/") {
		return m[len("bedrock/"):]
	}
	return m
}

func resolveBedrockRegion(secret AccountSecret) string {
	return firstNonEmpty(secret.AWSRegion, defaultBedrockReg)
}

func resolveBedrockBaseURL(secret AccountSecret) string {
	if custom := strings.TrimRight(strings.TrimSpace(secret.BaseURL), "/"); custom != "" {
		return custom
	}
	return fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com", resolveBedrockRegion(secret))
}

func buildBedrockConverseRequest(
	ctx context.Context,
	upstreamModel string,
	secret AccountSecret,
	turn *CanonicalTurn,
	filteredTools []CanonicalTool,
) (*http.Request, CodecKind, error) {
	modelID := normalizeBedrockModelID(upstreamModel)
	if modelID == "" {
		return nil, CodecBedrockConverse, errors.New("bedrock: missing upstream model ID")
	}

	baseURL := resolveBedrockBaseURL(secret)
	action := "/converse"
	if turn.Stream {
		action = "/converse-stream"
	}
	fullURL := baseURL + "/model/" + awsURIEscape(modelID) + action

	bodyRaw, err := encodeBedrockConverseBody(turn, filteredTools)
	if err != nil {
		return nil, CodecBedrockConverse, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewReader(bodyRaw))
	if err != nil {
		return nil, CodecBedrockConverse, err
	}
	SanitizeOutboundHeaders(req.Header)
	req.Header.Set("Content-Type", "application/json")
	if turn.Stream {
		req.Header.Set("Accept", "application/vnd.amazon.eventstream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	for k, v := range secret.Headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}

	if strings.TrimSpace(secret.AWSAccessKeyID) != "" && strings.TrimSpace(secret.AWSSecretAccessKey) != "" {
		if err := SignAWSV4Request(
			req,
			bodyRaw,
			secret.AWSAccessKeyID,
			secret.AWSSecretAccessKey,
			secret.AWSSessionToken,
			resolveBedrockRegion(secret),
			"bedrock",
			time.Now().UTC(),
		); err != nil {
			return nil, CodecBedrockConverse, err
		}
	} else if strings.TrimSpace(secret.APIKey) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(secret.APIKey))
	}
	return req, CodecBedrockConverse, nil
}

func encodeBedrockConverseBody(turn *CanonicalTurn, tools []CanonicalTool) ([]byte, error) {
	msgs := make([]map[string]any, 0, max(1, len(turn.Messages)))
	appendBlocks := func(role string, blocks []map[string]any) {
		if len(blocks) == 0 {
			return
		}
		if n := len(msgs); n > 0 && msgs[n-1]["role"] == role {
			msgs[n-1]["content"] = append(msgs[n-1]["content"].([]map[string]any), blocks...)
			return
		}
		msgs = append(msgs, map[string]any{"role": role, "content": blocks})
	}

	for _, m := range turn.Messages {
		switch m.Role {
		case "tool":
			status := "success"
			if m.IsError {
				status = "error"
			}
			text := firstNonEmpty(m.Content, "{}")
			appendBlocks("user", []map[string]any{{
				"toolResult": map[string]any{
					"toolUseId": firstNonEmpty(m.ToolCallID, "toolu_1"),
					"content":   []map[string]any{{"text": text}},
					"status":    status,
				},
			}})
		case "assistant":
			var blocks []map[string]any
			for _, th := range m.Thinking {
				if th.Text != "" {
					rt := map[string]any{"text": th.Text}
					if th.Signature != "" {
						rt["signature"] = th.Signature
					}
					blocks = append(blocks, map[string]any{
						"reasoningContent": map[string]any{"reasoningText": rt},
					})
				}
			}
			if m.Content != "" {
				blocks = append(blocks, map[string]any{"text": m.Content})
			}
			for _, tc := range m.ToolCalls {
				var inputObj any
				if json.Unmarshal([]byte(defaultJSONObject(tc.Arguments)), &inputObj) != nil || inputObj == nil {
					inputObj = map[string]any{}
				}
				blocks = append(blocks, map[string]any{
					"toolUse": map[string]any{
						"toolUseId": firstNonEmpty(tc.ID, "toolu_1"),
						"name":      tc.Name,
						"input":     inputObj,
					},
				})
			}
			appendBlocks("assistant", blocks)
		default:
			var blocks []map[string]any
			if len(m.Parts) > 0 {
				for _, p := range m.Parts {
					switch p.Type {
					case "text":
						if p.Text != "" {
							blocks = append(blocks, map[string]any{"text": p.Text})
						}
					case "image":
						if p.Data != "" {
							blocks = append(blocks, map[string]any{
								"image": map[string]any{
									"format": bedrockImageFormat(p.MediaType),
									"source": map[string]any{"bytes": p.Data},
								},
							})
						}
					case "document":
						if p.Data != "" {
							blocks = append(blocks, map[string]any{
								"document": map[string]any{
									"format": "pdf",
									"name":   "document",
									"source": map[string]any{"bytes": p.Data},
								},
							})
						}
					}
				}
			} else if m.Content != "" {
				blocks = append(blocks, map[string]any{"text": m.Content})
			}
			if len(blocks) == 0 {
				blocks = append(blocks, map[string]any{"text": ""})
			}
			appendBlocks("user", blocks)
		}
	}
	if len(msgs) == 0 {
		msgs = append(msgs, map[string]any{
			"role":    "user",
			"content": []map[string]any{{"text": ""}},
		})
	}

	payload := map[string]any{
		"messages": msgs,
	}
	if sys := strings.TrimSpace(turn.SystemPrompt); sys != "" {
		payload["system"] = []map[string]any{{"text": sys}}
	}

	inf := map[string]any{}
	if turn.MaxTokens > 0 {
		inf["maxTokens"] = turn.MaxTokens
	}
	if turn.Temperature != nil {
		inf["temperature"] = *turn.Temperature
	}
	if turn.TopP != nil {
		inf["topP"] = *turn.TopP
	}
	if len(turn.StopSequences) > 0 {
		inf["stopSequences"] = turn.StopSequences
	}
	if len(inf) > 0 {
		payload["inferenceConfig"] = inf
	}

	if len(tools) > 0 {
		bedrockTools := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			var schemaObj any
			if json.Unmarshal(ensureSchema(t.Parameters), &schemaObj) != nil {
				schemaObj = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			spec := map[string]any{
				"name": t.Name,
				"inputSchema": map[string]any{
					"json": schemaObj,
				},
			}
			if strings.TrimSpace(t.Description) != "" {
				spec["description"] = t.Description
			}
			bedrockTools = append(bedrockTools, map[string]any{"toolSpec": spec})
		}
		tc := map[string]any{"tools": bedrockTools}
		if turn.ToolChoice != nil {
			switch turn.ToolChoice.Mode {
			case "auto":
				tc["toolChoice"] = map[string]any{"auto": map[string]any{}}
			case "required":
				tc["toolChoice"] = map[string]any{"any": map[string]any{}}
			case "tool":
				if turn.ToolChoice.Name != "" {
					tc["toolChoice"] = map[string]any{"tool": map[string]any{"name": turn.ToolChoice.Name}}
				}
			}
		}
		payload["toolConfig"] = tc
	}

	return marshalNoEscape(payload)
}

func bedrockImageFormat(mediaType string) string {
	lower := strings.ToLower(strings.TrimSpace(mediaType))
	switch {
	case strings.Contains(lower, "jpeg"), strings.Contains(lower, "jpg"):
		return "jpeg"
	case strings.Contains(lower, "gif"):
		return "gif"
	case strings.Contains(lower, "webp"):
		return "webp"
	default:
		return "png"
	}
}

func mapBedrockStopReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "max_tokens", "model_context_window_exceeded":
		return stopLength
	case "tool_use":
		return stopTool
	case "stop_sequence":
		return stopSequence
	case "guardrail_intervened", "content_filtered":
		return stopFilter
	case "":
		return ""
	default:
		return stopEnd
	}
}

func parseBedrockConverseUnary(raw []byte) (canonicalResult, error) {
	res := canonicalResult{ID: fmt.Sprintf("br_%d", time.Now().UnixNano())}
	var br struct {
		StopReason string `json:"stopReason"`
		Output     *struct {
			Message *struct {
				Content []struct {
					Text             string `json:"text"`
					ReasoningContent *struct {
						ReasoningText *struct {
							Text      string `json:"text"`
							Signature string `json:"signature"`
						} `json:"reasoningText"`
					} `json:"reasoningContent"`
					ToolUse *struct {
						ToolUseID string          `json:"toolUseId"`
						Name      string          `json:"name"`
						Input     json.RawMessage `json:"input"`
					} `json:"toolUse"`
				} `json:"content"`
			} `json:"message"`
		} `json:"output"`
		Usage *struct {
			InputTokens           uint64 `json:"inputTokens"`
			OutputTokens          uint64 `json:"outputTokens"`
			CacheReadInputTokens  uint64 `json:"cacheReadInputTokens"`
			CacheWriteInputTokens uint64 `json:"cacheWriteInputTokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &br); err != nil {
		return res, fmt.Errorf("decode Bedrock Converse response: %w", err)
	}
	res.StopReason = mapBedrockStopReason(br.StopReason)
	if br.Output != nil && br.Output.Message != nil {
		var texts []string
		for _, blk := range br.Output.Message.Content {
			if blk.Text != "" {
				texts = append(texts, blk.Text)
			}
			if blk.ReasoningContent != nil && blk.ReasoningContent.ReasoningText != nil {
				rt := blk.ReasoningContent.ReasoningText
				res.Thinking = append(res.Thinking, CanonicalThinking{Text: rt.Text, Signature: rt.Signature})
			}
			if blk.ToolUse != nil && blk.ToolUse.Name != "" {
				res.ToolCalls = append(res.ToolCalls, CanonicalToolCall{
					ID:        blk.ToolUse.ToolUseID,
					Name:      blk.ToolUse.Name,
					Arguments: defaultJSONObject(string(blk.ToolUse.Input)),
				})
			}
		}
		res.Text = strings.Join(texts, "")
	}
	if br.Usage != nil {
		res.Usage = canonicalUsage{
			InputTokens:      br.Usage.InputTokens,
			OutputTokens:     br.Usage.OutputTokens,
			CacheReadTokens:  br.Usage.CacheReadInputTokens,
			CacheWriteTokens: br.Usage.CacheWriteInputTokens,
			InputSeen:        true,
			OutputSeen:       true,
		}
	}
	return res, nil
}

// encodeBedrockEventFrame encodes one AWS EventStream binary frame with valid IEEE CRC32 checksums.
func encodeBedrockEventFrame(eventType string, payload []byte) []byte {
	var hdrs bytes.Buffer
	writeEventHeaderString(&hdrs, ":message-type", "event")
	writeEventHeaderString(&hdrs, ":event-type", eventType)
	writeEventHeaderString(&hdrs, ":content-type", "application/json")

	headersLen := uint32(hdrs.Len())
	totalLen := uint32(12 + int(headersLen) + len(payload) + 4)

	buf := make([]byte, totalLen)
	binary.BigEndian.PutUint32(buf[0:4], totalLen)
	binary.BigEndian.PutUint32(buf[4:8], headersLen)
	binary.BigEndian.PutUint32(buf[8:12], crc32.ChecksumIEEE(buf[0:8]))
	copy(buf[12:12+headersLen], hdrs.Bytes())
	copy(buf[12+headersLen:12+headersLen+uint32(len(payload))], payload)
	binary.BigEndian.PutUint32(buf[totalLen-4:], crc32.ChecksumIEEE(buf[:totalLen-4]))
	return buf
}

func writeEventHeaderString(w *bytes.Buffer, name, val string) {
	w.WriteByte(byte(len(name)))
	w.WriteString(name)
	w.WriteByte(7) // string header value type in AWS EventStream
	var l [2]byte
	binary.BigEndian.PutUint16(l[:], uint16(len(val)))
	w.Write(l[:])
	w.WriteString(val)
}

// pumpBedrockEventStream decodes AWS EventStream binary frames into turnRelay events.
func pumpBedrockEventStream(r io.Reader, relay *turnRelay) error {
	var prelude [12]byte
	for {
		_, err := io.ReadFull(r, prelude[:])
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		totalLen := binary.BigEndian.Uint32(prelude[0:4])
		headersLen := binary.BigEndian.Uint32(prelude[4:8])
		preludeCRC := binary.BigEndian.Uint32(prelude[8:12])
		if crc32.ChecksumIEEE(prelude[0:8]) != preludeCRC {
			return errors.New("bedrock: eventstream prelude CRC mismatch")
		}
		if totalLen < 16 || totalLen > 16*1024*1024 || headersLen > totalLen-16 {
			return fmt.Errorf("bedrock: invalid eventstream frame lengths total=%d headers=%d", totalLen, headersLen)
		}

		rest := make([]byte, totalLen-12)
		if _, err := io.ReadFull(r, rest); err != nil {
			return err
		}
		crcInput := crc32.NewIEEE()
		_, _ = crcInput.Write(prelude[:])
		_, _ = crcInput.Write(rest[:len(rest)-4])
		msgCRC := binary.BigEndian.Uint32(rest[len(rest)-4:])
		if crcInput.Sum32() != msgCRC {
			return errors.New("bedrock: eventstream message CRC mismatch")
		}

		headers := parseBedrockEventHeaders(rest[:headersLen])
		payload := rest[headersLen : len(rest)-4]

		msgType := headers[":message-type"]
		if msgType == "exception" || headers[":exception-type"] != "" {
			msg := firstNonEmpty(extractErrorMessage(payload, headers[":exception-type"]), "bedrock exception")
			relay.Fail(http.StatusBadGateway, "upstream_error", msg)
			return nil
		}

		switch headers[":event-type"] {
		case "contentBlockStart":
			var ev struct {
				Start struct {
					ToolUse *struct {
						ToolUseID string `json:"toolUseId"`
						Name      string `json:"name"`
					} `json:"toolUse"`
				} `json:"start"`
			}
			if json.Unmarshal(payload, &ev) == nil && ev.Start.ToolUse != nil && ev.Start.ToolUse.Name != "" {
				relay.ToolStart(ev.Start.ToolUse.ToolUseID, ev.Start.ToolUse.Name)
			}

		case "contentBlockDelta":
			var ev struct {
				Delta struct {
					Text             string `json:"text"`
					ReasoningContent *struct {
						Text      string `json:"text"`
						Signature string `json:"signature"`
					} `json:"reasoningContent"`
					ToolUse *struct {
						Input string `json:"input"`
					} `json:"toolUse"`
				} `json:"delta"`
			}
			if json.Unmarshal(payload, &ev) == nil {
				if ev.Delta.Text != "" {
					relay.Text(ev.Delta.Text)
				}
				if ev.Delta.ReasoningContent != nil {
					if ev.Delta.ReasoningContent.Text != "" {
						relay.Thinking(ev.Delta.ReasoningContent.Text)
					}
					if ev.Delta.ReasoningContent.Signature != "" {
						relay.ThinkingSignature(ev.Delta.ReasoningContent.Signature)
					}
				}
				if ev.Delta.ToolUse != nil && ev.Delta.ToolUse.Input != "" {
					relay.ToolArgs(ev.Delta.ToolUse.Input)
				}
			}

		case "contentBlockStop":
			relay.ToolEnd()

		case "messageStop":
			var ev struct {
				StopReason string `json:"stopReason"`
			}
			if json.Unmarshal(payload, &ev) == nil && ev.StopReason != "" {
				relay.Stop(mapBedrockStopReason(ev.StopReason), "")
			}

		case "metadata":
			var ev struct {
				Usage *struct {
					InputTokens           uint64 `json:"inputTokens"`
					OutputTokens          uint64 `json:"outputTokens"`
					CacheReadInputTokens  uint64 `json:"cacheReadInputTokens"`
					CacheWriteInputTokens uint64 `json:"cacheWriteInputTokens"`
				} `json:"usage"`
			}
			if json.Unmarshal(payload, &ev) == nil && ev.Usage != nil {
				relay.Usage(canonicalUsage{
					InputTokens:      ev.Usage.InputTokens,
					OutputTokens:     ev.Usage.OutputTokens,
					CacheReadTokens:  ev.Usage.CacheReadInputTokens,
					CacheWriteTokens: ev.Usage.CacheWriteInputTokens,
					InputSeen:        true,
					OutputSeen:       true,
				})
			}
		}
	}
}

func parseBedrockEventHeaders(raw []byte) map[string]string {
	out := make(map[string]string)
	pos := 0
	for pos < len(raw) {
		nameLen := int(raw[pos])
		pos++
		if pos+nameLen >= len(raw) {
			break
		}
		name := string(raw[pos : pos+nameLen])
		pos += nameLen
		valType := raw[pos]
		pos++
		switch valType {
		case 0, 1: // bool true/false
		case 2: // byte
			pos++
		case 3: // short
			pos += 2
		case 4: // int
			pos += 4
		case 5, 8: // long, timestamp
			pos += 8
		case 6: // bytes
			if pos+2 > len(raw) {
				return out
			}
			l := int(binary.BigEndian.Uint16(raw[pos : pos+2]))
			pos += 2 + l
		case 7: // string
			if pos+2 > len(raw) {
				return out
			}
			l := int(binary.BigEndian.Uint16(raw[pos : pos+2]))
			pos += 2
			if pos+l > len(raw) {
				return out
			}
			out[name] = string(raw[pos : pos+l])
			pos += l
		case 9: // uuid
			pos += 16
		default:
			return out
		}
	}
	return out
}

// -----------------------------------------------------------------------------
// GCP Vertex AI (RS256 Service Account JWT + OAuth2 Token Cache + Gemini/Claude)
// -----------------------------------------------------------------------------

type cachedVertexToken struct {
	token     string
	expiresAt time.Time
}

// VertexTokenCache exchanges GCP Service Account JWT assertions for cached OAuth2 bearer tokens.
type VertexTokenCache struct {
	mu     sync.Mutex
	tokens map[string]cachedVertexToken
}

var defaultVertexTokenCache = NewVertexTokenCache()

// NewVertexTokenCache constructs an empty Vertex OAuth2 token cache.
func NewVertexTokenCache() *VertexTokenCache {
	return &VertexTokenCache{
		tokens: make(map[string]cachedVertexToken),
	}
}

// SignVertexServiceAccountJWT creates an RS256-signed OAuth2 JWT assertion for a GCP service account.
func SignVertexServiceAccountJWT(
	clientEmail string,
	privateKeyPEM string,
	privateKeyID string,
	tokenURI string,
	now time.Time,
) (string, error) {
	email := strings.TrimSpace(clientEmail)
	if email == "" {
		return "", errors.New("vertex: service account client_email is required")
	}
	normalizedPEM := strings.ReplaceAll(strings.TrimSpace(privateKeyPEM), `\n`, "\n")
	block, _ := pem.Decode([]byte(normalizedPEM))
	if block == nil {
		return "", errors.New("vertex: invalid PEM private_key in service account")
	}

	var rsaKey *rsa.PrivateKey
	if kAny, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		k, ok := kAny.(*rsa.PrivateKey)
		if !ok {
			return "", errors.New("vertex: private_key is not an RSA key")
		}
		rsaKey = k
	} else if k1, err1 := x509.ParsePKCS1PrivateKey(block.Bytes); err1 == nil {
		rsaKey = k1
	} else {
		return "", fmt.Errorf("vertex: failed to parse RSA private_key: %w", err)
	}

	aud := firstNonEmpty(tokenURI, defaultVertexTok)
	ts := now.UTC()
	headerObj := map[string]any{
		"alg": "RS256",
		"typ": "JWT",
	}
	if kid := strings.TrimSpace(privateKeyID); kid != "" {
		headerObj["kid"] = kid
	}
	claimsObj := map[string]any{
		"iss":   email,
		"sub":   email,
		"scope": defaultVertexScope,
		"aud":   aud,
		"iat":   ts.Unix(),
		"exp":   ts.Add(time.Hour).Unix(),
	}

	hdrJSON, _ := json.Marshal(headerObj)
	clmJSON, _ := json.Marshal(claimsObj)
	unsigned := base64.RawURLEncoding.EncodeToString(hdrJSON) + "." + base64.RawURLEncoding.EncodeToString(clmJSON)

	digest := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, rsaKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("vertex: RSA signing failed: %w", err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Resolve returns a cached or freshly exchanged Vertex OAuth2 bearer access token.
func (c *VertexTokenCache) Resolve(
	ctx context.Context,
	client *http.Client,
	allowPrivate bool,
	secret AccountSecret,
) (string, error) {
	if strings.TrimSpace(secret.GCPPrivateKey) == "" || strings.TrimSpace(secret.GCPClientEmail) == "" {
		if tok := strings.TrimSpace(secret.APIKey); tok != "" {
			return tok, nil
		}
		return "", errors.New("vertex: missing GCP service account credentials or access token")
	}

	tokenURI := firstNonEmpty(secret.GCPTokenURI, defaultVertexTok)
	sum := sha256.Sum256([]byte(tokenURI + "\n" + strings.TrimSpace(secret.GCPClientEmail) + "\n" + strings.TrimSpace(secret.GCPPrivateKey)))
	cacheKey := hex.EncodeToString(sum[:])

	now := time.Now()
	c.mu.Lock()
	if cached, ok := c.tokens[cacheKey]; ok && cached.token != "" && cached.expiresAt.After(now.Add(2*time.Minute)) {
		tok := cached.token
		c.mu.Unlock()
		return tok, nil
	}
	c.mu.Unlock()

	assertion, err := SignVertexServiceAccountJWT(secret.GCPClientEmail, secret.GCPPrivateKey, secret.GCPPrivateKeyID, tokenURI, now)
	if err != nil {
		return "", err
	}

	if err := netguard.ValidateOutboundURL(tokenURI, allowPrivate); err != nil {
		return "", fmt.Errorf("vertex token_uri rejected: %w", err)
	}
	httpClient := client
	if httpClient == nil {
		httpClient = netguard.NewSafeHTTPClient(15*time.Second, allowPrivate)
	}

	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", assertion)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("vertex oauth2 token exchange failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("vertex oauth2 token exchange HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var parsed struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || strings.TrimSpace(parsed.AccessToken) == "" {
		return "", errors.New("vertex oauth2 response missing access_token")
	}
	expSec := parsed.ExpiresIn
	if expSec <= 0 {
		expSec = 3600
	}

	c.mu.Lock()
	c.tokens[cacheKey] = cachedVertexToken{
		token:     strings.TrimSpace(parsed.AccessToken),
		expiresAt: time.Now().Add(time.Duration(expSec) * time.Second),
	}
	c.mu.Unlock()
	return strings.TrimSpace(parsed.AccessToken), nil
}

func normalizeVertexModel(model string) string {
	m := strings.TrimSpace(model)
	lower := strings.ToLower(m)
	switch {
	case strings.HasPrefix(lower, "vertex_ai/"):
		return m[len("vertex_ai/"):]
	case strings.HasPrefix(lower, "vertex/"):
		return m[len("vertex/"):]
	default:
		return m
	}
}

func isVertexClaudeModel(model string) bool {
	norm := strings.ToLower(normalizeVertexModel(model))
	return strings.HasPrefix(norm, "claude-") || strings.HasPrefix(norm, "anthropic/")
}

func resolveVertexLocation(secret AccountSecret) string {
	return firstNonEmpty(secret.GCPLocation, secret.AWSRegion, defaultVertexLoc)
}

func resolveVertexBaseURL(secret AccountSecret) string {
	if custom := strings.TrimRight(strings.TrimSpace(secret.BaseURL), "/"); custom != "" {
		return custom
	}
	loc := resolveVertexLocation(secret)
	if strings.EqualFold(loc, "global") {
		return "https://aiplatform.googleapis.com"
	}
	return fmt.Sprintf("https://%s-aiplatform.googleapis.com", loc)
}

func buildVertexRequest(
	ctx context.Context,
	pctx OutboundPersonaContext,
	upstreamModel string,
	secret AccountSecret,
	turn *CanonicalTurn,
	filteredTools []CanonicalTool,
) (*http.Request, CodecKind, error) {
	modelID := normalizeVertexModel(upstreamModel)
	if modelID == "" {
		return nil, CodecGeminiGenerate, errors.New("vertex: missing upstream model ID")
	}
	project := strings.TrimSpace(secret.ProjectID)
	if project == "" {
		if secret.IsMock() {
			project = "mock-project"
		} else {
			return nil, CodecGeminiGenerate, errors.New("vertex: projectId (project_id) is required")
		}
	}
	location := resolveVertexLocation(secret)
	baseURL := resolveVertexBaseURL(secret)

	token := strings.TrimSpace(secret.APIKey)
	if token == "" && strings.TrimSpace(secret.GCPPrivateKey) != "" {
		var err error
		token, err = defaultVertexTokenCache.Resolve(ctx, nil, netguard.AllowPrivateUpstreamsFromEnv(), secret)
		if err != nil {
			return nil, CodecGeminiGenerate, err
		}
	}

	var (
		egress  CodecKind
		fullURL string
		bodyRaw []byte
		err     error
	)

	if isVertexClaudeModel(modelID) {
		claudeModel := strings.TrimPrefix(strings.TrimPrefix(modelID, "anthropic/"), "Anthropic/")
		egress = CodecAnthropicMessages
		action := ":rawPredict"
		if turn.Stream {
			action = ":streamRawPredict"
		}
		fullURL = fmt.Sprintf(
			"%s/v1/projects/%s/locations/%s/publishers/anthropic/models/%s%s",
			baseURL, url.PathEscape(project), url.PathEscape(location), url.PathEscape(claudeModel), action,
		)
		rawAnt, bErr := encodeAnthropicRequestBody(claudeModel, turn, filteredTools, turn.Stream, true, pctx, false)
		if bErr != nil {
			return nil, egress, bErr
		}
		var obj map[string]any
		if uErr := json.Unmarshal(rawAnt, &obj); uErr != nil {
			return nil, egress, uErr
		}
		delete(obj, "model")
		obj["anthropic_version"] = "vertex-2023-10-16"
		bodyRaw, err = marshalNoEscape(obj)
	} else {
		gemModel := strings.TrimPrefix(strings.TrimPrefix(modelID, "google/"), "Google/")
		egress = CodecGeminiGenerate
		action := ":generateContent"
		if turn.Stream {
			action = ":streamGenerateContent?alt=sse"
		}
		fullURL = fmt.Sprintf(
			"%s/v1/projects/%s/locations/%s/publishers/google/models/%s%s",
			baseURL, url.PathEscape(project), url.PathEscape(location), url.PathEscape(gemModel), action,
		)
		bodyRaw, err = encodeGeminiRequestBodyForModel(gemModel, turn, filteredTools)
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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range secret.Headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}
	return req, egress, nil
}
