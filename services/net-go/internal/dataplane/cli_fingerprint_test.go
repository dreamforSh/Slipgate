package dataplane

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
)

func manualClaudeFingerprint(firstUserText, cliVersion string) string {
	var units []uint16
	for _, r := range firstUserText {
		units = utf16.AppendRune(units, r)
	}
	picked := make([]uint16, 0, 3)
	for _, idx := range []int{4, 7, 20} {
		if idx < len(units) {
			picked = append(picked, units[idx])
		} else {
			picked = append(picked, '0')
		}
	}
	sample := string(utf16.Decode(picked))
	sum := sha256.Sum256([]byte("59cf53e54c78" + sample + cliVersion))
	return hex.EncodeToString(sum[:])[:3]
}

func TestClaudeCodeUTF16BillingFingerprint(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		text string
		ver  string
	}{
		{name: "short_padded", text: "hi", ver: "2.1.321"},
		{name: "mid_length", text: "hello world", ver: "2.1.321"},
		{name: "exact_21_ascii", text: "01234567890123456789X", ver: "2.1.321"},
		{name: "utf16_surrogate_pairs", text: "abc😀defghijklmnopqrsZ", ver: "2.1.321"},
	}

	for _, tc := range cases {
		got := ComputeClaudeCodeFingerprint(tc.text, tc.ver)
		want := manualClaudeFingerprint(tc.text, tc.ver)
		if got != want {
			t.Fatalf("%s: ComputeClaudeCodeFingerprint(%q, %q) = %q, want %q", tc.name, tc.text, tc.ver, got, want)
		}
		header := BuildClaudeBillingHeader(tc.text, tc.ver)
		wantHeader := fmt.Sprintf("x-anthropic-billing-header: cc_version=%s.%s; cc_entrypoint=cli;", tc.ver, want)
		if header != wantHeader {
			t.Fatalf("%s: BuildClaudeBillingHeader = %q, want %q", tc.name, header, wantHeader)
		}
	}

	// Surrogate pair sanity: at idx 4, "abc😀..." has low surrogate 0xDE00 (different from rune index).
	surrogateUnits := utf16.Encode([]rune("abc😀defghijklmnopqrsZ"))
	if surrogateUnits[4] != 0xDE00 {
		t.Fatalf("expected UTF-16 low surrogate at index 4, got 0x%04x", surrogateUnits[4])
	}
}

