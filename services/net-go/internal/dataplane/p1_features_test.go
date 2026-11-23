package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
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
)

func TestOAuthRefreshProactiveAndReactive401(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "p1-oauth-vault-secret"
		internalToken = "p1-oauth-internal-token"
	)

	var (
		tokenCalls     atomic.Int32
		persistedCount atomic.Int32
		persistedBody  string
		bffMu          sync.Mutex
	)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			n := tokenCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			if n == 1 {
				_, _ = w.Write([]byte(`{"access_token":"sk-ant-oat01-proactive","refresh_token":"rt-2","expires_in":3600}`))
			} else {
				_, _ = w.Write([]byte(`{"access_token":"sk-ant-oat01-reactive","refresh_token":"rt-3","expires_in":3600}`))
			}
		case "/v1/chat/completions", "/v1/responses":
			auth := r.Header.Get("Authorization")
			if auth != "Bearer sk-ant-oat01-reactive" {
				http.Error(w, `{"error":{"message":"expired token"}}`, http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/v1/responses" {
				_, _ = w.Write([]byte(`{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"renewed ok"}]}],"usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"chatcmpl_1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"renewed ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Slipgate-Internal-Token") != internalToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/credentials") {
			var body struct {
				CredentialSecret string `json:"credentialSecret"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			bffMu.Lock()
			persistedBody = body.CredentialSecret
			bffMu.Unlock()
			persistedCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()

	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core: %v", err)
	}
	defer coreLn.Close()

	go func() {
		for {
			conn, err := coreLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				switch f.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
				case dpbridge.FrameReqHeaders:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"engine":"slipgate-core","action":"dispatch","status":200,"holdId":11,"userId":"u1","apiKeyId":"k1","groupId":"g1","accountId":"acc_oauth","provider":"openai","executionMode":"direct_api","authKind":"oauth","publicModel":"gpt-4o","upstreamModel":"gpt-4o"}`),
					})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"100","balanceAfterNanoUsd":"999900"}`)})
				}
			}(conn)
		}
	}()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreLn.Addr().String(),
		BFFOrigin:             bff.URL,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})

	expiringSoonMs := time.Now().Add(2 * time.Minute).UnixMilli()
	rawCred, _ := json.Marshal(map[string]any{
		"access_token":       "stale-initial",
		"refresh_token":      "rt-1",
		"base_url":           upstream.URL + "/v1",
		"expires_at_unix_ms": expiringSoonMs,
		"headers": map[string]string{
			"x-oauth-token-url": upstream.URL + "/oauth/token",
		},
	})
	encCred, _ := coord.Vault().EncryptHex(string(rawCred))
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_oauth", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "oauth", CredentialsEncHex: encCred, MaxConcurrency: 4, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}

	// 1. Proactive sweep refreshes expiring token and persists to BFF.
	coord.ProactiveRefreshSweep(context.Background())
	secAfterProactive, ok := coord.Vault().Get("acc_oauth")
	if !ok || secAfterProactive.APIKey != "sk-ant-oat01-proactive" || secAfterProactive.RefreshToken != "rt-2" {
		t.Fatalf("expected proactive refresh to update vault secret, got %+v", secAfterProactive)
	}

	// 2. Live request hits 401 with proactive token -> reactive force refresh -> transparent retry -> 200 OK.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`))
	req.Header.Set("Authorization", "Bearer sk-sg-0123456789abcdef0123456789abcdef01234567")
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "renewed ok") {
		t.Fatalf("expected reactive 401 OAuth refresh retry to succeed with 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for persistedCount.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	bffMu.Lock()
	gotPersisted := persistedBody
	bffMu.Unlock()
	if persistedCount.Load() < 2 || !strings.Contains(gotPersisted, "sk-ant-oat01-reactive") {
		t.Fatalf("expected rotated OAuth secret persisted to BFF, count=%d body=%s", persistedCount.Load(), gotPersisted)
	}
}

func TestPreFirstByteFailoverCooldownAndStickySession(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "p1-failover-vault-secret"
		internalToken = "p1-failover-internal-token"
	)

	var (
		cooldownPosted atomic.Int32
		evalMu         sync.Mutex
		evalPayloads   []map[string]any
	)

	upstream429 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "45")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limit exceeded"}}`))
	}))
	defer upstream429.Close()

	upstreamOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_ok","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"failover rescued"},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":3,"total_tokens":9}}`))
	}))
	defer upstreamOK.Close()

	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/acc_429/cooldown") {
			cooldownPosted.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bff.Close()

	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core: %v", err)
	}
	defer coreLn.Close()

	go func() {
		for {
			conn, err := coreLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				rawPayload, authErr := dpbridge.UnwrapAuthPayload(f.Flags, f.Payload, internalToken)
				if authErr != nil {
					return
				}
				switch f.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
				case dpbridge.FrameReqHeaders:
					var ev map[string]any
					_ = json.Unmarshal(rawPayload, &ev)
					evalMu.Lock()
					evalPayloads = append(evalPayloads, ev)
					attempt := len(evalPayloads)
					evalMu.Unlock()

					accID := "acc_429"
					if attempt >= 2 {
						accID = "acc_ok"
					}
					resp := `{"engine":"slipgate-core","action":"dispatch","status":200,"holdId":77,"userId":"u1","apiKeyId":"k1","groupId":"g1","accountId":"` + accID + `","provider":"openai","executionMode":"direct_api","authKind":"api_key","publicModel":"gpt-4o","upstreamModel":"gpt-4o"}`
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(resp),
					})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"100","balanceAfterNanoUsd":"999900"}`)})
				}
			}(conn)
		}
	}()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreLn.Addr().String(),
		BFFOrigin:             bff.URL,
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})
	enc429, _ := coord.Vault().EncryptHex(upstream429.URL + "/v1|sk-bad")
	encOK, _ := coord.Vault().EncryptHex(upstreamOK.URL + "/v1|sk-good")
	_, _ = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_429", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc429, MaxConcurrency: 4, Status: "active"},
			{ID: "acc_ok", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encOK, MaxConcurrency: 4, Status: "active"},
		},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","prompt_cache_key":"sess-abc","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer sk-sg-0123456789abcdef0123456789abcdef01234567")
	coord.HandleHTTP(rec, req)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "failover rescued") {
		t.Fatalf("expected failover to rescue 429 pre-first-byte with 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	evalMu.Lock()
	defer evalMu.Unlock()
	if len(evalPayloads) != 2 {
		t.Fatalf("expected 2 Core eval calls (initial + failover rebind), got %d", len(evalPayloads))
	}
	if sk, _ := evalPayloads[0]["sessionKey"].(string); sk == "" {
		t.Fatalf("expected non-empty sticky sessionKey in Core eval request, got %+v", evalPayloads[0])
	}
	if rebindHold, _ := evalPayloads[1]["rebindHoldId"].(float64); int(rebindHold) != 77 {
		t.Fatalf("expected rebindHoldId=77 on failover attempt, got %+v", evalPayloads[1])
	}
	if cdAcc, _ := evalPayloads[1]["rebindCooldownAccountId"].(string); cdAcc != "acc_429" {
		t.Fatalf("expected rebindCooldownAccountId=acc_429, got %+v", evalPayloads[1])
	}
	if cdMs, _ := evalPayloads[1]["rebindCooldownMs"].(float64); int64(cdMs) != 45_000 {
		t.Fatalf("expected Retry-After 45s -> rebindCooldownMs=45000, got %v", evalPayloads[1]["rebindCooldownMs"])
	}

	deadline := time.Now().Add(2 * time.Second)
	for cooldownPosted.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if cooldownPosted.Load() == 0 {
		t.Fatalf("expected BFF cooldown persistence callback to fire for acc_429")
	}
}

func TestMultimodalEndpointsStatefulResponsesAndModelDiscovery(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "p1-mm-vault-secret"
		internalToken = "p1-mm-internal-token"
		keyA          = "sk-sg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		keyB          = "sk-sg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	)

	modelUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-5-discovered-preview"},{"id":"text-embedding-3-large"}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer modelUpstream.Close()

	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen core: %v", err)
	}
	defer coreLn.Close()

	go func() {
		for {
			conn, err := coreLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				rawPayload, authErr := dpbridge.UnwrapAuthPayload(f.Flags, f.Payload, internalToken)
				if authErr != nil {
					return
				}
				switch f.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)})
				case dpbridge.FrameReqHeaders:
					var req map[string]any
					_ = json.Unmarshal(rawPayload, &req)
					path, _ := req["path"].(string)
					rawKey, _ := req["apiKey"].(string)
					if path == "/v1beta/models" {
						_ = dpbridge.WriteFrame(c, dpbridge.Frame{
							StreamID: f.StreamID,
							Type:     dpbridge.FrameDispatchDirective,
							Flags:    dpbridge.FlagEndStream,
							Payload:  []byte(`{"engine":"slipgate-core","action":"models","status":200,"models":["gemini-2.5-pro"]}`),
						})
						return
					}
					apiKeyID := "key_a"
					if rawKey == keyB {
						apiKeyID = "key_b"
					}
					model, _ := req["model"].(string)
					if model == "" {
						model = "gpt-4o"
					}
					resp := `{"engine":"slipgate-core","action":"dispatch","status":200,"holdId":5,"userId":"u1","apiKeyId":"` + apiKeyID + `","groupId":"g1","accountId":"acc_mock","provider":"openai","executionMode":"direct_api","authKind":"api_key","publicModel":"` + model + `","upstreamModel":"` + model + `"}`
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(resp),
					})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{StreamID: f.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"100","balanceAfterNanoUsd":"999900"}`)})
				}
			}(conn)
		}
	}()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreLn.Addr().String(),
		InternalToken:         internalToken,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})
	encMock, _ := coord.Vault().EncryptHex("mock://echo")
	encDisc, _ := coord.Vault().EncryptHex(modelUpstream.URL + "/v1|sk-disc")
	_, _ = coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{
			{ID: "acc_mock", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encMock, MaxConcurrency: 8, Status: "active"},
			{ID: "acc_disc", GroupID: "g1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encDisc, MaxConcurrency: 4, Status: "active"},
		},
	})

	// 1. Embeddings
	embRec := httptest.NewRecorder()
	embReq := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"text-embedding-3-small","input":["hello","world"]}`))
	embReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(embRec, embReq)
	if embRec.Code != http.StatusOK || !strings.Contains(embRec.Body.String(), `"embedding"`) {
		t.Fatalf("expected 200 OK embeddings response, got %d: %s", embRec.Code, embRec.Body.String())
	}

	// 2. Images generation + multipart Images edits
	imgRec := httptest.NewRecorder()
	imgReq := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"gpt-image-1","prompt":"sunset","n":2}`))
	imgReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(imgRec, imgReq)
	if imgRec.Code != http.StatusOK || !strings.Contains(imgRec.Body.String(), `"b64_json"`) {
		t.Fatalf("expected 200 OK image generation response, got %d: %s", imgRec.Code, imgRec.Body.String())
	}

	var mpBuf bytes.Buffer
	mpWriter := multipart.NewWriter(&mpBuf)
	_ = mpWriter.WriteField("model", "gpt-image-1")
	_ = mpWriter.WriteField("prompt", "add clouds")
	fw, _ := mpWriter.CreateFormFile("image", "sample.png")
	_, _ = fw.Write([]byte("PNGDATA"))
	_ = mpWriter.Close()

	editRec := httptest.NewRecorder()
	editReq := httptest.NewRequest(http.MethodPost, "/v1/images/edits", &mpBuf)
	editReq.Header.Set("Content-Type", mpWriter.FormDataContentType())
	editReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(editRec, editReq)
	if editRec.Code != http.StatusOK || !strings.Contains(editRec.Body.String(), `"b64_json"`) {
		t.Fatalf("expected 200 OK multipart image edit response, got %d: %s", editRec.Code, editRec.Body.String())
	}

	// 3. Videos + per-API-key task status isolation
	vidRec := httptest.NewRecorder()
	vidReq := httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{"model":"sora-1","prompt":"ocean waves","seconds":5}`))
	vidReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(vidRec, vidReq)
	if vidRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK video creation, got %d: %s", vidRec.Code, vidRec.Body.String())
	}
	var vidCreated struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(vidRec.Body.Bytes(), &vidCreated)
	if vidCreated.ID == "" {
		t.Fatalf("expected video task id in %s", vidRec.Body.String())
	}

	vidGetOK := httptest.NewRecorder()
	vidGetReq := httptest.NewRequest(http.MethodGet, "/v1/videos/"+vidCreated.ID, nil)
	vidGetReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(vidGetOK, vidGetReq)
	if vidGetOK.Code != http.StatusOK {
		t.Fatalf("expected owner keyA to read video task, got %d: %s", vidGetOK.Code, vidGetOK.Body.String())
	}

	vidGetCross := httptest.NewRecorder()
	vidGetCrossReq := httptest.NewRequest(http.MethodGet, "/v1/videos/"+vidCreated.ID, nil)
	vidGetCrossReq.Header.Set("Authorization", "Bearer "+keyB)
	coord.HandleHTTP(vidGetCross, vidGetCrossReq)
	if vidGetCross.Code != http.StatusNotFound {
		t.Fatalf("expected cross-key video lookup to return 404, got %d", vidGetCross.Code)
	}

	// 4. Stateful /v1/responses: turn 1 -> turn 2 with previous_response_id -> GET -> input_items -> cross-key 404 -> DELETE
	resp1Rec := httptest.NewRecorder()
	resp1Req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"Remember secret code 7391"}`))
	resp1Req.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(resp1Rec, resp1Req)
	if resp1Rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on turn 1 /v1/responses, got %d: %s", resp1Rec.Code, resp1Rec.Body.String())
	}
	var r1 struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(resp1Rec.Body.Bytes(), &r1)
	if r1.ID == "" {
		t.Fatalf("expected response id in %s", resp1Rec.Body.String())
	}

	// Turn 2 references previous_response_id -> mock://echo echoes hydrated conversation including turn 1!
	resp2Rec := httptest.NewRecorder()
	resp2Req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","previous_response_id":"`+r1.ID+`","input":"What was the code?"}`))
	resp2Req.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(resp2Rec, resp2Req)
	if resp2Rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on turn 2 /v1/responses, got %d: %s", resp2Rec.Code, resp2Rec.Body.String())
	}

	itemsRec := httptest.NewRecorder()
	itemsReq := httptest.NewRequest(http.MethodGet, "/v1/responses/"+r1.ID+"/input_items", nil)
	itemsReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(itemsRec, itemsReq)
	if itemsRec.Code != http.StatusOK || !strings.Contains(itemsRec.Body.String(), "7391") {
		t.Fatalf("expected /input_items to contain turn 1 input, got %d: %s", itemsRec.Code, itemsRec.Body.String())
	}

	crossRespRec := httptest.NewRecorder()
	crossRespReq := httptest.NewRequest(http.MethodGet, "/v1/responses/"+r1.ID, nil)
	crossRespReq.Header.Set("Authorization", "Bearer "+keyB)
	coord.HandleHTTP(crossRespRec, crossRespReq)
	if crossRespRec.Code != http.StatusNotFound {
		t.Fatalf("expected cross-key GET /v1/responses/{id} to return 404, got %d", crossRespRec.Code)
	}

	delRec := httptest.NewRecorder()
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/responses/"+r1.ID, nil)
	delReq.Header.Set("Authorization", "Bearer "+keyA)
	coord.HandleHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK || !strings.Contains(delRec.Body.String(), `"deleted":true`) {
		t.Fatalf("expected DELETE /v1/responses/{id} 200 OK, got %d: %s", delRec.Code, delRec.Body.String())
	}

	// 5. GET /v1beta/models + SWR RefreshUpstreamModelCatalog
	v1bRec := httptest.NewRecorder()
	v1bReq := httptest.NewRequest(http.MethodGet, "/v1beta/models", nil)
	v1bReq.Header.Set("x-goog-api-key", keyA)
	coord.HandleHTTP(v1bRec, v1bReq)
	if v1bRec.Code != http.StatusOK || !strings.Contains(v1bRec.Body.String(), "models/gemini-2.5-pro") {
		t.Fatalf("expected GET /v1beta/models 200 OK, got %d: %s", v1bRec.Code, v1bRec.Body.String())
	}

	discovered := coord.RefreshUpstreamModelCatalog(context.Background(), true)
	if len(discovered["openai"]) == 0 || discovered["openai"][0] != "gpt-5-discovered-preview" {
		t.Fatalf("expected RefreshUpstreamModelCatalog to discover gpt-5-discovered-preview, got %+v", discovered)
	}
}
