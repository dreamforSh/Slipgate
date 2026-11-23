package dataplane

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	maxStoredResponses = 4096
	responseStateTTL   = 2 * time.Hour
)

type storedResponseEntry struct {
	id           string
	ownerKeyID   string
	expiresAt    time.Time
	responseJSON map[string]any
	inputItems   []map[string]any
	history      []CanonicalMessage
}

type responseStateStore struct {
	mu    sync.Mutex
	items map[string]*storedResponseEntry
	order []string
}

func (s *responseStateStore) sweepLocked(now time.Time) {
	if len(s.items) == 0 {
		return
	}
	kept := s.order[:0]
	for _, id := range s.order {
		ent, ok := s.items[id]
		if !ok {
			continue
		}
		if now.After(ent.expiresAt) {
			delete(s.items, id)
			continue
		}
		kept = append(kept, id)
	}
	s.order = kept
	for len(s.items) >= maxStoredResponses && len(s.order) > 0 {
		evictID := s.order[0]
		s.order = s.order[1:]
		delete(s.items, evictID)
	}
}

func (s *responseStateStore) hydratePreviousTurn(apiKeyID string, turn *CanonicalTurn) {
	if s == nil || turn == nil || apiKeyID == "" {
		return
	}
	prevID := strings.TrimSpace(turn.PreviousResponseID)
	if prevID == "" {
		return
	}
	now := time.Now()
	s.mu.Lock()
	ent, ok := s.items[prevID]
	var prior []CanonicalMessage
	if ok && ent.ownerKeyID == apiKeyID && now.Before(ent.expiresAt) {
		prior = cloneCanonicalMessages(ent.history)
	}
	s.mu.Unlock()
	if len(prior) == 0 {
		return
	}
	combined := make([]CanonicalMessage, 0, len(prior)+len(turn.Messages))
	combined = append(combined, prior...)
	combined = append(combined, turn.Messages...)
	turn.Messages = combined
	// Clear raw passthrough body when we hydrated cross-provider history so canonical encoding includes prior turns.
	turn.RawBody = nil
}

func (s *responseStateStore) captureTurn(apiKeyID, publicModel string, turn *CanonicalTurn, captured []byte) {
	if s == nil || apiKeyID == "" || turn == nil || len(captured) == 0 {
		return
	}
	respObj, asstMsg, ok := parseCapturedResponsesOutput(captured, publicModel)
	if !ok {
		return
	}
	id, _ := respObj["id"].(string)
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}

	inputItems := buildStoredInputItems(turn.Messages)
	history := cloneCanonicalMessages(turn.Messages)
	if asstMsg.Content != "" || len(asstMsg.ToolCalls) > 0 {
		history = append(history, asstMsg)
	}

	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items == nil {
		s.items = make(map[string]*storedResponseEntry)
	}
	s.sweepLocked(now)
	if _, exists := s.items[id]; !exists {
		s.order = append(s.order, id)
	}
	s.items[id] = &storedResponseEntry{
		id:           id,
		ownerKeyID:   apiKeyID,
		expiresAt:    now.Add(responseStateTTL),
		responseJSON: respObj,
		inputItems:   inputItems,
		history:      history,
	}
}

