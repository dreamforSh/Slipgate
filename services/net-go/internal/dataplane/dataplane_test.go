package dataplane

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

func TestVaultAESGCMAndFormats(t *testing.T) {
	t.Parallel()

	v := NewVault("test-vault-secret-123")

	encJSON, err := v.EncryptHex(`{"apiKey":"sk-ant-real","baseUrl":"https://api.anthropic.com","utlsProfileId":"claude_cli_2_x"}`)
	if err != nil {
		t.Fatalf("EncryptHex failed: %v", err)
	}
	sec, err := v.DecryptHex(encJSON)
	if err != nil {
		t.Fatalf("DecryptHex failed: %v", err)
	}
	if sec.APIKey != "sk-ant-real" || sec.BaseURL != "https://api.anthropic.com" || sec.UTLSProfileID != "claude_cli_2_x" {
		t.Fatalf("unexpected decrypted JSON secret: %+v", sec)
	}

	encPipe, _ := v.EncryptHex("https://custom.openai.local/v1|sk-proj-abc")
	secPipe, err := v.DecryptHex(encPipe)
	if err != nil || secPipe.BaseURL != "https://custom.openai.local/v1" || secPipe.APIKey != "sk-proj-abc" {
		t.Fatalf("unexpected pipe secret: %+v err=%v", secPipe, err)
	}

	encMock, _ := v.EncryptHex("mock://ok")
	secMock, err := v.DecryptHex(encMock)
	if err != nil || !secMock.IsMock() || secMock.EffectiveMockTarget() != "mock://ok" {
		t.Fatalf("unexpected mock secret: %+v err=%v", secMock, err)
	}

	// Pasted .claude/.credentials.json format (normalizes legacy 20x -> ultra, 5x -> max)
	claudeRaw := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-live-token","refreshToken":"sk-ant-ort01-refresh","rateLimitTier":"default_claude_max_20x"}}`
	secClaude := ParseAccountSecret(claudeRaw)
	if secClaude.APIKey != "sk-ant-oat01-live-token" || secClaude.RefreshToken != "sk-ant-ort01-refresh" || secClaude.SubscriptionTier != "ultra" {
		t.Fatalf("unexpected .claude/.credentials.json parse: %+v", secClaude)
	}
	if NormalizeSubscriptionTier("default_claude_max_5x") != "max" ||
		SubscriptionTierMultiplier("anthropic", "max") != 5 ||
		SubscriptionTierMultiplier("anthropic", "ultra") != 20 {
		t.Fatalf("unexpected Claude max(5x)/ultra(20x) tier mapping")
	}

	// Pasted .codex/auth.json format + Codex Pro 5x / 10x / 25x tiers
	codexRaw := `{"tokens":{"access_token":"eyJ-codex-oat","refresh_token":"rt-codex","account_id":"acct_chatgpt_99","plan_type":"pro_25x"}}`
	secCodex := ParseAccountSecret(codexRaw)
	if secCodex.APIKey != "eyJ-codex-oat" || secCodex.RefreshToken != "rt-codex" || secCodex.ChatGPTAccountID != "acct_chatgpt_99" || secCodex.SubscriptionTier != "pro_25x" {
		t.Fatalf("unexpected .codex/auth.json parse: %+v", secCodex)
	}
	if SubscriptionTierMultiplier("codex", "plus") != 1 ||
		SubscriptionTierMultiplier("codex", "pro_5x") != 5 ||
		SubscriptionTierMultiplier("codex", "pro_10x") != 10 ||
		SubscriptionTierMultiplier("codex", "pro_25x") != 25 {
		t.Fatalf("unexpected Codex Pro 5x/10x/25x tier multipliers")
	}

	// Pasted Antigravity OAuth credentials format
	agRaw := `{"accessToken":"ya29.antigravity-token","refreshToken":"1//ag-refresh","projectId":"ag-proj-001"}`
	secAG := ParseAccountSecret(agRaw)
	if secAG.APIKey != "ya29.antigravity-token" || secAG.RefreshToken != "1//ag-refresh" || secAG.ProjectID != "ag-proj-001" {
		t.Fatalf("unexpected Antigravity secret parse: %+v", secAG)
	}
}

