package dataplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

func startCloudTestCoreIPC(
	t *testing.T,
	internalToken string,
	directiveFn func(publicModel string) coreDispatchDirective,
) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock core: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			conn, cErr := ln.Accept()
			if cErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					frame, rErr := dpbridge.ReadFrame(c)
					if rErr != nil {
						return
					}
					payload, authErr := dpbridge.UnwrapAuthPayload(frame.Flags, frame.Payload, internalToken)
					if authErr != nil {
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: frame.StreamID,
							Type:     dpbridge.FrameStreamEnd,
							Flags:    dpbridge.FlagEndStream | dpbridge.FlagError,
							Payload:  []byte(`{"error":"unauthorized_ipc"}`),
						})
						return
					}
					switch frame.Type {
					case dpbridge.FramePing:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: frame.StreamID,
							Type:     dpbridge.FramePong,
							Flags:    dpbridge.FlagEndStream,
							Payload:  payload,
						})
					case dpbridge.FrameSyncState:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: frame.StreamID,
							Type:     dpbridge.FrameSyncAck,
							Flags:    dpbridge.FlagEndStream,
							Payload:  []byte(`{"applied":true,"revisionUnixMs":1}`),
						})
					case dpbridge.FrameReqHeaders:
						var req struct {
							Model  string   `json:"model"`
							Models []string `json:"models"`
						}
						_ = json.Unmarshal(payload, &req)
						model := req.Model
						if model == "" && len(req.Models) > 0 {
							model = req.Models[0]
						}
						dir := directiveFn(model)
						dir.Action = "dispatch"
						dir.Status = http.StatusOK
						dirBytes, _ := json.Marshal(dir)
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: frame.StreamID,
							Type:     dpbridge.FrameDispatchDirective,
							Flags:    dpbridge.FlagEndStream,
							Payload:  dirBytes,
						})
					case dpbridge.FrameSettleReport:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: frame.StreamID,
							Type:     dpbridge.FrameSettleAck,
							Flags:    dpbridge.FlagEndStream,
							Payload:  []byte(`{"ok":true}`),
						})
					}
				}
			}(conn)
		}
	}()
	return "tcp://" + ln.Addr().String()
}

