package dataplane

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func TestVaultMultiProtocolSecretParsing(t *testing.T) {
	t.Parallel()

	raw := `{
		"api_key": "sk-sub2-test",
		"account_mode": "coding",
		"api_protocol": "anthropic",
		"api_base_urls": {"anthropic": "https://custom.example/anthropic", "chat_completions": "https://custom.example/v1"},
		"protocol_rules": [{"pattern": "claude-*", "protocol": "anthropic"}, {"pattern": "gpt-*", "protocol": "responses", "protocols": ["responses", "chat_completions"]}]
	}`
	sec := ParseAccountSecret(raw)
	if sec.APIKey != "sk-sub2-test" || sec.AccountMode != "coding" || sec.APIProtocol != "anthropic" {
		t.Fatalf("unexpected parsed multi-protocol secret: %+v", sec)
	}
	if sec.APIBaseURLs["anthropic"] != "https://custom.example/anthropic" {
		t.Fatalf("expected api_base_urls parsed, got %+v", sec.APIBaseURLs)
	}
	if len(sec.ProtocolRules) != 2 || sec.ProtocolRules[1].Pattern != "gpt-*" || len(sec.ProtocolRules[1].Protocols) != 2 {
		t.Fatalf("expected protocol_rules parsed, got %+v", sec.ProtocolRules)
	}

	cloned := cloneAccountSecret(sec)
	cloned.ProtocolRules[1].Protocols[0] = "mutated"
	if sec.ProtocolRules[1].Protocols[0] != "responses" {
		t.Fatalf("cloneAccountSecret shared slice mutation")
	}
}

func TestMultiProtocolCNProvidersRoutingAndDeepSeekResponses(t *testing.T) {
	t.Parallel()

	// 1. Kimi coding mode routes Anthropic inbound to /coding/v1/messages and Chat to /coding/v1/chat/completions.
	kimiCoding := AccountSecret{APIKey: "sk-kimi", AccountMode: "coding"}
	anthTurn, err := ParseIngressRequest("/v1/messages", "", []byte(`{"model":"kimi-k2","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	req, egress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "kimi", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_kimi",
	}, "kimi-k2", kimiCoding, anthTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egress != CodecAnthropicMessages || req.URL.String() != "https://api.kimi.com/coding/v1/messages" {
		t.Fatalf("unexpected kimi coding anthropic route: egress=%s url=%s", egress, req.URL.String())
	}
	if req.Header.Get("x-api-key") != "sk-kimi" || req.Header.Get("Authorization") != "Bearer sk-kimi" {
		t.Fatalf("expected x-api-key and bearer headers, got %+v", req.Header)
	}

	// 2. GLM (Zhipu alias) coding mode has no native responses -> Responses inbound falls back to /api/coding/paas/v4/chat/completions.
	glmCoding := AccountSecret{APIKey: "sk-glm", AccountMode: "coding"}
	respTurn, err := ParseIngressRequest("/v1/responses", "", []byte(`{"model":"glm-4.6","input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	req, egress, err = BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "glm", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_glm",
	}, "glm-4.6", glmCoding, respTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egress != CodecOpenAIChat || req.URL.String() != "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" {
		t.Fatalf("unexpected glm coding responses fallback: egress=%s url=%s", egress, req.URL.String())
	}

	// 3. DeepSeek native Responses uses `/responses` (not `/v1/responses`) and NEVER injects Codex CLI headers.
	dsKey := AccountSecret{APIKey: "sk-ds"}
	req, egress, err = BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "deepseek", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_ds",
	}, "deepseek-reasoner", dsKey, respTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egress != CodecOpenAIResponses || req.URL.String() != "https://api.deepseek.com/responses" {
		t.Fatalf("unexpected deepseek responses route: egress=%s url=%s", egress, req.URL.String())
	}
	if req.Header.Get("originator") != "" || req.Header.Get("chatgpt-account-id") != "" {
		t.Fatalf("non-Codex Responses leaked Codex headers: %+v", req.Header)
	}

	// 4. Legacy single-URL custom relay via `baseUrl|apiKey` preserves chat_completions compatibility on Anthropic ingress.
	legacyRelay := ParseAccountSecret("https://relay.example.local/v1|sk-relay")
	req, egress, err = BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "minimax", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_mm",
	}, "MiniMax-M2", legacyRelay, anthTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egress != CodecOpenAIChat || req.URL.String() != "https://relay.example.local/v1/chat/completions" {
		t.Fatalf("unexpected legacy relay route: egress=%s url=%s", egress, req.URL.String())
	}
}