func TestCrossProtocolTranscodingAndZeroInjectionToolStripping(t *testing.T) {
	t.Parallel()

	// 1. OpenAI Chat streaming ingress -> Anthropic streaming egress with undeclared `Read` + declared `lookup_weather`.
	reqBody := `{
		"model": "claude-sonnet-4-5",
		"stream": true,
		"messages": [{"role":"user","content":"Check Tokyo weather"}],
		"tools": [{"type":"function","function":{"name":"lookup_weather","parameters":{"type":"object"}}}]
	}`
	turn, err := ParseIngressRequest("/v1/chat/completions", "", []byte(reqBody))
	if err != nil {
		t.Fatalf("ParseIngressRequest failed: %v", err)
	}
	if !turn.CallerDeclaredTools["lookup_weather"] || turn.CallerDeclaredTools["Read"] {
		t.Fatalf("unexpected CallerDeclaredTools: %+v", turn.CallerDeclaredTools)
	}

	upstreamResp := ExecuteMockTurn("mock://tool-leak", "claude-sonnet-4-5", CodecAnthropicMessages, turn)
	defer upstreamResp.Body.Close()

	rec := httptest.NewRecorder()
	tracker := &NativeTurnTracker{}
	metrics, err := RelayAndTranscodeResponse(
		rec,
		upstreamResp,
		CodecAnthropicMessages,
		turn,
		"claude-sonnet-4-5",
		"zero",
		time.Now(),
		tracker.OnVisibleToolDelta,
	)
	if err != nil {
		t.Fatalf("RelayAndTranscodeResponse failed: %v", err)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "chat.completion.chunk") || !strings.Contains(body, "[DONE]") {
		t.Fatalf("expected OpenAI SSE chunks and [DONE], got:\n%s", body)
	}
	if strings.Contains(body, `"Read"`) || strings.Contains(body, "/etc/shadow") {
		t.Fatalf("undeclared CLI tool Read leaked through CleanseMode=zero:\n%s", body)
	}
	if !strings.Contains(body, `"lookup_weather"`) {
		t.Fatalf("caller-declared tool lookup_weather was missing:\n%s", body)
	}
	if tracker.CanFailover() {
		t.Fatalf("expected NativeTurnTracker to lock failover after visible tool delta")
	}
	if metrics.InputTokens == 0 || metrics.OutputTokens == 0 {
		t.Fatalf("expected non-zero token metrics, got %+v", metrics)
	}

	// 2. Anthropic Messages unary ingress -> Gemini unary egress.
	antBody := `{"model":"gemini-2.5-pro","max_tokens":512,"messages":[{"role":"user","content":"Hello Gemini"}]}`
	antTurn, err := ParseIngressRequest("/v1/messages", "", []byte(antBody))
	if err != nil {
		t.Fatalf("ParseIngressRequest anthropic failed: %v", err)
	}
	gemUpstream := ExecuteMockTurn("mock://echo", "gemini-2.5-pro", CodecGeminiGenerate, antTurn)
	defer gemUpstream.Body.Close()

	antRec := httptest.NewRecorder()
	_, err = RelayAndTranscodeResponse(antRec, gemUpstream, CodecGeminiGenerate, antTurn, "gemini-2.5-pro", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("Anthropic<-Gemini transcode failed: %v", err)
	}
	if !strings.Contains(antRec.Body.String(), `"type":"message"`) || !strings.Contains(antRec.Body.String(), "echo: Hello Gemini") {
		t.Fatalf("unexpected Anthropic response: %s", antRec.Body.String())
	}

	// 3. Gemini streamGenerateContent ingress -> OpenAI SSE egress.
	gemReqBody := `{"contents":[{"role":"user","parts":[{"text":"Stream please"}]}]}`
	gemTurn, err := ParseIngressRequest("/v1beta/models/gpt-4o:streamGenerateContent", "alt=sse", []byte(gemReqBody))
	if err != nil {
		t.Fatalf("ParseIngressRequest gemini failed: %v", err)
	}
	if !gemTurn.Stream || gemTurn.PublicModel != "gpt-4o" {
		t.Fatalf("expected stream=true model=gpt-4o, got %+v", gemTurn)
	}
	oaStream := ExecuteMockTurn("mock://ok", "gpt-4o", CodecOpenAIChat, gemTurn)
	defer oaStream.Body.Close()

	gemRec := httptest.NewRecorder()
	_, err = RelayAndTranscodeResponse(gemRec, oaStream, CodecOpenAIChat, gemTurn, "gpt-4o", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("Gemini<-OpenAI stream transcode failed: %v", err)
	}
	if !strings.Contains(gemRec.Body.String(), `"candidates"`) ||
		!strings.Contains(gemRec.Body.String(), "Slipgate verified r") ||
		!strings.Contains(gemRec.Body.String(), "esponse from gpt-4o") {
		t.Fatalf("unexpected Gemini SSE output: %s", gemRec.Body.String())
	}
}