func TestCLIVersionLockstepAndEnvOverrides(t *testing.T) {
	// Clear any external overrides for clean baseline checks.
	for _, k := range []string{
		"SLIPGATE_CLAUDE_CLI_VERSION",
		"SUB2API_CLAUDE_CLI_VERSION",
		"SLIPGATE_CODEX_CLI_VERSION",
		"SLIPGATE_ANTIGRAVITY_VERSION",
		"ANTIGRAVITY_USER_AGENT_VERSION",
		"SLIPGATE_GEMINI_CLI_VERSION",
		"SLIPGATE_QWEN_CLI_VERSION",
		"SLIPGATE_GROK_CLI_VERSION",
		"XAI_GROK_CLI_VERSION",
		"SLIPGATE_OPENCODE_CLI_VERSION",
		"SLIPGATE_CLINE_CLI_VERSION",
	} {
		t.Setenv(k, "")
	}

	if got := CLIClaudeVersion(); got != "2.1.321" {
		t.Fatalf("default CLIClaudeVersion = %q, want 2.1.321", got)
	}
	if got := CLICodexVersion(); got != "0.146.0" {
		t.Fatalf("default CLICodexVersion = %q, want 0.146.0", got)
	}
	if got := CLIAntigravityVersion(); got != "2.23.0" {
		t.Fatalf("default CLIAntigravityVersion = %q, want 2.23.0", got)
	}
	if got := CLIGeminiVersion(); got != "0.73.0" {
		t.Fatalf("default CLIGeminiVersion = %q, want 0.73.0", got)
	}
	if got := CLIQwenVersion(); got != "0.28.3" {
		t.Fatalf("default CLIQwenVersion = %q, want 0.28.3", got)
	}
	if got := CLIGrokVersion(); got != "1.0.46" {
		t.Fatalf("default CLIGrokVersion = %q, want 1.0.46", got)
	}
	if got := CLIOpenCodeVersion(); got != "1.0.0" {
		t.Fatalf("default CLIOpenCodeVersion = %q, want 1.0.0", got)
	}
	if got := CLIClineVersion(); got != "3.17.0" {
		t.Fatalf("default CLIClineVersion = %q, want 3.17.0", got)
	}

	// Downgrade and prerelease rejection.
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "2.1.280")
	if got := CLIClaudeVersion(); got != "2.1.321" {
		t.Fatalf("CLIClaudeVersion accepted downgrade %q", got)
	}
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "2.1.350-rc.1")
	if got := CLIClaudeVersion(); got != "2.1.321" {
		t.Fatalf("CLIClaudeVersion accepted prerelease %q", got)
	}
	t.Setenv("SLIPGATE_CODEX_CLI_VERSION", "0.143.9")
	if got := CLICodexVersion(); got != "0.146.0" {
		t.Fatalf("CLICodexVersion accepted below-floor %q", got)
	}
	t.Setenv("SLIPGATE_GROK_CLI_VERSION", "1.0.12")
	if got := CLIGrokVersion(); got != "1.0.46" {
		t.Fatalf("CLIGrokVersion accepted below-floor %q", got)
	}

	// Valid env overrides.
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "")
	t.Setenv("SUB2API_CLAUDE_CLI_VERSION", "2.1.340")
	if got := CLIClaudeVersion(); got != "2.1.340" {
		t.Fatalf("SUB2API_CLAUDE_CLI_VERSION = %q, want 2.1.340", got)
	}
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "2.1.355")
	if got := CLIClaudeVersion(); got != "2.1.355" {
		t.Fatalf("SLIPGATE_CLAUDE_CLI_VERSION = %q, want 2.1.355", got)
	}
	t.Setenv("SLIPGATE_CODEX_CLI_VERSION", "0.148.0")
	if got := CLICodexVersion(); got != "0.148.0" {
		t.Fatalf("SLIPGATE_CODEX_CLI_VERSION = %q, want 0.148.0", got)
	}
	t.Setenv("SLIPGATE_ANTIGRAVITY_VERSION", "2.24.1")
	if got := CLIAntigravityVersion(); got != "2.24.1" {
		t.Fatalf("SLIPGATE_ANTIGRAVITY_VERSION = %q, want 2.24.1", got)
	}
	t.Setenv("SLIPGATE_GEMINI_CLI_VERSION", "0.74.0")
	if got := CLIGeminiVersion(); got != "0.74.0" {
		t.Fatalf("SLIPGATE_GEMINI_CLI_VERSION = %q, want 0.74.0", got)
	}
	t.Setenv("SLIPGATE_QWEN_CLI_VERSION", "0.29.0")
	if got := CLIQwenVersion(); got != "0.29.0" {
		t.Fatalf("SLIPGATE_QWEN_CLI_VERSION = %q, want 0.29.0", got)
	}
	t.Setenv("SLIPGATE_GROK_CLI_VERSION", "")
	t.Setenv("XAI_GROK_CLI_VERSION", "1.0.50")
	if got := CLIGrokVersion(); got != "1.0.50" {
		t.Fatalf("XAI_GROK_CLI_VERSION = %q, want 1.0.50", got)
	}
	t.Setenv("SLIPGATE_OPENCODE_CLI_VERSION", "1.1.0")
	if got := CLIOpenCodeVersion(); got != "1.1.0" {
		t.Fatalf("SLIPGATE_OPENCODE_CLI_VERSION = %q, want 1.1.0", got)
	}
	t.Setenv("SLIPGATE_CLINE_CLI_VERSION", "3.18.2")
	if got := CLIClineVersion(); got != "3.18.2" {
		t.Fatalf("SLIPGATE_CLINE_CLI_VERSION = %q, want 3.18.2", got)
	}
}