func sha256HexString(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestAWSV4SignRequest(t *testing.T) {
	t.Parallel()

	body := []byte(`{"messages":[{"role":"user","content":[{"text":"hi"}]}]}`)
	req, err := http.NewRequest(
		http.MethodPost,
		"https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse?trace=on",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	fixedNow := time.Date(2026, 11, 24, 12, 30, 0, 0, time.UTC)
	if err := SignAWSV4Request(req, body, "AKIAEXAMPLE123", "secret-key-xyz", "sess-tok-abc", "us-west-2", "bedrock", fixedNow); err != nil {
		t.Fatalf("SignAWSV4Request: %v", err)
	}

	if got := req.Header.Get("X-Amz-Date"); got != "20261124T123000Z" {
		t.Fatalf("unexpected X-Amz-Date: %q", got)
	}
	expectedBodyHash := sha256HexString(string(body))
	if got := req.Header.Get("X-Amz-Content-Sha256"); got != expectedBodyHash {
		t.Fatalf("unexpected X-Amz-Content-Sha256: %q", got)
	}
	if got := req.Header.Get("X-Amz-Security-Token"); got != "sess-tok-abc" {
		t.Fatalf("unexpected X-Amz-Security-Token: %q", got)
	}
	auth := req.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123/20261124/us-west-2/bedrock/aws4_request, ") ||
		!strings.Contains(auth, "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, ") ||
		!strings.Contains(auth, "Signature=") {
		t.Fatalf("unexpected SigV4 Authorization header: %s", auth)
	}
	if canon := awsCanonicalURI(req.URL); canon != "/model/anthropic.claude-sonnet-4-5-20250929-v1%253A0/converse" {
		t.Fatalf("unexpected double-encoded canonical URI: %q", canon)
	}
}

func TestBedrockConverseUnaryAndEventStream(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "bedrock-vault-secret"
		internalToken = "bedrock-internal-token"
		clientKey     = "sk-sg-bedrock-test-key-0001"
	)

	var seenPaths []string
	var seenMu sync.Mutex

	bedrockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKIABEDROCK/") {
			http.Error(w, `{"message":"missing SigV4"}`, http.StatusForbidden)
			return
		}
		if r.Header.Get("X-Amz-Content-Sha256") == "" || r.Header.Get("X-Amz-Date") == "" {
			http.Error(w, `{"message":"missing amz headers"}`, http.StatusBadRequest)
			return
		}
		seenMu.Lock()
		seenPaths = append(seenPaths, r.RequestURI)
		seenMu.Unlock()

		var reqObj struct {
			System []struct {
				Text string `json:"text"`
			} `json:"system"`
			Messages []struct {
				Role    string `json:"role"`
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqObj); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(reqObj.Messages) == 0 || reqObj.Messages[0].Content[0].Text != "Ping Bedrock" {
			http.Error(w, `{"message":"unexpected converse body"}`, http.StatusBadRequest)
			return
		}

		if strings.HasSuffix(r.URL.Path, "/converse-stream") {
			w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
			delta1, _ := json.Marshal(map[string]any{"delta": map[string]any{"text": "Hello "}})
			delta2, _ := json.Marshal(map[string]any{"delta": map[string]any{"text": "Bedrock"}})
			// Internal "Read" tool must be stripped by Zero-Injection; caller "lookup_weather" must survive.
			leakStart, _ := json.Marshal(map[string]any{"start": map[string]any{"toolUse": map[string]any{"toolUseId": "tu_1", "name": "Read"}}})
			leakArgs, _ := json.Marshal(map[string]any{"delta": map[string]any{"toolUse": map[string]any{"input": `{"file_path":"/etc/passwd"}`}}})
			okStart, _ := json.Marshal(map[string]any{"start": map[string]any{"toolUse": map[string]any{"toolUseId": "tu_2", "name": "lookup_weather"}}})
			okArgs, _ := json.Marshal(map[string]any{"delta": map[string]any{"toolUse": map[string]any{"input": `{"city":"Tokyo"}`}}})
			stopEv, _ := json.Marshal(map[string]any{"stopReason": "tool_use"})
			metaEv, _ := json.Marshal(map[string]any{"usage": map[string]any{"inputTokens": 21, "outputTokens": 11}})

			_, _ = w.Write(encodeBedrockEventFrame("contentBlockDelta", delta1))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockDelta", delta2))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockStart", leakStart))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockDelta", leakArgs))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockStop", []byte(`{}`)))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockStart", okStart))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockDelta", okArgs))
			_, _ = w.Write(encodeBedrockEventFrame("contentBlockStop", []byte(`{}`)))
			_, _ = w.Write(encodeBedrockEventFrame("messageStop", stopEv))
			_, _ = w.Write(encodeBedrockEventFrame("metadata", metaEv))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"output":{"message":{"role":"assistant","content":[{"text":"Bedrock Converse unary ok"}]}},
			"stopReason":"end_turn",
			"usage":{"inputTokens":15,"outputTokens":6,"totalTokens":21}
		}`))
	}))
	defer bedrockUpstream.Close()

	coreAddr := startCloudTestCoreIPC(t, internalToken, func(publicModel string) coreDispatchDirective {
		return coreDispatchDirective{
			HoldID:        101,
			UserID:        "usr_bedrock",
			APIKeyID:      "key_bedrock",
			GroupID:       "grp_bedrock",
			AccountID:     "acc_bedrock",
			Provider:      "bedrock",
			ExecutionMode: "direct_api",
			AuthKind:      "api_key",
			PublicModel:   publicModel,
			UpstreamModel: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			CleanseMode:   "zero",
		}
	})

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreAddr,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})

	secretJSON, _ := json.Marshal(map[string]any{
		"access_key_id":     "AKIABEDROCK",
		"secret_access_key": "secret-bedrock",
		"region":            "us-east-1",
		"base_url":          bedrockUpstream.URL,
	})
	encHex, err := coord.vault.EncryptHex(string(secretJSON))
	if err != nil {
		t.Fatalf("EncryptHex: %v", err)
	}
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp_bedrock", Platform: "bedrock", SubscriptionType: "usage", RateMultiplier: 1.0, Enabled: true}},
		Accounts:       []SyncAccountInput{{ID: "acc_bedrock", GroupID: "grp_bedrock", Platform: "bedrock", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encHex, MaxConcurrency: 4, Status: "active"}},
		APIKeys:        []SyncApiKeyInput{{ID: "key_bedrock", UserID: "usr_bedrock", GroupID: "grp_bedrock", KeyHashHex: sha256HexString(clientKey), Enabled: true}},
		Wallets:        []SyncWalletInput{{UserID: "usr_bedrock", BalanceNanoUSD: "100000000000", HeldNanoUSD: "0"}},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	// 1. Unary turn.
	reqBody := []byte(`{"model":"anthropic.claude-sonnet-4-5-20250929-v1:0","system":"be terse","messages":[{"role":"user","content":"Ping Bedrock"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	rec := httptest.NewRecorder()
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Bedrock Converse unary ok") {
		t.Fatalf("Bedrock unary failed (%d): %s", rec.Code, rec.Body.String())
	}

	// 2. Streaming AWS EventStream binary turn + tool filtering.
	streamBody := []byte(`{"model":"bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0","stream":true,"messages":[{"role":"user","content":"Ping Bedrock"}]}`)
	sReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(streamBody))
	sReq.Header.Set("Authorization", "Bearer "+clientKey)
	sRec := httptest.NewRecorder()
	coord.HandleHTTP(sRec, sReq)
	out := sRec.Body.String()
	if sRec.Code != http.StatusOK ||
		!strings.Contains(out, "Hello ") ||
		!strings.Contains(out, "Bedrock") ||
		!strings.Contains(out, "lookup_weather") ||
		strings.Contains(out, "/etc/passwd") ||
		!strings.Contains(out, "[DONE]") {
		t.Fatalf("Bedrock EventStream failed (%d): %s", sRec.Code, out)
	}

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seenPaths) != 2 ||
		seenPaths[0] != "/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse" ||
		seenPaths[1] != "/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream" {
		t.Fatalf("unexpected Bedrock request paths: %v", seenPaths)
	}
}

