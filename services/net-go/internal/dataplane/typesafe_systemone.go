package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultTypeSafeBaseURL     = "https://api.typesafe.ai"
	TypeSafeSystemOnePath      = "/v1/systemone"
	TypeSafeJevLatestModel     = "jev-latest"
	MaxSystemOneResponseBytes  = 4 << 20
	maxSystemOneTokenCount     = 1 << 40
	typeSafeTestMaxPreviewByte = 2000
)

var (
	ErrSystemOneStreamingUnsupported = errors.New("typesafe system one does not support streaming")
	ErrSystemOneResponseTooLarge     = errors.New("typesafe response exceeds size limit")

	systemOneRequestFields  = []string{"model", "state", "questions", "stream"}
	systemOneQuestionFields = []string{"type", "instructions", "criteria"}
)

type systemOneEnvelope struct {
	Model     json.RawMessage `json:"model"`
	State     json.RawMessage `json:"state"`
	Questions json.RawMessage `json:"questions"`
	Stream    json.RawMessage `json:"stream"`
}

// SystemOneUsage holds decoded token usage from a TypeSafe System One response.
type SystemOneUsage struct {
	InputTokens  uint64 `json:"input_tokens"`
	OutputTokens uint64 `json:"output_tokens"`
}

// SystemOneDecodedResponse holds a validated TypeSafe System One response payload.
type SystemOneDecodedResponse struct {
	Body  []byte
	Model string
	Usage SystemOneUsage
}

// ValidateSystemOneRequest validates TypeSafe's `/v1/systemone` request wire schema (ported from
// Wei-Shaw/sub2api backend/internal/pkg/typesafe/systemone.go) and returns the model name.
func ValidateSystemOneRequest(body []byte) (string, error) {
	var envelope systemOneEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", errors.New("invalid JSON request")
	}
	if err := checkSystemOneObjectKeys(body, "request", systemOneRequestFields); err != nil {
		return "", err
	}
	model, err := sysOneRequiredString(envelope.Model, "model")
	if err != nil {
		return "", err
	}
	if model != TypeSafeJevLatestModel {
		return "", fmt.Errorf("model must be %s", TypeSafeJevLatestModel)
	}
	if err := validateSysOneStringObjectOrArray(envelope.State, "state"); err != nil {
		return "", err
	}
	questionsRaw := bytes.TrimSpace(envelope.Questions)
	var questions map[string]json.RawMessage
	if len(questionsRaw) == 0 || questionsRaw[0] != '{' || json.Unmarshal(questionsRaw, &questions) != nil || len(questions) == 0 {
		return "", errors.New("questions must be a non-empty object")
	}
	if err := checkSystemOneObjectKeys(questionsRaw, "questions", nil); err != nil {
		return "", err
	}
	if len(envelope.Stream) > 0 && string(bytes.TrimSpace(envelope.Stream)) != "null" {
		var stream bool
		if err := json.Unmarshal(envelope.Stream, &stream); err != nil {
			return "", errors.New("stream must be a boolean")
		}
		if stream {
			return "", ErrSystemOneStreamingUnsupported
		}
	}
	for id, raw := range questions {
		if err := validateSystemOneQuestion(id, raw); err != nil {
			return "", err
		}
	}
	return model, nil
}