func TestClaudeRuntimeSwitchNode24VsBun21(t *testing.T) {
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "")
	t.Setenv("SUB2API_CLAUDE_CLI_VERSION", "")

	turn, err := ParseIngressRequest("/v1/chat/completions", "", []byte(`{
		"model": "claude-sonnet-4-5",
		"stream": true,
		"messages": [{"role": "user", "content": "Hello from runtime test"}]
	}`))
	if err != nil {
		t.Fatalf("ParseIngressRequest failed: %v", err)
	}

	buildAndInspect := func(profileID string) (*http.Request, map[string]any) {
		pctx := OutboundPersonaContext{
			Provider:      "anthropic",
			AuthKind:      "oauth",
			ExecutionMode: "stealth_http",
			AccountID:     "acc_claude_rt",
			RequestID:     "req_rt_1",
			UTLSProfileID: profileID,
		}
		sec := AccountSecret{APIKey: "sk-ant-oat01-runtime-test"}
		req, _, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, "claude-sonnet-4-5", sec, turn)
		if err != nil {
			t.Fatalf("BuildUpstreamHTTPRequestWithPersona(%q) failed: %v", profileID, err)
		}
		raw, _ := io.ReadAll(req.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode anthropic payload: %v", err)
		}
		return req, body
	}

	// Default ("") and explicit claude-node-24 -> Node 24 headers in lockstep with TLS.
	reqNode, bodyNode := buildAndInspect(stealth.ClaudeNodeProfileID)
	if reqNode.Header.Get("X-Stainless-Runtime") != "node" ||
		reqNode.Header.Get("X-Stainless-Runtime-Version") != "v24.3.0" ||
		reqNode.Header.Get("X-Stainless-OS") != "Linux" ||
		reqNode.Header.Get("X-Stainless-Arch") != "arm64" ||
		reqNode.Header.Get("X-Stainless-Package-Version") != "0.94.0" ||
		reqNode.Header.Get("X-Stainless-Timeout") != "600" ||
		reqNode.Header.Get("Accept") != "application/json" ||
		reqNode.Header.Get("User-Agent") != "claude-cli/2.1.321 (external, cli)" {
		t.Fatalf("unexpected Node 24 headers: %+v", reqNode.Header)
	}
	sessHeader := reqNode.Header.Get("X-Claude-Code-Session-Id")
	metaMap, _ := bodyNode["metadata"].(map[string]any)
	metaUserID, _ := metaMap["user_id"].(string)
	if sessHeader == "" || !strings.HasSuffix(metaUserID, "_session_"+sessHeader) {
		t.Fatalf("expected X-Claude-Code-Session-Id %q to match metadata.user_id %q", sessHeader, metaUserID)
	}

	// Legacy claude-bun-21 keeps bun runtime header when explicitly bound.
	reqBun, _ := buildAndInspect(stealth.ClaudeBunProfileID)
	if reqBun.Header.Get("X-Stainless-Runtime") != "bun" ||
		reqBun.Header.Get("User-Agent") != "claude-cli/2.1.321 (external, cli)" {
		t.Fatalf("unexpected Bun headers: %+v", reqBun.Header)
	}

	// Version lockstep under env override: User-Agent and system[0] billing block use identical version.
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "2.1.350")
	reqOverride, bodyOverride := buildAndInspect("")
	if reqOverride.Header.Get("User-Agent") != "claude-cli/2.1.350 (external, cli)" {
		t.Fatalf("expected User-Agent claude-cli/2.1.350, got %q", reqOverride.Header.Get("User-Agent"))
	}
	sysList, _ := bodyOverride["system"].([]any)
	if len(sysList) < 2 {
		t.Fatalf("expected >= 2 system blocks, got %+v", sysList)
	}
	sys0Text, _ := sysList[0].(map[string]any)["text"].(string)
	if !strings.HasPrefix(sys0Text, "x-anthropic-billing-header: cc_version=2.1.350.") {
		t.Fatalf("expected system[0] billing block with cc_version=2.1.350., got %q", sys0Text)
	}
}