func (s *responseStateStore) get(apiKeyID, respID string) (map[string]any, bool) {
	if s == nil || apiKeyID == "" || respID == "" {
		return nil, false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ent, ok := s.items[respID]
	if !ok || ent.ownerKeyID != apiKeyID || now.After(ent.expiresAt) {
		return nil, false
	}
	return ent.responseJSON, true
}

func (s *responseStateStore) delete(apiKeyID, respID string) bool {
	if s == nil || apiKeyID == "" || respID == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ent, ok := s.items[respID]
	if !ok || ent.ownerKeyID != apiKeyID || now.After(ent.expiresAt) {
		return false
	}
	delete(s.items, respID)
	return true
}

func (s *responseStateStore) inputItems(apiKeyID, respID string) ([]map[string]any, bool) {
	if s == nil || apiKeyID == "" || respID == "" {
		return nil, false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ent, ok := s.items[respID]
	if !ok || ent.ownerKeyID != apiKeyID || now.After(ent.expiresAt) {
		return nil, false
	}
	return ent.inputItems, true
}

func buildStoredInputItems(msgs []CanonicalMessage) []map[string]any {
	items := make([]map[string]any, 0, len(msgs))
	for i, m := range msgs {
		switch m.Role {
		case "tool":
			items = append(items, map[string]any{
				"id":      firstNonEmpty(m.ToolCallID, "fco_1"),
				"type":    "function_call_output",
				"call_id": firstNonEmpty(m.ToolCallID, "call_1"),
				"output":  m.Content,
			})
		case "assistant":
			if m.Content != "" {
				items = append(items, map[string]any{
					"id":      "msg_in_" + strconvItoa(i+1),
					"type":    "message",
					"role":    "assistant",
					"content": []map[string]any{{"type": "output_text", "text": m.Content}},
				})
			}
			for _, tc := range m.ToolCalls {
				items = append(items, map[string]any{
					"id":        "fc_" + firstNonEmpty(tc.ID, "1"),
					"type":      "function_call",
					"call_id":   firstNonEmpty(tc.ID, "call_1"),
					"name":      tc.Name,
					"arguments": defaultJSONObject(tc.Arguments),
				})
			}
		default:
			items = append(items, map[string]any{
				"id":      "msg_in_" + strconvItoa(i+1),
				"type":    "message",
				"role":    "user",
				"content": []map[string]any{{"type": "input_text", "text": m.Content}},
			})
		}
	}
	return items
}

func strconvItoa(n int) string {
	var buf [20]byte
	i := len(buf)
	v := n
	if v <= 0 {
		return "0"
	}
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

func parseCapturedResponsesOutput(raw []byte, publicModel string) (map[string]any, CanonicalMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, CanonicalMessage{}, false
	}
	if trimmed[0] == '{' {
		var obj map[string]any
		if json.Unmarshal(trimmed, &obj) != nil {
			return nil, CanonicalMessage{}, false
		}
		if _, hasID := obj["id"].(string); !hasID {
			return nil, CanonicalMessage{}, false
		}
		res, _ := parseUnaryUpstream(CodecOpenAIResponses, trimmed)
		return obj, CanonicalMessage{
			Role:      "assistant",
			Content:   res.Text,
			ToolCalls: res.ToolCalls,
		}, true
	}

	// SSE stream: inspect `response.completed` event.
	scanner := bufio.NewScanner(bytes.NewReader(trimmed))
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var completed map[string]any
	var textBuf strings.Builder
	var calls []CanonicalToolCall
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var ev struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Item     json.RawMessage `json:"item"`
			Response json.RawMessage `json:"response"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			textBuf.WriteString(ev.Delta)
		case "response.output_item.done":
			var it struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}
			if json.Unmarshal(ev.Item, &it) == nil && it.Type == "function_call" && it.Name != "" {
				calls = append(calls, CanonicalToolCall{
					ID:        it.CallID,
					Name:      it.Name,
					Arguments: defaultJSONObject(it.Arguments),
				})
			}
		case "response.completed":
			_ = json.Unmarshal(ev.Response, &completed)
		}
	}
	if completed == nil {
		return nil, CanonicalMessage{}, false
	}
	if _, ok := completed["model"]; !ok && publicModel != "" {
		completed["model"] = publicModel
	}
	if _, ok := completed["output_text"]; !ok && textBuf.Len() > 0 {
		completed["output_text"] = textBuf.String()
	}
	return completed, CanonicalMessage{
		Role:      "assistant",
		Content:   textBuf.String(),
		ToolCalls: calls,
	}, true
}

func cloneCanonicalMessages(in []CanonicalMessage) []CanonicalMessage {
	if len(in) == 0 {
		return nil
	}
	out := make([]CanonicalMessage, len(in))
	for i, m := range in {
		cp := m
		if len(m.Parts) > 0 {
			cp.Parts = append([]CanonicalPart(nil), m.Parts...)
		}
		if len(m.Thinking) > 0 {
			cp.Thinking = append([]CanonicalThinking(nil), m.Thinking...)
		}
		if len(m.ToolCalls) > 0 {
			cp.ToolCalls = append([]CanonicalToolCall(nil), m.ToolCalls...)
		}
		out[i] = cp
	}
	return out
}

// responseCaptureWriter tees response body bytes up to maxBytes while forwarding headers/body to w.
type responseCaptureWriter struct {
	http.ResponseWriter
	buf      bytes.Buffer
	maxBytes int
	status   int
}

func newResponseCaptureWriter(w http.ResponseWriter, maxBytes int) *responseCaptureWriter {
	return &responseCaptureWriter{ResponseWriter: w, maxBytes: maxBytes}
}

func (rw *responseCaptureWriter) WriteHeader(code int) {
	if rw.status == 0 {
		rw.status = code
	}
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseCaptureWriter) Write(p []byte) (int, error) {
	if rw.status == 0 {
		rw.status = http.StatusOK
	}
	if rw.status >= 200 && rw.status < 300 && rw.buf.Len() < rw.maxBytes {
		rem := rw.maxBytes - rw.buf.Len()
		rw.buf.Write(p[:min(len(p), rem)])
	}
	return rw.ResponseWriter.Write(p)
}

func (rw *responseCaptureWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