func validateSystemOneQuestion(id string, raw json.RawMessage) error {
	raw = bytes.TrimSpace(raw)
	var question struct {
		Type         json.RawMessage `json:"type"`
		Instructions json.RawMessage `json:"instructions"`
		Criteria     json.RawMessage `json:"criteria"`
	}
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &question) != nil {
		return fmt.Errorf("question %q must be an object", id)
	}
	if err := checkSystemOneObjectKeys(raw, fmt.Sprintf("question %q", id), systemOneQuestionFields); err != nil {
		return err
	}
	typ, err := sysOneRequiredString(question.Type, "question type")
	if err != nil {
		return fmt.Errorf("question %q: %w", id, err)
	}
	if err := validateSysOneOptionalDesc(question.Instructions, "instructions"); err != nil {
		return fmt.Errorf("question %q: %w", id, err)
	}

	switch typ {
	case "noul":
		criteria := bytes.TrimSpace(question.Criteria)
		if len(criteria) == 0 || bytes.Equal(criteria, []byte("null")) {
			return nil
		}
		var descriptions map[string]json.RawMessage
		if criteria[0] != '{' || json.Unmarshal(criteria, &descriptions) != nil {
			return fmt.Errorf("question %q: noul criteria must be an object", id)
		}
		for _, outcome := range []string{"true", "false"} {
			if err := validateSysOneOptionalDesc(descriptions[outcome], "noul criteria "+outcome); err != nil {
				return fmt.Errorf("question %q: %w", id, err)
			}
		}
	case "choice":
		var criteria map[string]json.RawMessage
		if json.Unmarshal(question.Criteria, &criteria) != nil || criteria == nil {
			return fmt.Errorf("question %q: choice criteria must be an object", id)
		}
		for _, value := range criteria {
			if err := validateSysOneOptionalDesc(value, "choice criteria value"); err != nil {
				return fmt.Errorf("question %q: %w", id, err)
			}
		}
	case "score":
		var criteria []json.RawMessage
		if json.Unmarshal(question.Criteria, &criteria) != nil || len(criteria) == 0 {
			return fmt.Errorf("question %q: score criteria must contain at least one level", id)
		}
		for _, value := range criteria {
			if err := validateSysOneStringObjectOrArray(value, "score criteria value"); err != nil {
				return fmt.Errorf("question %q: %w", id, err)
			}
		}
	default:
		return fmt.Errorf("question %q: unsupported type %q", id, typ)
	}
	return nil
}

func validateSysOneOptionalDesc(raw json.RawMessage, name string) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	return validateSysOneStringObjectOrArray(raw, name)
}

func sysOneRequiredString(raw json.RawMessage, name string) (string, error) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s must be a non-empty string", name)
	}
	return value, nil
}

func validateSysOneStringObjectOrArray(raw json.RawMessage, name string) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return fmt.Errorf("%s is required", name)
	}
	switch raw[0] {
	case '{', '[':
		return nil
	case '"':
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return nil
		}
	}
	return fmt.Errorf("%s must be a string, object, or array", name)
}

func checkSystemOneObjectKeys(raw []byte, scope string, canonical []string) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fmt.Errorf("%s must be an object", scope)
	}
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errors.New("invalid JSON request")
		}
		key, _ := token.(string)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("%s contains duplicate field %q", scope, key)
		}
		seen[key] = struct{}{}
		for _, field := range canonical {
			if key != field && strings.EqualFold(key, field) {
				return fmt.Errorf("%s field %q must be written as %q", scope, key, field)
			}
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return errors.New("invalid JSON request")
		}
	}
	return nil
}

// DecodeSystemOneResponse reads and validates a System One upstream response body up to 4 MiB.
func DecodeSystemOneResponse(r io.Reader) (*SystemOneDecodedResponse, error) {
	body, err := io.ReadAll(io.LimitReader(r, MaxSystemOneResponseBytes+1))
	if err != nil {
		return nil, errors.New("typesafe invalid response")
	}
	if len(body) > MaxSystemOneResponseBytes {
		return nil, ErrSystemOneResponseTooLarge
	}
	if !json.Valid(body) {
		return nil, errors.New("typesafe invalid response")
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil || envelope == nil {
		return nil, errors.New("typesafe invalid response")
	}
	var model string
	_ = json.Unmarshal(envelope["model"], &model)
	var usage map[string]json.RawMessage
	_ = json.Unmarshal(envelope["usage"], &usage)
	return &SystemOneDecodedResponse{
		Body:  body,
		Model: model,
		Usage: SystemOneUsage{
			InputTokens:  systemOneTokenCount(usage["input_tokens"]),
			OutputTokens: systemOneTokenCount(usage["output_tokens"]),
		},
	}, nil
}

func systemOneTokenCount(raw json.RawMessage) uint64 {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return 0
	}
	if raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return 0
		}
		raw = json.RawMessage(strings.TrimSpace(text))
	}
	var number json.Number
	if json.Unmarshal(raw, &number) != nil {
		return 0
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || value <= 0 {
		return 0
	}
	if value > maxSystemOneTokenCount {
		value = maxSystemOneTokenCount
	}
	return uint64(math.Round(value))
}

// IsSystemOneRequestErrorStatus reports caller payload HTTP errors that must not fail over
// or penalize an upstream TypeSafe account.
func IsSystemOneRequestErrorStatus(status int) bool {
	switch status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return true
	default:
		return false
	}
}

func systemOneResponseContentType(raw string) string {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return "application/json"
	}
	if mediaType == "application/json" || (strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json")) {
		return strings.TrimSpace(raw)
	}
	return "application/json"
}