func TestCodexInferenceVsOAuthAuthHeaders(t *testing.T) {
	t.Parallel()

	turn, err := ParseIngressRequest("/v1/responses", "", []byte(`{
		"model": "gpt-5-codex",
		"input": "hello codex"
	}`))
	if err != nil {
		t.Fatalf("ParseIngressRequest failed: %v", err)
	}
	pctx := OutboundPersonaContext{
		Provider:       "codex",
		AuthKind:       "oauth",
		ExecutionMode:  "stealth_http",
		AccountID:      "acc_codex_1",
		GuestMachineID: "00112233445566778899aabbccddeeff",
		RequestID:      "req_cx_1",
	}
	reqInf, _, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), pctx, "gpt-5-codex", AccountSecret{
		APIKey:           "eyJ-codex",
		ChatGPTAccountID: "acct_123",
	}, turn)
	if err != nil {
		t.Fatalf("BuildUpstreamHTTPRequestWithPersona failed: %v", err)
	}
	if reqInf.Header.Get("originator") != "codex_cli_rs" ||
		reqInf.Header.Get("version") != CLICodexVersion() ||
		reqInf.Header.Get("session_id") == "" ||
		reqInf.Header.Get("session-id") != reqInf.Header.Get("session_id") ||
		reqInf.Header.Get("Conversation_id") != reqInf.Header.Get("session_id") ||
		reqInf.Header.Get("x-codex-installation-id") == "" ||
		reqInf.Header.Get("x-codex-window-id") == "" ||
		reqInf.Header.Get("x-client-request-id") == "" ||
		reqInf.Header.Get("User-Agent") != CodexCLIUserAgent("") {
		t.Fatalf("missing expected Codex inference CLI headers: %+v", reqInf.Header)
	}

	// OAuth token endpoint (auth.openai.com) sends User-Agent + originator WITHOUT version.
	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "codex-oauth-secret", AllowPrivateUpstreams: true})
	reqOAuth, err := coord.buildOAuthRefreshRequest(context.Background(), "codex", AccountSecret{
		RefreshToken: "rt-codex",
		Headers:      map[string]string{"x-oauth-token-url": "https://auth.openai.com/oauth/token"},
	})
	if err != nil {
		t.Fatalf("buildOAuthRefreshRequest(codex) failed: %v", err)
	}
	if reqOAuth.Header.Get("User-Agent") != CodexCLIUserAgent("") ||
		reqOAuth.Header.Get("originator") != "codex_cli_rs" ||
		reqOAuth.Header.Get("version") != "" {
		t.Fatalf("unexpected Codex OAuth auth headers: %+v", reqOAuth.Header)
	}
}