func TestVertexServiceAccountJWTTokenCacheGeminiAndClaude(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "vertex-vault-secret"
		internalToken = "vertex-internal-token"
		clientKey     = "sk-sg-vertex-test-key-0001"
	)

	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(privKey)
	if err != nil {
		t.Fatalf("MarshalPKCS8PrivateKey: %v", err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Bytes}))

	// Verify standalone RS256 JWT signature.
	jwtAssertion, err := SignVertexServiceAccountJWT("sa@proj-1.iam.gserviceaccount.com", pemStr, "kid-1", "https://oauth2.googleapis.com/token", time.Now())
	if err != nil {
		t.Fatalf("SignVertexServiceAccountJWT: %v", err)
	}
	jwtParts := strings.Split(jwtAssertion, ".")
	if len(jwtParts) != 3 {
		t.Fatalf("expected 3 JWT segments, got %d", len(jwtParts))
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(jwtParts[2])
	if err != nil {
		t.Fatalf("decode JWT sig: %v", err)
	}
	digest := sha256.Sum256([]byte(jwtParts[0] + "." + jwtParts[1]))
	if err := rsa.VerifyPKCS1v15(&privKey.PublicKey, crypto.SHA256, digest[:], sigBytes); err != nil {
		t.Fatalf("JWT signature invalid: %v", err)
	}

	var tokenCalls atomic.Int32
	vertexSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			tokenCalls.Add(1)
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer") {
				http.Error(w, "bad grant", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"vertex-cached-tok-99","expires_in":3600}`))

		case "/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent":
			if r.Header.Get("Authorization") != "Bearer vertex-cached-tok-99" {
				http.Error(w, "missing vertex bearer", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"candidates":[{"content":{"role":"model","parts":[{"text":"Vertex Gemini ok"}]},"finishReason":"STOP"}],
				"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4,"totalTokenCount":16}
			}`))

		case "/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict":
			if r.Header.Get("Authorization") != "Bearer vertex-cached-tok-99" {
				http.Error(w, "missing vertex bearer", http.StatusUnauthorized)
				return
			}
			var bodyObj map[string]any
			if err := json.NewDecoder(r.Body).Decode(&bodyObj); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if _, hasModel := bodyObj["model"]; hasModel {
				http.Error(w, "vertex Claude rawPredict must omit model from JSON body", http.StatusBadRequest)
				return
			}
			if bodyObj["anthropic_version"] != "vertex-2023-10-16" {
				http.Error(w, "missing anthropic_version=vertex-2023-10-16", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"id":"msg_vertex_claude_1",
				"type":"message",
				"role":"assistant",
				"content":[{"type":"text","text":"Vertex Claude rawPredict ok"}],
				"stop_reason":"end_turn",
				"usage":{"input_tokens":14,"output_tokens":7}
			}`))

		default:
			http.NotFound(w, r)
		}
	}))
	defer vertexSrv.Close()

	coreAddr := startCloudTestCoreIPC(t, internalToken, func(publicModel string) coreDispatchDirective {
		up := strings.TrimPrefix(publicModel, "vertex/")
		return coreDispatchDirective{
			HoldID:        202,
			UserID:        "usr_vertex",
			APIKeyID:      "key_vertex",
			GroupID:       "grp_vertex",
			AccountID:     "acc_vertex",
			Provider:      "vertex",
			ExecutionMode: "direct_api",
			AuthKind:      "api_key",
			PublicModel:   publicModel,
			UpstreamModel: up,
			CleanseMode:   "zero",
		}
	})

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreAddr,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})

	saJSON, _ := json.Marshal(map[string]any{
		"type":           "service_account",
		"project_id":     "proj-1",
		"private_key_id": "kid-1",
		"private_key":    pemStr,
		"client_email":   "sa@proj-1.iam.gserviceaccount.com",
		"token_uri":      vertexSrv.URL + "/oauth/token",
		"location":       "us-central1",
		"base_url":       vertexSrv.URL,
	})
	encHex, err := coord.vault.EncryptHex(string(saJSON))
	if err != nil {
		t.Fatalf("EncryptHex: %v", err)
	}
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp_vertex", Platform: "vertex", SubscriptionType: "usage", RateMultiplier: 1.0, Enabled: true}},
		Accounts:       []SyncAccountInput{{ID: "acc_vertex", GroupID: "grp_vertex", Platform: "vertex", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encHex, MaxConcurrency: 4, Status: "active"}},
		APIKeys:        []SyncApiKeyInput{{ID: "key_vertex", UserID: "usr_vertex", GroupID: "grp_vertex", KeyHashHex: sha256HexString(clientKey), Enabled: true}},
		Wallets:        []SyncWalletInput{{UserID: "usr_vertex", BalanceNanoUSD: "100000000000", HeldNanoUSD: "0"}},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	// Turn 1: Vertex Gemini.
	r1 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader([]byte(`{"model":"vertex/gemini-2.5-flash","messages":[{"role":"user","content":"Hi Gemini"}]}`)))
	r1.Header.Set("Authorization", "Bearer "+clientKey)
	w1 := httptest.NewRecorder()
	coord.HandleHTTP(w1, r1)
	if w1.Code != http.StatusOK || !strings.Contains(w1.Body.String(), "Vertex Gemini ok") {
		t.Fatalf("Vertex Gemini turn failed (%d): %s", w1.Code, w1.Body.String())
	}

	// Turn 2: Vertex Claude rawPredict (must reuse cached OAuth token!).
	r2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader([]byte(`{"model":"vertex/claude-sonnet-4-5@20250929","messages":[{"role":"user","content":"Hi Claude"}]}`)))
	r2.Header.Set("Authorization", "Bearer "+clientKey)
	w2 := httptest.NewRecorder()
	coord.HandleHTTP(w2, r2)
	if w2.Code != http.StatusOK || !strings.Contains(w2.Body.String(), "Vertex Claude rawPredict ok") {
		t.Fatalf("Vertex Claude turn failed (%d): %s", w2.Code, w2.Body.String())
	}

	if got := tokenCalls.Load(); got != 1 {
		t.Fatalf("expected Vertex OAuth2 token endpoint called exactly once via cache, got %d", got)
	}
}

func TestExtendedOpenAIEndpointsViaDataPlane(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "ext-vault-secret"
		internalToken = "ext-internal-token"
		clientKey     = "sk-sg-ext-test-key-0001"
	)

	var seenMu sync.Mutex
	seenPaths := map[string]bool{}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-upstream-ext" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		seenMu.Lock()
		seenPaths[r.URL.Path] = true
		seenMu.Unlock()

		switch r.URL.Path {
		case "/v1/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"cmpl_1","object":"text_completion","model":"gpt-3.5-turbo-instruct","choices":[{"text":"live cmpl ok","index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`))
		case "/v1/audio/speech":
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("MP3BYTES"))
		case "/v1/audio/transcriptions":
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				http.Error(w, "expected multipart", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"text":"transcribed audio"}`))
		case "/v1/audio/translations":
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				http.Error(w, "expected multipart", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"text":"translated audio"}`))
		case "/v1/rerank":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"rr_1","results":[{"index":0,"relevance_score":0.91}],"usage":{"total_tokens":9}}`))
		case "/v1/moderations":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"modr_1","model":"omni-moderation-latest","results":[{"flagged":false}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	coreAddr := startCloudTestCoreIPC(t, internalToken, func(publicModel string) coreDispatchDirective {
		m := publicModel
		if m == "" {
			m = "gpt-4o"
		}
		return coreDispatchDirective{
			HoldID:        303,
			UserID:        "usr_ext",
			APIKeyID:      "key_ext",
			GroupID:       "grp_ext",
			AccountID:     "acc_ext",
			Provider:      "openai",
			ExecutionMode: "direct_api",
			AuthKind:      "api_key",
			PublicModel:   m,
			UpstreamModel: m,
			CleanseMode:   "zero",
		}
	})

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreAddr,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})

	secRaw, _ := json.Marshal(map[string]any{"api_key": "sk-upstream-ext", "base_url": upstream.URL})
	encHex, _ := coord.vault.EncryptHex(string(secRaw))
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp_ext", Platform: "openai", SubscriptionType: "usage", RateMultiplier: 1.0, Enabled: true}},
		Accounts:       []SyncAccountInput{{ID: "acc_ext", GroupID: "grp_ext", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encHex, MaxConcurrency: 4, Status: "active"}},
		APIKeys:        []SyncApiKeyInput{{ID: "key_ext", UserID: "usr_ext", GroupID: "grp_ext", KeyHashHex: sha256HexString(clientKey), Enabled: true}},
		Wallets:        []SyncWalletInput{{UserID: "usr_ext", BalanceNanoUSD: "100000000000", HeldNanoUSD: "0"}},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	// 1. /v1/completions
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/completions", strings.NewReader(`{"model":"gpt-3.5-turbo-instruct","prompt":"hi"}`))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "live cmpl ok") {
		t.Fatalf("/v1/completions failed (%d): %s", rec.Code, rec.Body.String())
	}

	// 2. /v1/audio/speech
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"model":"tts-1","input":"hello"}`))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "MP3BYTES" || !strings.Contains(rec.Header().Get("Content-Type"), "audio/mpeg") {
		t.Fatalf("/v1/audio/speech failed (%d, ct=%q): %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}

	// 3 & 4. /v1/audio/transcriptions and /v1/audio/translations (multipart/form-data)
	for _, ep := range []string{"/v1/audio/transcriptions", "/v1/audio/translations"} {
		var mp bytes.Buffer
		mw := multipart.NewWriter(&mp)
		_ = mw.WriteField("model", "whisper-1")
		fw, _ := mw.CreateFormFile("file", "clip.wav")
		_, _ = fw.Write([]byte("RIFF0000"))
		_ = mw.Close()

		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodPost, ep, bytes.NewReader(mp.Bytes()))
		req.Header.Set("Authorization", "Bearer "+clientKey)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		coord.HandleHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "audio") {
			t.Fatalf("%s failed (%d): %s", ep, rec.Code, rec.Body.String())
		}
	}

	// 5. /v1/rerank
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/rerank", strings.NewReader(`{"model":"rerank-1","query":"slipgate","documents":["doc1","doc2"]}`))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "0.91") {
		t.Fatalf("/v1/rerank failed (%d): %s", rec.Code, rec.Body.String())
	}

	// 6. /v1/moderations
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/moderations", strings.NewReader(`{"input":"benign sentence"}`))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"flagged":false`) {
		t.Fatalf("/v1/moderations failed (%d): %s", rec.Code, rec.Body.String())
	}

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seenPaths) != 6 {
		t.Fatalf("expected all 6 extended endpoints dispatched upstream, got %v", seenPaths)
	}
}