func executeMockSystemOneTurn(upstreamModel string, estIn uint64) *http.Response {
	model := firstNonEmpty(stripPlatformWrapperPrefix("typesafe", upstreamModel), TypeSafeJevLatestModel)
	inTok := max(uint64(12), estIn)
	outTok := uint64(8)
	headers := make(http.Header)
	return jsonHTTPResponse(http.StatusOK, headers, map[string]any{
		"model": model,
		"answers": map[string]any{
			"connectivity_check": map[string]any{
				"type": "noul",
				"noul": 0.98,
			},
		},
		"usage": map[string]any{
			"input_tokens":  inTok,
			"output_tokens": outTok,
		},
	})
}

func (c *Coordinator) probeTypeSafeAccount(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	req ProbeRequest,
	emit func(ProbeEvent),
) {
	model := firstNonEmpty(stripPlatformWrapperPrefix("typesafe", strings.TrimSpace(req.Model)), TypeSafeJevLatestModel)
	state := strings.TrimSpace(req.Prompt)
	if state == "" {
		state = "This is a connectivity test."
	}
	if r := []rune(state); len(r) > probeMaxPromptRunes {
		state = string(r[:probeMaxPromptRunes])
	}
	payload, err := json.Marshal(map[string]any{
		"model": model,
		"state": state,
		"questions": map[string]any{
			"connectivity_check": map[string]any{
				"type":         "noul",
				"instructions": "Is this text a connection test?",
			},
		},
	})
	if err != nil {
		emit(ProbeEvent{Type: "error", Code: "probe_build_failed", Message: err.Error()})
		return
	}

	turn := &CanonicalTurn{
		IngressCodec:         CodecTypeSafeSystemOne,
		PublicModel:          model,
		RawBody:              payload,
		EstimatedInputTokens: 32,
	}
	pctx := OutboundPersonaContext{
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

	startedAt := time.Now()
	emit(ProbeEvent{Type: "start", Model: model})

	if meta.ExecutionMode == "stealth_http" && c.pool != nil {
		if _, err := c.pool.ResolveDialTarget(accountID); err != nil {
			emit(ProbeEvent{Type: "error", Code: "egress_unavailable", Message: err.Error()})
			return
		}
	}

	var resp *http.Response
	if secret.IsMock() {
		resp = executeMockSystemOneTurn(model, turn.EstimatedInputTokens)
	} else {
		upReq, _, bErr := buildExtendedUpstreamRequest(ctx, TypeSafeSystemOnePath, pctx, model, secret, turn)
		if bErr != nil {
			emit(ProbeEvent{Type: "error", Code: "request_transcode_failed", Message: bErr.Error()})
			return
		}
		var dErr error
		resp, dErr = c.executeOutbound(ctx, pctx, secret, upReq, model, CodecTypeSafeSystemOne, turn)
		if dErr != nil {
			emit(ProbeEvent{Type: "error", Code: "outbound_dispatch_failed", Message: dErr.Error()})
			return
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		rawErr, _ := io.ReadAll(io.LimitReader(resp.Body, probeMaxErrorBodySize))
		_, errCode, errMsg := extractUpstreamError(rawErr, resp.Status)
		emit(ProbeEvent{
			Type:       "done",
			Status:     resp.StatusCode,
			DurationMs: max(1, time.Since(startedAt).Milliseconds()),
			Code:       firstNonEmpty(errCode, fmt.Sprintf("upstream_http_%d", resp.StatusCode)),
			Message:    errMsg,
		})
		return
	}

	decoded, decErr := DecodeSystemOneResponse(resp.Body)
	if decErr != nil {
		emit(ProbeEvent{
			Type:       "done",
			Status:     resp.StatusCode,
			DurationMs: max(1, time.Since(startedAt).Milliseconds()),
			Code:       "invalid_systemone_response",
			Message:    decErr.Error(),
		})
		return
	}
	dur := max(1, time.Since(startedAt).Milliseconds())
	preview := string(decoded.Body)
	if len(preview) > typeSafeTestMaxPreviewByte {
		preview = preview[:typeSafeTestMaxPreviewByte]
	}
	emit(ProbeEvent{Type: "delta", Text: preview})
	emit(ProbeEvent{
		Type:         "done",
		Success:      true,
		Status:       resp.StatusCode,
		DurationMs:   dur,
		TTFTMs:       dur,
		InputTokens:  decoded.Usage.InputTokens,
		OutputTokens: decoded.Usage.OutputTokens,
	})
}