func TestAllNonVMCLIAndSDKProviderHeaders(t *testing.T) {
	t.Parallel()

	// 1. ApplyCLIProviderHeaders coverage.
	newReq := func(rawURL string) *http.Request {
		r, _ := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(`{}`))
		return r
	}

	reqGemOAuth := newReq("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")
	ApplyCLIProviderHeaders(reqGemOAuth, OutboundPersonaContext{Provider: "gemini", AuthKind: "oauth"}, AccountSecret{}, reqGemOAuth.URL.String(), CodecGeminiGenerate)
	if reqGemOAuth.Header.Get("User-Agent") != GeminiCLIUserAgent("") ||
		reqGemOAuth.Header.Get("X-Goog-Api-Client") != "gl-node/24.3.0" ||
		reqGemOAuth.Header.Get("Client-Metadata") == "" {
		t.Fatalf("unexpected gemini OAuth headers: %+v", reqGemOAuth.Header)
	}

	reqGemKey := newReq("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")
	ApplyCLIProviderHeaders(reqGemKey, OutboundPersonaContext{Provider: "gemini", AuthKind: "api_key"}, AccountSecret{}, reqGemKey.URL.String(), CodecGeminiGenerate)
	if reqGemKey.Header.Get("Client-Metadata") != "" || reqGemKey.Header.Get("User-Agent") != GeminiCLIUserAgent("") {
		t.Fatalf("unexpected gemini api_key headers: %+v", reqGemKey.Header)
	}

	reqQwenOAuth := newReq("https://portal.qwen.ai/v1/chat/completions")
	ApplyCLIProviderHeaders(reqQwenOAuth, OutboundPersonaContext{Provider: "qwen", AuthKind: "oauth"}, AccountSecret{}, reqQwenOAuth.URL.String(), CodecOpenAIChat)
	if reqQwenOAuth.Header.Get("User-Agent") != QwenCLIUserAgent("") ||
		reqQwenOAuth.Header.Get("X-DashScope-UserAgent") != QwenCLIUserAgent("") ||
		reqQwenOAuth.Header.Get("X-DashScope-CacheControl") != "enable" ||
		reqQwenOAuth.Header.Get("X-DashScope-AuthType") != "qwen-oauth" {
		t.Fatalf("unexpected qwen OAuth headers: %+v", reqQwenOAuth.Header)
	}

	reqQwenKey := newReq("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
	ApplyCLIProviderHeaders(reqQwenKey, OutboundPersonaContext{Provider: "qwen", AuthKind: "api_key"}, AccountSecret{}, reqQwenKey.URL.String(), CodecOpenAIChat)
	if reqQwenKey.Header.Get("X-DashScope-AuthType") != "openai" {
		t.Fatalf("expected X-DashScope-AuthType=openai for api_key, got %q", reqQwenKey.Header.Get("X-DashScope-AuthType"))
	}

	reqGrokDirect := newReq("https://api.x.ai/v1/chat/completions")
	ApplyCLIProviderHeaders(reqGrokDirect, OutboundPersonaContext{Provider: "grok", AuthKind: "api_key"}, AccountSecret{}, reqGrokDirect.URL.String(), CodecOpenAIChat)
	if reqGrokDirect.Header.Get("User-Agent") != GrokCLIUserAgent("") ||
		reqGrokDirect.Header.Get("x-grok-client-version") != CLIGrokVersion() ||
		reqGrokDirect.Header.Get("x-grok-client-identifier") != "grok-pager" ||
		reqGrokDirect.Header.Get("X-XAI-Token-Auth") != "" {
		t.Fatalf("unexpected direct grok headers: %+v", reqGrokDirect.Header)
	}

	reqGrokProxy := newReq("https://cli-chat-proxy.grok.com/v1/chat/completions")
	ApplyCLIProviderHeaders(reqGrokProxy, OutboundPersonaContext{Provider: "grok", AuthKind: "api_key"}, AccountSecret{}, reqGrokProxy.URL.String(), CodecOpenAIChat)
	if reqGrokProxy.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" ||
		reqGrokProxy.Header.Get("x-grok-client-mode") != "interactive" ||
		reqGrokProxy.Header.Get("x-authenticateresponse") != "authenticate-response" {
		t.Fatalf("unexpected cli-chat-proxy grok headers: %+v", reqGrokProxy.Header)
	}

	for _, tc := range []struct {
		prov   string
		egress CodecKind
		wantUA string
	}{
		{"opencode_go", CodecOpenAIChat, OpenCodeCLIUserAgent("")},
		{"command_code", CodecOpenAIChat, CodexCLIUserAgent("")},
		{"cline", CodecOpenAIChat, ClineCLIUserAgent("")},
		{"anthropic", CodecAnthropicMessages, "Anthropic/JS 0.94.0"},
		{"openai", CodecOpenAIChat, "OpenAI/JS 4.104.0"},
		{"bedrock", CodecOpenAIChat, "aws-sdk-js/3.700.0"},
		{"vertex", CodecAnthropicMessages, "google-api-nodejs-client/9.15.1"},
		{"typesafe", CodecOpenAIChat, "typesafe-js/1.0.0"},
	} {
		req := newReq("https://api.example.com/v1/messages")
		ApplyCLIProviderHeaders(req, OutboundPersonaContext{Provider: tc.prov, AuthKind: "api_key"}, AccountSecret{}, req.URL.String(), tc.egress)
		if req.Header.Get("User-Agent") != tc.wantUA {
			t.Fatalf("provider %s User-Agent = %q, want %q", tc.prov, req.Header.Get("User-Agent"), tc.wantUA)
		}
		if tc.prov == "cline" && (req.Header.Get("HTTP-Referer") != "https://cline.bot" || req.Header.Get("X-Title") != "Cline") {
			t.Fatalf("missing Cline attribution headers: %+v", req.Header)
		}
		if tc.prov == "anthropic" && req.Header.Get("X-Stainless-Runtime") != "node" {
			t.Fatalf("missing Anthropic Node SDK headers: %+v", req.Header)
		}
	}

	// 2. OAuth refresh CLI headers.
	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "cli-oauth-refresh-secret", AllowPrivateUpstreams: true})
	for _, plat := range []string{"anthropic", "codex", "antigravity", "gemini", "qwen"} {
		r, err := coord.buildOAuthRefreshRequest(context.Background(), plat, AccountSecret{
			RefreshToken: "rt-test",
			ClientID:     "cid-test",
			ClientSecret: "csec-test",
			Headers:      map[string]string{"x-oauth-token-url": "https://example.com/oauth/token"},
		})
		if err != nil {
			t.Fatalf("buildOAuthRefreshRequest(%s) failed: %v", plat, err)
		}
		if ua := r.Header.Get("User-Agent"); ua == "" || strings.Contains(ua, "Go-http-client") {
			t.Fatalf("buildOAuthRefreshRequest(%s) bad UA: %q", plat, ua)
		}
		if plat == "qwen" && r.Header.Get("X-DashScope-UserAgent") != QwenCLIUserAgent("") {
			t.Fatalf("qwen OAuth refresh missing X-DashScope-UserAgent: %+v", r.Header)
		}
	}

	// 3. Model catalog fetches emit CLI UAs (never Go-http-client).
	var seenQwenUA, seenGemUA string
	catalogSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/v1beta/models") {
			seenGemUA = r.Header.Get("User-Agent")
			_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-2.5-pro"}]}`))
			return
		}
		seenQwenUA = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen3-coder-plus"}]}`))
	}))
	defer catalogSrv.Close()

	modelsQwen, err := coord.fetchProviderModelsOnce(context.Background(), "acc_cat_qwen", accountMeta{Platform: "qwen", ExecutionMode: "direct_api", AuthKind: "api_key"}, AccountSecret{APIKey: "sk-qwen", BaseURL: catalogSrv.URL})
	if err != nil || len(modelsQwen) != 1 || seenQwenUA != QwenCLIUserAgent("") {
		t.Fatalf("qwen catalog mismatch: models=%v ua=%q err=%v", modelsQwen, seenQwenUA, err)
	}
	modelsGem, err := coord.fetchProviderModelsOnce(context.Background(), "acc_cat_gem", accountMeta{Platform: "gemini", ExecutionMode: "direct_api", AuthKind: "oauth"}, AccountSecret{APIKey: "ya29.gem", BaseURL: catalogSrv.URL})
	if err != nil || len(modelsGem) != 1 || seenGemUA != GeminiCLIUserAgent("") {
		t.Fatalf("gemini catalog mismatch: models=%v ua=%q err=%v", modelsGem, seenGemUA, err)
	}
}