func TestCoordinatorEndToEndModesRiskAndSettlement(t *testing.T) {
	t.Parallel()

	const (
		vaultSecret   = "unit-vault-secret"
		internalToken = "unit-internal-token"
		validAPIKey   = "sk-sg-0123456789abcdef0123456789abcdef01234567"
	)
	keyDigest := sha256.Sum256([]byte(validAPIKey))
	keyHashHex := hex.EncodeToString(keyDigest[:])

	// Local HTTPS upstream server for stealth_http mode over loopback SOCKS5 + uTLS.
	upstreamTLS := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "sk-ant-stealth-live" {
			http.Error(w, `{"error":"bad_upstream_auth"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Slipgate-Window-5h-Bps", "1250")
		_, _ = w.Write([]byte(`{
			"id":"msg_live_stealth",
			"type":"message",
			"role":"assistant",
			"content":[{"type":"text","text":"Live stealth uTLS over SOCKS5 succeeded"}],
			"stop_reason":"end_turn",
			"usage":{"input_tokens":20,"output_tokens":10}
		}`))
	}))
	defer upstreamTLS.Close()

	socksAddr, closeSOCKS := startLoopbackSOCKS5(t)
	defer closeSOCKS()

	// Mock BFF server capturing settlements & risk ban events.
	var (
		bffMu       sync.Mutex
		settlements []TurnSettlementEvent
		riskEvents  []RiskBanEventPayload
	)
	bffSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Slipgate-Internal-Token") != internalToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/v1/internal/dataplane/settlement":
			var ev TurnSettlementEvent
			_ = json.NewDecoder(r.Body).Decode(&ev)
			bffMu.Lock()
			settlements = append(settlements, ev)
			bffMu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/v1/internal/dataplane/risk-events":
			var rv RiskBanEventPayload
			_ = json.NewDecoder(r.Body).Decode(&rv)
			bffMu.Lock()
			riskEvents = append(riskEvents, rv)
			bffMu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer bffSrv.Close()

	// Mock slipgate-guestd responder for vm_slot mode.
	guestLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("guest listen failed: %v", err)
	}
	defer guestLn.Close()
	go func() {
		for {
			conn, acceptErr := guestLn.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, rErr := dpbridge.ReadFrame(c)
				if rErr == nil && req.Type == dpbridge.FramePing {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FramePong,
						Flags:    dpbridge.FlagEndStream,
						Payload:  req.Payload,
					})
				}
			}(conn)
		}
	}()

	// Mock slipgate-core IPC server simulating FrameSyncState, FrameReqHeaders, and FrameSettleReport.
	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen failed: %v", err)
	}
	defer coreLn.Close()

	var (
		coreMu      sync.Mutex
		syncedCount int
		settleCount int
	)
	go func() {
		for {
			conn, acceptErr := coreLn.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, rErr := dpbridge.ReadFrame(c)
				if rErr != nil {
					return
				}
				switch req.Type {
				case dpbridge.FrameSyncState:
					coreMu.Lock()
					syncedCount++
					coreMu.Unlock()
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameSyncAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true}`),
					})
				case dpbridge.FrameReqHeaders:
					var eval coreTurnEvalRequest
					_ = json.Unmarshal(req.Payload, &eval)
					var resp coreDispatchDirective
					switch {
					case eval.APIKey != validAPIKey:
						resp = coreDispatchDirective{
							Action:    "reject",
							Status:    401,
							ErrorType: "authentication_error",
							ErrorCode: "invalid_api_key",
							Message:   "Invalid API key",
						}
					case strings.Contains(eval.BodyExcerpt, "__slipgate_risk_probe__"):
						resp = coreDispatchDirective{
							Action:        "reject",
							Status:        403,
							APIKeyID:      "key_1",
							UserID:        "usr_1",
							ErrorType:     "permission_error",
							ErrorCode:     "prompt_distillation_signature",
							Message:       "Blocked by pre-hop risk gate",
							RiskTriggered: true,
							SubjectKind:   "api_key",
							SubjectHash:   "key_1",
							StrikeLevel:   1,
							BanDuration:   "10m",
						}
					case eval.Method == http.MethodGet && strings.HasPrefix(eval.Path, "/v1/models"):
						resp = coreDispatchDirective{
							Action: "models",
							Status: 200,
							Models: []string{"claude-sonnet-4-5", "gpt-4o"},
						}
					case eval.Model == "claude-vm":
						resp = coreDispatchDirective{
							Action:        "dispatch",
							Status:        200,
							HoldID:        102,
							UserID:        "usr_1",
							APIKeyID:      "key_1",
							GroupID:       "grp_default",
							AccountID:     "acc_vm",
							Provider:      "anthropic",
							ExecutionMode: "vm_slot",
							PublicModel:   "claude-vm",
							UpstreamModel: "claude-sonnet-4-5",
							CleanseMode:   "zero",
							HoldNanoUSD:   "50000",
						}
					default:
						resp = coreDispatchDirective{
							Action:        "dispatch",
							Status:        200,
							HoldID:        101,
							UserID:        "usr_1",
							APIKeyID:      "key_1",
							GroupID:       "grp_default",
							AccountID:     "acc_stealth",
							Provider:      "anthropic",
							ExecutionMode: "stealth_http",
							PublicModel:   eval.Model,
							UpstreamModel: "claude-sonnet-4-5",
							CleanseMode:   "zero",
							HoldNanoUSD:   "50000",
						}
					}
					raw, _ := json.Marshal(resp)
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  raw,
					})
				case dpbridge.FrameSettleReport:
					coreMu.Lock()
					settleCount++
					coreMu.Unlock()
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameSettleAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true,"settledCostNanoUsd":"210000","balanceAfterNanoUsd":"999790000","ordinaryUpstream400Exempted":false}`),
					})
				}
			}(conn)
		}
	}()

	_, socksPortStr, _ := net.SplitHostPort(socksAddr)
	var socksPort uint16
	_, _ = io.Copy(io.Discard, strings.NewReader(socksPortStr))
	for i := range len(socksPortStr) {
		socksPort = socksPort*10 + uint16(socksPortStr[i]-'0')
	}

	pool := clashpool.NewManager(1, 65535, 2)
	_, err = pool.SyncNodes("sub_1", []clashpool.Node{
		{
			ID:           "node_stealth",
			Name:         "Stealth Node",
			ExitIP:       "198.51.100.10",
			ListenerPort: int(socksPort),
			Health:       clashpool.HealthHealthy,
			Enabled:      true,
		},
		{
			ID:           "node_vm",
			Name:         "VM Node",
			ExitIP:       "198.51.100.11",
			ListenerPort: int(socksPort),
			Health:       clashpool.HealthHealthy,
			Enabled:      true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}

	roots := x509.NewCertPool()
	roots.AddCert(upstreamTLS.Certificate())
	dialer := stealth.NewAccountDialer(pool)
	dialer.SetRootCAs(roots)
	// Register an HTTP/1.1 TLS profile matching httptest.NewTLSServer's default ALPN.
	if err := dialer.ValidateProfile(clashpool.TLSProfile{
		ID:            "test_h1",
		ALPNProtocols: []string{"http/1.1"},
	}); err != nil {
		t.Fatalf("ValidateProfile failed: %v", err)
	}
	dialer.RegisterProfile(clashpool.TLSProfile{
		ID:            "test_h1",
		ALPNProtocols: []string{"http/1.1"},
	})

	vmMgr := vmslot.NewManager(pool)
	_, err = vmMgr.ProvisionSlot(vmslot.Slot{
		ID:           "slot_1",
		AccountID:    "acc_vm",
		ClashNodeID:  "node_vm",
		Hypervisor:   vmslot.HypervisorDocker,
		State:        vmslot.StateReady,
		GuestUDSPath: guestLn.Addr().String(),
		CleanseMode:  "zero",
		Persona: vmslot.HardwarePersona{
			GuestMachineID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
			MACAddress:     "02:11:22:33:44:55",
			SMBIOSUUID:     "550e8400-e29b-41d4-a716-446655440000",
		},
	})
	if err != nil {
		t.Fatalf("ProvisionSlot failed: %v", err)
	}
	if err := pool.BindAccountWithProfile("acc_vm", "node_vm", false, "test_h1"); err != nil {
		t.Fatalf("BindAccount acc_vm failed: %v", err)
	}

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:       coreLn.Addr().String(),
		BFFOrigin:     bffSrv.URL,
		InternalToken: internalToken,
		VaultSecret:   vaultSecret,
		ClashPool:     pool,
		StealthDialer: dialer,
		VMSlots:       vmMgr,
	})

	stealthCredJSON, _ := json.Marshal(AccountSecret{
		APIKey:        "sk-ant-stealth-live",
		BaseURL:       upstreamTLS.URL,
		UTLSProfileID: "test_h1",
	})
	encStealth, _ := coord.Vault().EncryptHex(string(stealthCredJSON))
	encVM, _ := coord.Vault().EncryptHex("mock://409")

	ack, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups: []SyncGroupInput{
			{ID: "grp_default", Platform: "composite", SubscriptionType: "balance", RateMultiplier: 1.0, Enabled: true},
		},
		Accounts: []SyncAccountInput{
			{ID: "acc_stealth", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "stealth_http", CredentialsEncHex: encStealth, MaxConcurrency: 5, Priority: 10, Status: "active"},
			{ID: "acc_vm", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "vm_slot", CredentialsEncHex: encVM, MaxConcurrency: 5, Priority: 20, Status: "active"},
		},
		APIKeys: []SyncApiKeyInput{
			{ID: "key_1", UserID: "usr_1", GroupID: "grp_default", KeyHashHex: keyHashHex, RPMLimit: 60, ConcurrencyLimit: 5, Enabled: true},
		},
		Wallets: []SyncWalletInput{
			{UserID: "usr_1", BalanceNanoUSD: "1000000000", HeldNanoUSD: "0"},
		},
	})
	if err != nil || !ack.OK || ack.VaultAccounts != 2 {
		t.Fatalf("SyncSnapshot failed: ack=%+v err=%v", ack, err)
	}

	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()

	// A) Unauthenticated request -> 401
	resp401, err := http.Post(edge.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("401 req failed: %v", err)
	}
	_ = resp401.Body.Close()
	if resp401.StatusCode != http.StatusUnauthorized || resp401.Header.Get("X-Slipgate-Plane") != "dataplane-direct" {
		t.Fatalf("expected 401 + dataplane-direct, got %d (%s)", resp401.StatusCode, resp401.Header.Get("X-Slipgate-Plane"))
	}

	// B) stealth_http BEFORE binding acc_stealth -> fail-closed 502!
	reqUnbound, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/chat/completions", strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`))
	reqUnbound.Header.Set("Authorization", "Bearer "+validAPIKey)
	respUnbound, err := http.DefaultClient.Do(reqUnbound)
	if err != nil {
		t.Fatalf("unbound req failed: %v", err)
	}
	_ = respUnbound.Body.Close()
	if respUnbound.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected fail-closed 502 for unbound stealth_http account, got %d", respUnbound.StatusCode)
	}

	// Bind acc_stealth to node_stealth and re-run -> 200 OK over real SOCKS5 + uTLS + OpenAI<-Anthropic transcode!
	if err := pool.BindAccountWithProfile("acc_stealth", "node_stealth", false, "test_h1"); err != nil {
		t.Fatalf("BindAccount acc_stealth failed: %v", err)
	}
	reqOK, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/chat/completions", strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`))
	reqOK.Header.Set("Authorization", "Bearer "+validAPIKey)
	respOK, err := http.DefaultClient.Do(reqOK)
	if err != nil {
		t.Fatalf("bound stealth req failed: %v", err)
	}
	rawOK, _ := io.ReadAll(respOK.Body)
	_ = respOK.Body.Close()
	if respOK.StatusCode != http.StatusOK || !strings.Contains(string(rawOK), "Live stealth uTLS over SOCKS5 succeeded") {
		t.Fatalf("expected 200 stealth response, got %d: %s", respOK.StatusCode, string(rawOK))
	}

	// C) vm_slot mode -> reserves seat, pings slipgate-guestd, and preserves native 409 continuation status!
	reqVM, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/messages", strings.NewReader(`{"model":"claude-vm","max_tokens":128,"messages":[{"role":"user","content":"continue"}]}`))
	reqVM.Header.Set("x-api-key", validAPIKey)
	respVM, err := http.DefaultClient.Do(reqVM)
	if err != nil {
		t.Fatalf("vm req failed: %v", err)
	}
	_ = respVM.Body.Close()
	if respVM.StatusCode != http.StatusConflict || respVM.Header.Get("X-Slipgate-VM-Slot") != "slot_1" {
		t.Fatalf("expected 409 conflict + X-Slipgate-VM-Slot=slot_1, got %d (%s)", respVM.StatusCode, respVM.Header.Get("X-Slipgate-VM-Slot"))
	}
	slotAfter, _ := vmMgr.GetSlot("slot_1")
	if slotAfter.ActiveSubagents != 0 {
		t.Fatalf("expected VM subagent seat released after turn, got %d", slotAfter.ActiveSubagents)
	}

	// D) Pre-hop risk probe -> 403 + posts risk event to BFF.
	reqRisk, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/chat/completions", strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"__slipgate_risk_probe__"}]}`))
	reqRisk.Header.Set("Authorization", "Bearer "+validAPIKey)
	respRisk, err := http.DefaultClient.Do(reqRisk)
	if err != nil {
		t.Fatalf("risk req failed: %v", err)
	}
	_ = respRisk.Body.Close()
	if respRisk.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 risk rejection, got %d", respRisk.StatusCode)
	}

	// E) MCP tools/list metadata fast path -> 200 JSON-RPC.
	reqMCP, _ := http.NewRequest(http.MethodPost, edge.URL+"/mcp/v1", strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`))
	reqMCP.Header.Set("Authorization", "Bearer "+validAPIKey)
	respMCP, err := http.DefaultClient.Do(reqMCP)
	if err != nil {
		t.Fatalf("mcp req failed: %v", err)
	}
	rawMCP, _ := io.ReadAll(respMCP.Body)
	_ = respMCP.Body.Close()
	if respMCP.StatusCode != http.StatusOK || !strings.Contains(string(rawMCP), "slipgate_complete") {
		t.Fatalf("unexpected MCP tools/list response: %d %s", respMCP.StatusCode, string(rawMCP))
	}

	coreMu.Lock()
	gotSyncs, gotSettles := syncedCount, settleCount
	coreMu.Unlock()
	if gotSyncs != 1 || gotSettles != 4 {
		t.Fatalf("expected 1 sync and 4 settles (unbound + stealth + vm + mcp), got syncs=%d settles=%d", gotSyncs, gotSettles)
	}

	bffMu.Lock()
	gotSettlements := len(settlements)
	gotRisks := len(riskEvents)
	bffMu.Unlock()
	if gotSettlements != 2 || gotRisks != 1 {
		t.Fatalf("expected 2 BFF settlements and 1 risk event, got settlements=%d risks=%d", gotSettlements, gotRisks)
	}
}

func TestSubscriptionMimicryClaudeCodexAndAntigravityVM(t *testing.T) {
	t.Parallel()

	// 1. Claude Code Pro/Max OAuth subscription request & quota watermark mimicry.
	claudeTurn, err := ParseIngressRequest("/v1/chat/completions", "", []byte(`{
		"model":"claude-sonnet-4-5",
		"messages":[{"role":"system","content":"Answer concisely."},{"role":"user","content":"Hello Claude Max"}]
	}`))
	if err != nil {
		t.Fatalf("ParseIngressRequest claude failed: %v", err)
	}
	claudePctx := OutboundPersonaContext{
		Provider:       "anthropic",
		AuthKind:       "oauth",
		ExecutionMode:  "vm_slot",
		AccountID:      "acc_claude_max",
		GuestMachineID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
		RuntimeProfile: "claude_code",
		CleanseMode:    "zero",
		RequestID:      "req_claude_1",
	}
	claudeReq, claudeEgress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), claudePctx, "claude-sonnet-4-5", AccountSecret{
		APIKey: "sk-ant-oat01-max-token",
	}, claudeTurn)
	if err != nil {
		t.Fatalf("BuildUpstreamHTTPRequestWithPersona claude failed: %v", err)
	}
	if claudeEgress != CodecAnthropicMessages {
		t.Fatalf("expected CodecAnthropicMessages, got %s", claudeEgress)
	}
	if claudeReq.URL.String() != "https://api.anthropic.com/v1/messages?beta=true" {
		t.Fatalf("expected ?beta=true URL, got %s", claudeReq.URL.String())
	}
	if claudeReq.Header.Get("x-api-key") != "" {
		t.Fatalf("Claude OAuth request must never send x-api-key, got %q", claudeReq.Header.Get("x-api-key"))
	}
	if claudeReq.Header.Get("Authorization") != "Bearer sk-ant-oat01-max-token" ||
		claudeReq.Header.Get("x-app") != "cli" ||
		claudeReq.Header.Get("X-Stainless-Runtime") != "bun" ||
		!strings.Contains(claudeReq.Header.Get("anthropic-beta"), "oauth-2025-04-20") ||
		!strings.Contains(claudeReq.Header.Get("User-Agent"), "claude-cli/2.1.280") {
		t.Fatalf("missing Claude CLI subscription headers: %+v", claudeReq.Header)
	}
	claudeBodyBytes, _ := io.ReadAll(claudeReq.Body)
	var claudePayload struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
		System []struct {
			Type         string            `json:"type"`
			Text         string            `json:"text"`
			CacheControl map[string]string `json:"cache_control"`
		} `json:"system"`
	}
	if err := json.Unmarshal(claudeBodyBytes, &claudePayload); err != nil {
		t.Fatalf("unmarshal claude body failed: %v", err)
	}
	if !strings.HasPrefix(claudePayload.Metadata.UserID, "user_") || !strings.Contains(claudePayload.Metadata.UserID, "_account_") || !strings.Contains(claudePayload.Metadata.UserID, "_session_") {
		t.Fatalf("unexpected metadata.user_id: %q", claudePayload.Metadata.UserID)
	}
	if len(claudePayload.System) < 2 || !strings.Contains(claudePayload.System[0].Text, "Claude Code") || claudePayload.System[0].CacheControl["type"] != "ephemeral" {
		t.Fatalf("expected Claude Code ephemeral system preamble, got %+v", claudePayload.System)
	}

	// Verify Anthropic unified ratelimit header extraction (0.425 -> 4250 bps).
	claudeHeaders := make(http.Header)
	claudeHeaders.Set("anthropic-ratelimit-unified-5h-utilization", "0.425")
	claudeHeaders.Set("anthropic-ratelimit-unified-7d-utilization", "0.15")
	claudeUpResp := jsonHTTPResponse(http.StatusOK, claudeHeaders, map[string]any{
		"id":          "msg_sub_1",
		"type":        "message",
		"role":        "assistant",
		"content":     []map[string]any{{"type": "text", "text": "Claude Max reply"}},
		"stop_reason": "end_turn",
		"usage":       map[string]any{"input_tokens": 12, "output_tokens": 6},
	})
	claudeRec := httptest.NewRecorder()
	claudeMetrics, err := RelayAndTranscodeResponse(claudeRec, claudeUpResp, CodecAnthropicMessages, claudeTurn, "claude-sonnet-4-5", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("RelayAndTranscodeResponse claude failed: %v", err)
	}
	if claudeMetrics.Window5hUsedBps != 4250 || claudeMetrics.Window7dUsedBps != 1500 {
		t.Fatalf("expected 4250/1500 bps from anthropic-ratelimit headers, got %+v", claudeMetrics)
	}

	// 2. OpenAI Codex Plus/Pro OAuth subscription: Responses SSE -> both unary & streaming OpenAI Chat, stripping undeclared exec_command.
	codexTurnUnary, err := ParseIngressRequest("/v1/chat/completions", "", []byte(`{
		"model":"gpt-5-codex",
		"stream":false,
		"messages":[{"role":"user","content":"Check weather"}],
		"tools":[{"type":"function","function":{"name":"lookup_weather","parameters":{"type":"object"}}}]
	}`))
	if err != nil {
		t.Fatalf("ParseIngressRequest codex failed: %v", err)
	}
	codexPctx := OutboundPersonaContext{
		Provider:       "codex",
		AuthKind:       "oauth",
		ExecutionMode:  "stealth_http",
		AccountID:      "acc_codex_plus",
		GuestMachineID: "11223344556677889900aabbccddeeff",
		CleanseMode:    "zero",
		RequestID:      "req_codex_1",
	}
	codexSecret := AccountSecret{
		APIKey:           "eyJ-codex-oauth",
		ChatGPTAccountID: "acct_plus_777",
	}
	codexReq, codexEgress, err := BuildUpstreamHTTPRequestWithPersona(context.Background(), codexPctx, "gpt-5-codex", codexSecret, codexTurnUnary)
	if err != nil {
		t.Fatalf("BuildUpstreamHTTPRequestWithPersona codex failed: %v", err)
	}
	if codexEgress != CodecOpenAIResponses || codexReq.URL.String() != "https://chatgpt.com/backend-api/codex/responses" {
		t.Fatalf("unexpected codex egress/url: %s %s", codexEgress, codexReq.URL.String())
	}
	if codexReq.Header.Get("originator") != "codex_cli_rs" ||
		codexReq.Header.Get("chatgpt-account-id") != "acct_plus_777" ||
		codexReq.Header.Get("OpenAI-Beta") != "responses=experimental" ||
		codexReq.Header.Get("session_id") == "" {
		t.Fatalf("missing Codex CLI headers: %+v", codexReq.Header)
	}
	codexReqBody, _ := io.ReadAll(codexReq.Body)
	if !strings.Contains(string(codexReqBody), `"store":false`) || !strings.Contains(string(codexReqBody), `"stream":true`) {
		t.Fatalf("Codex OAuth backend requires store:false and stream:true even for unary callers, got: %s", string(codexReqBody))
	}

	makeCodexSSEResp := func() *http.Response {
		sse := strings.Join([]string{
			`event: response.output_text.delta`,
			`data: {"type":"response.output_text.delta","delta":"Codex Plus "}`,
			``,
			`event: response.output_text.delta`,
			`data: {"type":"response.output_text.delta","delta":"verified."}`,
			``,
			`event: response.output_item.done`,
			`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_leak","name":"exec_command","arguments":"{\"cmd\":\"id\"}"}}`,
			``,
			`event: response.output_item.done`,
			`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_weather","name":"lookup_weather","arguments":"{\"city\":\"Tokyo\"}"}}`,
			``,
			`event: response.completed`,
			`data: {"type":"response.completed","response":{"id":"resp_cx_1","usage":{"input_tokens":30,"output_tokens":14,"input_tokens_details":{"cached_tokens":8}}}}`,
			``,
		}, "\n")
		h := make(http.Header)
		h.Set("Content-Type", "text/event-stream")
		h.Set("x-codex-primary-used-percent", "18.5")
		h.Set("x-codex-secondary-used-percent", "7.25")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     h,
			Body:       io.NopCloser(strings.NewReader(sse)),
		}
	}

	// 2a) Unary caller receives assembled chat.completion JSON with exec_command stripped and lookup_weather preserved.
	codexUnaryRec := httptest.NewRecorder()
	codexMetrics, err := RelayAndTranscodeResponse(codexUnaryRec, makeCodexSSEResp(), CodecOpenAIResponses, codexTurnUnary, "gpt-5-codex", "zero", time.Now(), nil)
	if err != nil {
		t.Fatalf("Codex SSE->Unary transcode failed: %v", err)
	}
	unaryOut := codexUnaryRec.Body.String()
	if !strings.Contains(unaryOut, `"object":"chat.completion"`) || !strings.Contains(unaryOut, "Codex Plus verified.") {
		t.Fatalf("unexpected Codex unary output: %s", unaryOut)
	}
	if strings.Contains(unaryOut, "exec_command") || !strings.Contains(unaryOut, "lookup_weather") {
		t.Fatalf("expected exec_command stripped and lookup_weather preserved: %s", unaryOut)
	}
	if codexMetrics.Window5hUsedBps != 1850 || codexMetrics.Window7dUsedBps != 725 || codexMetrics.CacheReadTokens != 8 {
		t.Fatalf("unexpected Codex metrics: %+v", codexMetrics)
	}

	// 2b) Streaming caller receives real-time SSE chunks.
	codexTurnStream := *codexTurnUnary
	codexTurnStream.Stream = true
	codexStreamRec := httptest.NewRecorder()
	if _, err := RelayAndTranscodeResponse(codexStreamRec, makeCodexSSEResp(), CodecOpenAIResponses, &codexTurnStream, "gpt-5-codex", "zero", time.Now(), nil); err != nil {
		t.Fatalf("Codex SSE->SSE transcode failed: %v", err)
	}
	if !strings.Contains(codexStreamRec.Body.String(), "chat.completion.chunk") ||
		strings.Contains(codexStreamRec.Body.String(), "exec_command") ||
		!strings.Contains(codexStreamRec.Body.String(), "lookup_weather") {
		t.Fatalf("unexpected Codex stream output: %s", codexStreamRec.Body.String())
	}

	// 3. Antigravity (反重力) Cloud Code v1internal + RuntimeAntigravity VM Slot end-to-end over SOCKS5 + uTLS.
	const (
		vaultSecret   = "ag-vault-secret"
		internalToken = "ag-internal-token"
		validAPIKey   = "sk-sg-ag0123456789abcdef0123456789abcdef012345"
		agMachineID   = "f0e1d2c3b4a5968778695a4b3c2d1e0f"
	)
	keyDigest := sha256.Sum256([]byte(validAPIKey))
	keyHashHex := hex.EncodeToString(keyDigest[:])

	agUpstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1internal:generateContent" {
			http.Error(w, "unexpected path: "+r.URL.Path, http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer ya29.ag-live-oauth" ||
			r.Header.Get("X-Goog-Device-Id") != agMachineID ||
			!strings.Contains(r.Header.Get("User-Agent"), "antigravity/1.15.8") ||
			!strings.Contains(r.Header.Get("Client-Metadata"), "GEMINI") {
			http.Error(w, "bad antigravity headers", http.StatusUnauthorized)
			return
		}
		var env struct {
			Project   string         `json:"project"`
			Model     string         `json:"model"`
			UserAgent string         `json:"userAgent"`
			RequestID string         `json:"requestId"`
			Request   map[string]any `json:"request"`
		}
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if env.Project != "ag-cloud-proj" || env.Model != "claude-sonnet-4-5" || env.UserAgent != "antigravity" || !strings.HasPrefix(env.RequestID, "agent-") {
			http.Error(w, "bad antigravity envelope", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("x-antigravity-quota-used-percent", "31.5")
		_, _ = w.Write([]byte(`{
			"response": {
				"candidates": [{
					"content": {
						"role": "model",
						"parts": [
							{"text": "Antigravity VM verified."},
							{"functionCall": {"name": "browser_subagent", "args": {"url": "http://internal"}}},
							{"functionCall": {"name": "lookup_weather", "args": {"city": "Osaka"}}}
						]
					},
					"finishReason": "STOP"
				}],
				"usageMetadata": {"promptTokenCount": 22, "candidatesTokenCount": 11}
			}
		}`))
	}))
	defer agUpstream.Close()

	socksAddr, closeSOCKS := startLoopbackSOCKS5(t)
	defer closeSOCKS()
	_, socksPortStr, _ := net.SplitHostPort(socksAddr)
	var socksPort uint16
	for i := range len(socksPortStr) {
		socksPort = socksPort*10 + uint16(socksPortStr[i]-'0')
	}

	guestLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("guest listen failed: %v", err)
	}
	defer guestLn.Close()
	go func() {
		for {
			conn, err := guestLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, err := dpbridge.ReadFrame(c)
				if err == nil && req.Type == dpbridge.FramePing {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FramePong,
						Flags:    dpbridge.FlagEndStream,
						Payload:  req.Payload,
					})
				}
			}(conn)
		}
	}()

	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen failed: %v", err)
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
				req, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				switch req.Type {
				case dpbridge.FrameSyncState:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameSyncAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true}`),
					})
				case dpbridge.FrameReqHeaders:
					raw, _ := json.Marshal(coreDispatchDirective{
						Action:        "dispatch",
						Status:        200,
						HoldID:        501,
						UserID:        "usr_ag",
						APIKeyID:      "key_ag",
						GroupID:       "grp_ag",
						AccountID:     "acc_ag_vm",
						Provider:      "antigravity",
						ExecutionMode: "vm_slot",
						AuthKind:      "vm_cli_seed",
						PublicModel:   "antigravity/claude-sonnet-4-5",
						UpstreamModel: "antigravity/claude-sonnet-4-5",
						CleanseMode:   "zero",
						HoldNanoUSD:   "50000",
					})
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameDispatchDirective,
						Flags:    dpbridge.FlagEndStream,
						Payload:  raw,
					})
				case dpbridge.FrameSettleReport:
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: req.StreamID,
						Type:     dpbridge.FrameSettleAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true,"settledCostNanoUsd":"150000","balanceAfterNanoUsd":"999850000"}`),
					})
				}
			}(conn)
		}
	}()

	var settledEvents []TurnSettlementEvent
	var settleMu sync.Mutex
	bffSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/internal/dataplane/settlement" {
			var ev TurnSettlementEvent
			_ = json.NewDecoder(r.Body).Decode(&ev)
			settleMu.Lock()
			settledEvents = append(settledEvents, ev)
			settleMu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer bffSrv.Close()

	pool := clashpool.NewManager(1, 65535, 1)
	_, err = pool.SyncNodes("sub_ag", []clashpool.Node{
		{
			ID:           "node_ag",
			Name:         "Antigravity Node",
			ExitIP:       "203.0.113.77",
			ListenerPort: int(socksPort),
			Health:       clashpool.HealthHealthy,
			Enabled:      true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(agUpstream.Certificate())
	dialer := stealth.NewAccountDialer(pool)
	dialer.SetRootCAs(roots)
	dialer.RegisterProfile(clashpool.TLSProfile{
		ID:            "test_ag_h1",
		ALPNProtocols: []string{"http/1.1"},
	})
	if err := pool.BindAccountWithProfile("acc_ag_vm", "node_ag", false, "test_ag_h1"); err != nil {
		t.Fatalf("BindAccountWithProfile failed: %v", err)
	}

	vmMgr := vmslot.NewManager(pool)
	_, err = vmMgr.ProvisionSlot(vmslot.Slot{
		ID:             "slot_ag_1",
		AccountID:      "acc_ag_vm",
		ClashNodeID:    "node_ag",
		Hypervisor:     vmslot.HypervisorDocker,
		RuntimeProfile: vmslot.RuntimeAntigravity,
		State:          vmslot.StateReady,
		GuestUDSPath:   guestLn.Addr().String(),
		CleanseMode:    "zero",
		Persona: vmslot.HardwarePersona{
			GuestMachineID: agMachineID,
			MACAddress:     "02:aa:bb:cc:dd:ee",
			SMBIOSUUID:     "550e8400-e29b-41d4-a716-446655440099",
		},
	})
	if err != nil {
		t.Fatalf("ProvisionSlot antigravity failed: %v", err)
	}

	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:       coreLn.Addr().String(),
		BFFOrigin:     bffSrv.URL,
		InternalToken: internalToken,
		VaultSecret:   vaultSecret,
		ClashPool:     pool,
		StealthDialer: dialer,
		VMSlots:       vmMgr,
	})
	agSecretRaw, _ := json.Marshal(map[string]any{
		"accessToken": "ya29.ag-live-oauth",
		"projectId":   "ag-cloud-proj",
		"baseUrl":     agUpstream.URL,
	})
	encAG, _ := coord.Vault().EncryptHex(string(agSecretRaw))
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 2,
		Groups:         []SyncGroupInput{{ID: "grp_ag", Platform: "antigravity", SubscriptionType: "subscription", RateMultiplier: 1.0, Enabled: true}},
		Accounts:       []SyncAccountInput{{ID: "acc_ag_vm", GroupID: "grp_ag", Platform: "antigravity", ExecutionMode: "vm_slot", AuthKind: "vm_cli_seed", CredentialsEncHex: encAG, MaxConcurrency: 5, Status: "active"}},
		APIKeys:        []SyncApiKeyInput{{ID: "key_ag", UserID: "usr_ag", GroupID: "grp_ag", KeyHashHex: keyHashHex, RPMLimit: 60, ConcurrencyLimit: 5, Enabled: true}},
		Wallets:        []SyncWalletInput{{UserID: "usr_ag", BalanceNanoUSD: "1000000000", HeldNanoUSD: "0"}},
	}); err != nil {
		t.Fatalf("SyncSnapshot antigravity failed: %v", err)
	}

	edge := httptest.NewServer(http.HandlerFunc(coord.HandleHTTP))
	defer edge.Close()

	agReq, _ := http.NewRequest(http.MethodPost, edge.URL+"/v1/chat/completions", strings.NewReader(`{
		"model":"antigravity/claude-sonnet-4-5",
		"messages":[{"role":"user","content":"Hello Antigravity VM"}],
		"tools":[{"type":"function","function":{"name":"lookup_weather","parameters":{"type":"object"}}}]
	}`))
	agReq.Header.Set("Authorization", "Bearer "+validAPIKey)
	agResp, err := http.DefaultClient.Do(agReq)
	if err != nil {
		t.Fatalf("Antigravity VM request failed: %v", err)
	}
	agOutBytes, _ := io.ReadAll(agResp.Body)
	_ = agResp.Body.Close()

	if agResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from Antigravity VM turn, got %d: %s", agResp.StatusCode, string(agOutBytes))
	}
	if agResp.Header.Get("X-Slipgate-VM-Slot") != "slot_ag_1" || agResp.Header.Get("X-Slipgate-VM-Runtime") != "antigravity" {
		t.Fatalf("expected VM slot & runtime=antigravity headers, got slot=%q runtime=%q", agResp.Header.Get("X-Slipgate-VM-Slot"), agResp.Header.Get("X-Slipgate-VM-Runtime"))
	}
	agOut := string(agOutBytes)
	if !strings.Contains(agOut, "Antigravity VM verified.") || strings.Contains(agOut, "browser_subagent") || !strings.Contains(agOut, "lookup_weather") {
		t.Fatalf("unexpected Antigravity transcoded output (browser_subagent must be stripped, lookup_weather kept): %s", agOut)
	}

	settleMu.Lock()
	gotAGSettles := len(settledEvents)
	var firstSettle TurnSettlementEvent
	if gotAGSettles > 0 {
		firstSettle = settledEvents[0]
	}
	settleMu.Unlock()
	if gotAGSettles != 1 || firstSettle.EgressCodec != string(CodecAntigravityInternal) || firstSettle.Window5hUsedBps != 3150 {
		t.Fatalf("expected Antigravity settlement with Window5hUsedBps=3150, got count=%d ev=%+v", gotAGSettles, firstSettle)
	}
}

func startLoopbackSOCKS5(t *testing.T) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("socks5 listen failed: %v", err)
	}
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			go handleMinimalSOCKS5(client)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

func handleMinimalSOCKS5(client net.Conn) {
	defer client.Close()
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(client, hdr); err != nil || hdr[0] != 0x05 {
		return
	}
	methods := make([]byte, int(hdr[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return
	}
	_, _ = client.Write([]byte{0x05, 0x00})

	req := make([]byte, 4)
	if _, err := io.ReadFull(client, req); err != nil || req[1] != 0x01 {
		return
	}
	var host string
	switch req[3] {
	case 0x01:
		ip := make([]byte, 4)
		if _, err := io.ReadFull(client, ip); err != nil {
			return
		}
		host = net.IP(ip).String()
	case 0x03:
		lb := make([]byte, 1)
		if _, err := io.ReadFull(client, lb); err != nil {
			return
		}
		d := make([]byte, int(lb[0]))
		if _, err := io.ReadFull(client, d); err != nil {
			return
		}
		host = string(d)
	default:
		return
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(client, pb); err != nil {
		return
	}
	port := binary.BigEndian.Uint16(pb)
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(host, jsonNumber(port)), 5*time.Second)
	if err != nil {
		_, _ = client.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer upstream.Close()
	_, _ = client.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0})

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

func jsonNumber(p uint16) string {
	b, _ := json.Marshal(p)
	return string(b)
}