func TestOpenCodeGoCommandCodeAndClineRouting(t *testing.T) {
	t.Parallel()

	chatTurn, err := ParseIngressRequest("/v1/chat/completions", "", []byte(`{"model":"opencode_go/grok-4.7","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	ocSecret := AccountSecret{APIKey: "sk-oc-go", AccountMode: "go"}
	req, egress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "opencode_go", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_oc", RequestID: "req_1",
	}, "opencode_go/grok-4.7", ocSecret, chatTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egress != CodecOpenAIResponses || req.URL.String() != "https://opencode.ai/zen/go/v1/responses" {
		t.Fatalf("unexpected opencode_go grok route: egress=%s url=%s", egress, req.URL.String())
	}
	if req.Header.Get("X-OpenCode-Session") == "" || req.Header.Get("User-Agent") != OpenCodeCLIUserAgent("") {
		t.Fatalf("expected X-OpenCode-Session and %s UA, got %+v", OpenCodeCLIUserAgent(""), req.Header)
	}
	if req.Header.Get("originator") != "" {
		t.Fatalf("unexpected Codex originator header on OpenCode Responses")
	}

	// OpenCode Zen routes claude-* -> Anthropic and qwen3.8-max -> Chat Completions.
	zenSecret := AccountSecret{APIKey: "sk-oc-zen", AccountMode: "zen"}
	reqZenClaude, egressZenClaude, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "opencode_go", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_oc_zen",
	}, "claude-sonnet-4-6", zenSecret, chatTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egressZenClaude != CodecAnthropicMessages || reqZenClaude.URL.String() != "https://opencode.ai/zen/v1/messages" {
		t.Fatalf("unexpected opencode zen claude route: egress=%s url=%s", egressZenClaude, reqZenClaude.URL.String())
	}

	// Unsupported models on OpenCode standard gateway fail cleanly.
	_, _, err = BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "opencode_go", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_oc",
	}, "gemini-2.5-pro", ocSecret, chatTurn)
	var unsup ErrOpenCodeUnsupportedModel
	if !errors.As(err, &unsup) {
		t.Fatalf("expected ErrOpenCodeUnsupportedModel, got %v", err)
	}

	// Command Code uses CatalogProtocols when model supports inbound protocol (same-protocol passthrough)
	// and preserves vendor prefix `deepseek/deepseek-v4-flash`.
	ccRespTurn, _ := ParseIngressRequest("/v1/responses", "", []byte(`{"model":"deepseek/deepseek-v4-flash","input":"hi"}`))
	reqCC, egressCC, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider:         "command_code",
		AuthKind:         "api_key",
		ExecutionMode:    "direct_api",
		AccountID:        "acc_cc",
		CatalogProtocols: []string{APIProtocolChatCompletions, APIProtocolResponses},
	}, "command_code/deepseek/deepseek-v4-flash", AccountSecret{APIKey: "sk-cc"}, ccRespTurn)
	if err != nil {
		t.Fatal(err)
	}
	if egressCC != CodecOpenAIResponses || reqCC.URL.String() != "https://api.commandcode.ai/provider/v1/responses" {
		t.Fatalf("unexpected command_code route: egress=%s url=%s", egressCC, reqCC.URL.String())
	}
	if !strings.Contains(reqCC.Header.Get("User-Agent"), "codex_cli_rs/") {
		t.Fatalf("expected Codex CLI UA on official commandcode host, got %q", reqCC.Header.Get("User-Agent"))
	}

	// Cline forces Chat Completions and keeps cline-pass/ prefix intact.
	anthForCline, _ := ParseIngressRequest("/v1/messages", "", []byte(`{"model":"cline-pass/glm-5.3-flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`))
	reqCline, egressCline, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), OutboundPersonaContext{
		Provider: "cline", AuthKind: "api_key", ExecutionMode: "direct_api", AccountID: "acc_cl",
	}, "cline-pass/glm-5.3-flash", AccountSecret{APIKey: "sk-cl"}, anthForCline)
	if err != nil {
		t.Fatal(err)
	}
	if egressCline != CodecOpenAIChat || reqCline.URL.String() != "https://api.cline.bot/api/v1/chat/completions" {
		t.Fatalf("unexpected cline route: egress=%s url=%s", egressCline, reqCline.URL.String())
	}
	bodyBytes, _ := ioReadAndCheckModel(t, reqCline)
	if !strings.Contains(string(bodyBytes), `"cline-pass/glm-5.3-flash"`) {
		t.Fatalf("expected cline-pass/ model prefix preserved, got %s", string(bodyBytes))
	}
}

func ioReadAndCheckModel(t *testing.T, req *http.Request) ([]byte, error) {
	t.Helper()
	var buf bytes.Buffer
	_, err := buf.ReadFrom(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), nil
}

func TestTypeSafeSystemOneValidationAndDispatch(t *testing.T) {
	t.Parallel()

	validBody := []byte(`{"model":"jev-latest","state":"hello world","questions":{"q1":{"type":"noul","instructions":"ok?"}}}`)
	if model, err := ValidateSystemOneRequest(validBody); err != nil || model != "jev-latest" {
		t.Fatalf("expected valid systemone body, got model=%q err=%v", model, err)
	}
	if _, err := ValidateSystemOneRequest([]byte(`{"model":"jev-latest","state":"hi","stream":true,"questions":{"q1":{"type":"noul"}}}`)); !errors.Is(err, ErrSystemOneStreamingUnsupported) {
		t.Fatalf("expected streaming unsupported error, got %v", err)
	}
	if _, err := ValidateSystemOneRequest([]byte(`{"model":"gpt-5","state":"hi","questions":{"q1":{"type":"noul"}}}`)); err == nil {
		t.Fatalf("expected non-jev-latest model rejection")
	}

	// End-to-end Coordinator dispatch for POST /v1/systemone and isolation guard on /v1/chat/completions.
	const rawKey = "sk-sg-ts-test-0123456789abcdef0123456789"
	coreSock, stopCore := startSub2apiMockCoreIPC(t, func(frame dpbridge.Frame) dpbridge.Frame {
		switch frame.Type {
		case dpbridge.FrameReqHeaders:
			var req coreTurnEvalRequest
			_ = json.Unmarshal(frame.Payload, &req)
			provider := "typesafe"
			if req.Model == "gpt-5" {
				provider = "openai"
			}
			resp, _ := json.Marshal(coreDispatchDirective{
				Action:        "dispatch",
				Status:        http.StatusOK,
				HoldID:        99,
				UserID:        "usr_1",
				APIKeyID:      "key_1",
				GroupID:       "grp_1",
				AccountID:     "acc_" + provider,
				Provider:      provider,
				ExecutionMode: "direct_api",
				AuthKind:      "api_key",
				PublicModel:   req.Model,
				UpstreamModel: req.Model,
				CleanseMode:   "zero",
			})
			return dpbridge.Frame{StreamID: frame.StreamID, Type: dpbridge.FrameDispatchDirective, Flags: dpbridge.FlagEndStream, Payload: resp}
		case dpbridge.FrameSettleReport:
			return dpbridge.Frame{StreamID: frame.StreamID, Type: dpbridge.FrameSettleAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true,"settledCostNanoUsd":"100"}`)}
		default:
			return dpbridge.Frame{StreamID: frame.StreamID, Type: dpbridge.FrameSyncAck, Flags: dpbridge.FlagEndStream, Payload: []byte(`{"ok":true}`)}
		}
	})
	defer stopCore()

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               coreSock,
		VaultSecret:           "ts-vault-secret",
		AllowPrivateUpstreams: true,
	})
	keySum := sha256.Sum256([]byte(rawKey))
	_ = keySum
	_, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		Accounts: []SyncAccountInput{
			{ID: "acc_typesafe", GroupID: "grp_1", Platform: "typesafe", ExecutionMode: "direct_api", AuthKind: "api_key", Status: "active", CredentialsEncHex: mustEncrypt(t, coord.vault, "mock://ok")},
			{ID: "acc_openai", GroupID: "grp_1", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", Status: "active", CredentialsEncHex: mustEncrypt(t, coord.vault, "mock://ok")},
		},
		APIKeys: []SyncApiKeyInput{
			{ID: "key_1", UserID: "usr_1", GroupID: "grp_1", KeyHashHex: hex.EncodeToString(keySum[:]), RPMLimit: 60, ConcurrencyLimit: 5, Enabled: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Valid POST /v1/systemone to typesafe account succeeds and returns JSON answers.
	req := httptest.NewRequest(http.MethodPost, "/v1/systemone", bytes.NewReader(validBody))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	rec := httptest.NewRecorder()
	coord.HandleHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"connectivity_check"`) {
		t.Fatalf("expected 200 systemone response, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 2. TypeSafe model sent to non-systemone endpoint returns 404 isolation guard.
	badChat := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"jev-latest","messages":[{"role":"user","content":"hi"}]}`))
	badChat.Header.Set("Authorization", "Bearer "+rawKey)
	badRec := httptest.NewRecorder()
	coord.HandleHTTP(badRec, badChat)
	if badRec.Code != http.StatusNotFound || !strings.Contains(badRec.Body.String(), "/v1/systemone") {
		t.Fatalf("expected 404 systemone-only guard, got %d body=%s", badRec.Code, badRec.Body.String())
	}

	// 3. ProbeAccount on typesafe works cleanly over mock://ok.
	var probeEvents []ProbeEvent
	coord.ProbeAccount(context.Background(), "acc_typesafe", ProbeRequest{}, func(ev ProbeEvent) {
		probeEvents = append(probeEvents, ev)
	})
	if len(probeEvents) == 0 || !probeEvents[len(probeEvents)-1].Success {
		t.Fatalf("expected successful typesafe probe, got %+v", probeEvents)
	}

	// 4. Command Code catalog lookup parses supported_endpoints over HTTP and caches them.
	ccSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"deepseek/deepseek-v4-flash","supported_endpoints":["/chat/completions","/responses"]}]}`))
	}))
	defer ccSrv.Close()
	ccProtos := coord.lookupCommandCodeModelProtocols(
		context.Background(),
		"acc_cc_live",
		accountMeta{Platform: "command_code", AuthKind: "api_key", ExecutionMode: "direct_api"},
		AccountSecret{APIKey: "sk-cc-live", BaseURL: ccSrv.URL},
		"deepseek/deepseek-v4-flash",
	)
	if len(ccProtos) != 2 || ccProtos[0] != APIProtocolChatCompletions || ccProtos[1] != APIProtocolResponses {
		t.Fatalf("expected [chat_completions responses], got %+v", ccProtos)
	}
}

func startSub2apiMockCoreIPC(t *testing.T, handler func(dpbridge.Frame) dpbridge.Frame) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("mock core ipc listen failed: %v", err)
	}
	go func() {
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					req, rErr := dpbridge.ReadFrame(c)
					if rErr != nil {
						return
					}
					reply := handler(req)
					_ = dpbridge.WriteFrame(c, reply)
				}
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

func mustEncrypt(t *testing.T, v *Vault, plain string) string {
	t.Helper()
	hexOut, err := v.EncryptHex(plain)
	if err != nil {
		t.Fatal(err)
	}
	return hexOut
}