func startMockAuthGuestd(t *testing.T, requiredToken string, reportedMachineID *atomic.Value) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock guestd: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			conn, cErr := ln.Accept()
			if cErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					f, rErr := dpbridge.ReadFrame(c)
					if rErr != nil {
						return
					}
					inner, authErr := dpbridge.UnwrapAuthPayload(f.Flags, f.Payload, requiredToken)
					if authErr != nil {
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: f.StreamID,
							Type:     dpbridge.FrameStreamEnd,
							Flags:    dpbridge.FlagEndStream | dpbridge.FlagError,
							Payload:  []byte(`{"error":"unauthorized_ipc"}`),
						})
						return
					}
					mid, _ := reportedMachineID.Load().(string)
					dirBytes, _ := json.Marshal(vmslot.GuestDirective{
						Daemon:          "slipgate-guestd",
						Version:         "0.2.0",
						SlotID:          "slot_vm_live",
						GuestMachineID:  mid,
						RuntimeProfile:  "claude_code",
						NativeHandoffV1: true,
						MaxSubagents:    8,
						CleanseMode:     "zero",
						TelemetryMode:   "isolated",
					})
					switch f.Type {
					case dpbridge.FramePing:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: f.StreamID,
							Type:     dpbridge.FramePong,
							Flags:    dpbridge.FlagEndStream,
							Payload:  inner,
						})
					case dpbridge.FrameExitHealth:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: f.StreamID,
							Type:     dpbridge.FrameExitHealth,
							Flags:    dpbridge.FlagEndStream,
							Payload:  dirBytes,
						})
					case dpbridge.FrameReqHeaders:
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: f.StreamID,
							Type:     dpbridge.FrameDispatchDirective,
							Flags:    dpbridge.FlagEndStream | dpbridge.FlagPassthrough,
							Payload:  dirBytes,
						})
					}
				}
			}(conn)
		}
	}()
	return "tcp://" + ln.Addr().String()
}