func TestDirectAPIUTLSDispatchWithCoordinator(t *testing.T) {
	t.Parallel()

	var gotProtoMajor int
	var gotUA, gotRuntime, gotSessionID string

	tlsSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProtoMajor = r.ProtoMajor
		gotUA = r.Header.Get("User-Agent")
		gotRuntime = r.Header.Get("X-Stainless-Runtime")
		gotSessionID = r.Header.Get("X-Claude-Code-Session-Id")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, strings.Join([]string{
			`event: message_start`,
			`data: {"type":"message_start","message":{"id":"msg_direct_1","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":6,"output_tokens":0}}}`,
			``,
			`event: content_block_start`,
			`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			``,
			`event: content_block_delta`,
			`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"direct-utls-ok"}}`,
			``,
			`event: content_block_stop`,
			`data: {"type":"content_block_stop","index":0}`,
			``,
			`event: message_delta`,
			`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
			``,
			`event: message_stop`,
			`data: {"type":"message_stop"}`,
			``,
		}, "\n"))
	}))
	tlsSrv.EnableHTTP2 = true
	tlsSrv.StartTLS()
	defer tlsSrv.Close()

	roots := x509.NewCertPool()
	roots.AddCert(tlsSrv.Certificate())
	dialer := stealth.NewAccountDialer(nil)
	dialer.SetRootCAs(roots)

	coord := NewCoordinator(CoordinatorOptions{
		VaultSecret:           "direct-utls-secret",
		StealthDialer:         dialer,
		DirectClient:          nil,
		AllowPrivateUpstreams: true,
	})
	encSecret, err := coord.Vault().EncryptHex(fmt.Sprintf(`{"apiKey":"sk-ant-oat01-direct-test","baseUrl":%q}`, tlsSrv.URL))
	if err != nil {
		t.Fatalf("EncryptHex failed: %v", err)
	}
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp-direct", Platform: "anthropic", SubscriptionType: "balance", RateMultiplier: 1, Enabled: true}},
		Accounts: []SyncAccountInput{
			{
				ID:                "acc_direct_claude",
				GroupID:           "grp-direct",
				Platform:          "anthropic",
				ExecutionMode:     "direct_api",
				AuthKind:          "oauth",
				CredentialsEncHex: encSecret,
				MaxConcurrency:    2,
				Status:            "active",
			},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot failed: %v", err)
	}

	events := collectProbe(t, coord, "acc_direct_claude", ProbeRequest{Model: "claude-sonnet-4-5"})
	last := events[len(events)-1]
	if !last.Success {
		t.Fatalf("expected direct_api probe success, got done=%+v events=%+v", last, events)
	}
	if probeText(events) != "direct-utls-ok" {
		t.Fatalf("unexpected probe text: %q", probeText(events))
	}
	if gotProtoMajor != 1 {
		t.Fatalf("expected claude-node-24 direct_api to negotiate HTTP/1.1 (ProtoMajor=1), got HTTP/%d", gotProtoMajor)
	}
	if gotUA != ClaudeCLIUserAgent("") || gotRuntime != "node" || gotSessionID == "" {
		t.Fatalf("missing CLI headers on direct_api uTLS dispatch: ua=%q runtime=%q session=%q", gotUA, gotRuntime, gotSessionID)
	}
}