func TestVMSlotLiveGuestdHandoffAndMachineIDCheck(t *testing.T) {
	t.Parallel()

	const (
		guestToken    = "vm-slot-guest-secret-01"
		machineID     = "0123456789abcdef0123456789abcdef"
		wrongID       = "fedcba9876543210fedcba9876543210"
		vaultSecret   = "vm-handoff-vault-secret"
		internalToken = "vm-handoff-internal-tok"
		clientKey     = "sk-sg-vm-handoff-key-0001"
	)

	var reportedID atomic.Value
	reportedID.Store(machineID)
	guestEndpoint := startMockAuthGuestd(t, guestToken, &reportedID)

	// 1. Direct vmslot IPC checks: ExitHealth + Handoff + auth failure + mismatch failure.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dir, err := vmslot.VerifyGuestExitHealth(ctx, guestEndpoint, guestToken, machineID)
	if err != nil || dir.GuestMachineID != machineID || !dir.NativeHandoffV1 {
		t.Fatalf("VerifyGuestExitHealth failed: dir=%+v err=%v", dir, err)
	}
	if _, err := vmslot.VerifyGuestExitHealth(ctx, guestEndpoint, "bad-token", machineID); err == nil {
		t.Fatalf("expected unauthorized error with bad guest token")
	}

	reportedID.Store(wrongID)
	if _, err := vmslot.VerifyGuestExitHealth(ctx, guestEndpoint, guestToken, machineID); !errors.Is(err, vmslot.ErrGuestMachineIDMismatch) {
		t.Fatalf("expected ErrGuestMachineIDMismatch, got %v", err)
	}

	// 2. End-to-end Coordinator vm_slot turn checks.
	reportedID.Store(machineID)
	coreAddr := startCloudTestCoreIPC(t, internalToken, func(publicModel string) coreDispatchDirective {
		return coreDispatchDirective{
			HoldID:        404,
			UserID:        "usr_vm",
			APIKeyID:      "key_vm",
			GroupID:       "grp_vm",
			AccountID:     "acc_vm",
			Provider:      "anthropic",
			ExecutionMode: "vm_slot",
			AuthKind:      "vm_cli_seed",
			PublicModel:   publicModel,
			UpstreamModel: "claude-sonnet-4-5",
			CleanseMode:   "zero",
		}
	})

	vmMgr := vmslot.NewManager(nil)
	vmMgr.UpsertRestoredSlot(vmslot.Slot{
		ID:             "slot_vm_live",
		ClusterNodeID:  "node-local",
		AccountID:      "acc_vm",
		ClashNodeID:    "clash-n1",
		ExitIP:         "198.51.100.1",
		RuntimeProfile: vmslot.RuntimeClaudeCode,
		State:          vmslot.StateReady,
		GuestUDSPath:   guestEndpoint,
		MaxSubagents:   4,
		CleanseMode:    "zero",
		Persona: vmslot.HardwarePersona{
			GuestMachineID: machineID,
		},
	})

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreAddr,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		VMSlots:               vmMgr,
		GuestToken:            guestToken,
		AllowPrivateUpstreams: true,
	})

	encHex, _ := coord.vault.EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp_vm", Platform: "anthropic", SubscriptionType: "subscription", RateMultiplier: 1.0, Enabled: true}},
		Accounts:       []SyncAccountInput{{ID: "acc_vm", GroupID: "grp_vm", Platform: "anthropic", ExecutionMode: "vm_slot", AuthKind: "vm_cli_seed", CredentialsEncHex: encHex, MaxConcurrency: 4, Status: "active"}},
		APIKeys:        []SyncApiKeyInput{{ID: "key_vm", UserID: "usr_vm", GroupID: "grp_vm", KeyHashHex: sha256HexString(clientKey), Enabled: true}},
		Wallets:        []SyncWalletInput{{UserID: "usr_vm", BalanceNanoUSD: "100000000000", HeldNanoUSD: "0"}},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	// Happy live handoff sets X-Slipgate-Guest-Handoff: live.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("X-Slipgate-Guest-Handoff") != "live" {
		t.Fatalf("expected HTTP 200 with X-Slipgate-Guest-Handoff=live, got %d (%v): %s", rec.Code, rec.Header(), rec.Body.String())
	}

	// Machine ID mismatch fails closed with 503 vm_guest_identity_mismatch.
	reportedID.Store(wrongID)
	recMismatch := httptest.NewRecorder()
	reqMismatch := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}`))
	reqMismatch.Header.Set("Authorization", "Bearer "+clientKey)
	coord.HandleHTTP(recMismatch, reqMismatch)
	if recMismatch.Code != http.StatusServiceUnavailable || !strings.Contains(recMismatch.Body.String(), "vm_guest_identity_mismatch") {
		t.Fatalf("expected 503 vm_guest_identity_mismatch, got %d: %s", recMismatch.Code, recMismatch.Body.String())
	}
}
