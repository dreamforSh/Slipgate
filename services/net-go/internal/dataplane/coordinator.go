package dataplane

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

const (
	maxIngressBodyBytes = 16 * 1024 * 1024
	syncWaitBound       = 250 * time.Millisecond
)

// SyncGroupInput matches DataPlaneSyncGroupSchema from @slipgate/contracts.
type SyncGroupInput struct {
	ID               string   `json:"id"`
	Platform         string   `json:"platform"`
	SubscriptionType string   `json:"subscriptionType"`
	RateMultiplier   float64  `json:"rateMultiplier"`
	ModelAllowlist   []string `json:"modelAllowlist"`
	Enabled          bool     `json:"enabled"`
}

// SyncRouteInput matches StoredCompositeRouteSchema from @slipgate/contracts.
type SyncRouteInput struct {
	ID             string `json:"id"`
	GroupID        string `json:"groupId"`
	PublicModel    string `json:"publicModel"`
	MatchType      string `json:"matchType"`
	TargetPlatform string `json:"targetPlatform"`
	UpstreamModel  string `json:"upstreamModel"`
	Endpoint       string `json:"endpoint"`
	Priority       int32  `json:"priority"`
	Enabled        bool   `json:"enabled"`
}

// SyncAccountInput matches DataPlaneSyncAccountSchema from @slipgate/contracts.
type SyncAccountInput struct {
	ID                string `json:"id"`
	GroupID           string `json:"groupId"`
	Platform          string `json:"platform"`
	ExecutionMode     string `json:"executionMode"`
	AuthKind          string `json:"authKind"`
	SubscriptionTier  string `json:"subscriptionTier"`
	TierMultiplier    uint16 `json:"tierMultiplier"`
	CredentialsEncHex string `json:"credentialsEncHex"`
	MaxConcurrency    uint32 `json:"maxConcurrency"`
	Priority          int32  `json:"priority"`
	Status            string `json:"status"`
	Window5hUsedBps   uint16 `json:"window5hUsedBps"`
	Window7dUsedBps   uint16 `json:"window7dUsedBps"`
}

// SyncApiKeyInput matches DataPlaneSyncApiKeySchema from @slipgate/contracts.
type SyncApiKeyInput struct {
	ID               string   `json:"id"`
	UserID           string   `json:"userId"`
	GroupID          string   `json:"groupId"`
	KeyHashHex       string   `json:"keyHashHex"`
	RPMLimit         uint32   `json:"rpmLimit"`
	ConcurrencyLimit uint32   `json:"concurrencyLimit"`
	IPAllowlist      []string `json:"ipAllowlist"`
	Enabled          bool     `json:"enabled"`
	ExpiresAtISO     *string  `json:"expiresAtIso"`
}

// SyncWalletInput matches DataPlaneSyncWalletSchema from @slipgate/contracts.
type SyncWalletInput struct {
	UserID         string `json:"userId"`
	BalanceNanoUSD string `json:"balanceNanoUsd"`
	HeldNanoUSD    string `json:"heldNanoUsd"`
}

// SyncSnapshot matches DataPlaneSyncSnapshotSchema exported by slipgate-bff.
type SyncSnapshot struct {
	RevisionUnixMs int64              `json:"revisionUnixMs"`
	Groups         []SyncGroupInput   `json:"groups"`
	Routes         []SyncRouteInput   `json:"routes"`
	Accounts       []SyncAccountInput `json:"accounts"`
	APIKeys        []SyncApiKeyInput  `json:"apiKeys"`
	Wallets        []SyncWalletInput  `json:"wallets"`
}

// SyncAckResult summarizes the result of applying a DataPlaneSyncSnapshot across Go and Zig.
type SyncAckResult struct {
	OK             bool            `json:"ok"`
	RevisionUnixMs int64           `json:"revisionUnixMs"`
	VaultAccounts  int             `json:"vaultAccounts"`
	CoreAck        json.RawMessage `json:"coreAck,omitempty"`
}

// TurnSettlementEvent matches TurnSettlementEventSchema posted back to slipgate-bff.
type TurnSettlementEvent struct {
	RequestID        string `json:"requestId"`
	UserID           string `json:"userId"`
	APIKeyID         string `json:"apiKeyId"`
	AccountID        string `json:"accountId"`
	GroupID          string `json:"groupId"`
	Platform         string `json:"platform"`
	PublicModel      string `json:"publicModel"`
	UpstreamModel    string `json:"upstreamModel"`
	IngressCodec     string `json:"ingressCodec"`
	EgressCodec      string `json:"egressCodec"`
	InputTokens      uint64 `json:"inputTokens"`
	OutputTokens     uint64 `json:"outputTokens"`
	CacheReadTokens  uint64 `json:"cacheReadTokens"`
	CacheWriteTokens uint64 `json:"cacheWriteTokens"`
	CostNanoUSD      string `json:"costNanoUsd"`
	Window5hUsedBps  uint16 `json:"window5hUsedBps"`
	Window7dUsedBps  uint16 `json:"window7dUsedBps"`
	TTFTMs           uint32 `json:"ttftMs"`
	DurationMs       uint32 `json:"durationMs"`
	StatusCode       int    `json:"statusCode"`
}

// RiskBanEventPayload matches RecordRiskBanInputSchema posted back to slipgate-bff.
type RiskBanEventPayload struct {
	SubjectKind              string `json:"subjectKind"`
	SubjectHash              string `json:"subjectHash"`
	StrikeLevel              uint8  `json:"strikeLevel"`
	BanDuration              string `json:"banDuration"`
	Reason                   string `json:"reason"`
	SourceRequestID          string `json:"sourceRequestId,omitempty"`
	OrdinaryUpstream400Count uint32 `json:"ordinaryUpstream400Count"`
	DowngradedCount          uint32 `json:"downgradedCount"`
}

// NativeTurnTracker enforces slot failover lock once any visible tool delta streams to the caller.
type NativeTurnTracker struct {
	mu              sync.Mutex
	committedToSlot bool
	visibleDeltas   uint32
}

// OnVisibleToolDelta marks the current turn permanently committed to its native VM slot.
func (t *NativeTurnTracker) OnVisibleToolDelta() {
	t.mu.Lock()
	t.committedToSlot = true
	t.visibleDeltas++
	t.mu.Unlock()
}

// CanFailover reports whether the turn may still fail over to another upstream slot.
func (t *NativeTurnTracker) CanFailover() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.committedToSlot
}

// CoordinatorOptions configures the L1 Go DataPlane coordinator.
type CoordinatorOptions struct {
	CoreIPC       string
	BFFOrigin     string
	InternalToken string
	VaultSecret   string
	ClashPool     *clashpool.Manager
	StealthDialer *stealth.AccountDialer
	VMSlots       *vmslot.Manager
	DirectClient  *http.Client
	Logger        *log.Logger
}

// Coordinator bridges HTTP AI ingress, L2 Zig hot-path policy/ledger IPC, three-mode outbound execution, and BFF settlement.
type Coordinator struct {
	coreIPC       string
	bffOrigin     string
	internalToken string
	vault         *Vault
	pool          *clashpool.Manager
	stealth       *stealth.AccountDialer
	vmSlots       *vmslot.Manager
	directClient  *http.Client
	bffClient     *http.Client
	logger        *log.Logger
	streamSeq     atomic.Uint32

	mu                 sync.RWMutex
	keyIPAllowlists    map[string][]string
	accountAuthKinds   map[string]string
	accountTiers       map[string]string
	accountMetas       map[string]accountMeta
	lastCoreSyncJSON   []byte
	lastRevisionUnixMs int64
}

// NewCoordinator constructs a DataPlane Coordinator.
func NewCoordinator(opts CoordinatorOptions) *Coordinator {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	directClient := opts.DirectClient
	if directClient == nil {
		directClient = &http.Client{
			Timeout: 120 * time.Second,
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConns:        64,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     90 * time.Second,
				TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
			},
		}
	}
	bffOrigin := strings.TrimRight(strings.TrimSpace(opts.BFFOrigin), "/")
	if bffOrigin != "" && !strings.HasPrefix(bffOrigin, "http://") && !strings.HasPrefix(bffOrigin, "https://") {
		bffOrigin = "http://" + bffOrigin
	}

	return &Coordinator{
		coreIPC:         opts.CoreIPC,
		bffOrigin:       bffOrigin,
		internalToken:   opts.InternalToken,
		vault:           NewVault(opts.VaultSecret),
		pool:            opts.ClashPool,
		stealth:         opts.StealthDialer,
		vmSlots:         opts.VMSlots,
		directClient:    directClient,
		bffClient:       &http.Client{Timeout: 5 * time.Second},
		logger:           logger,
		keyIPAllowlists:  make(map[string][]string),
		accountAuthKinds: make(map[string]string),
		accountTiers:     make(map[string]string),
		accountMetas:     make(map[string]accountMeta),
	}
}

// Vault exposes the coordinator's in-memory credential vault (used by tests and internal diagnostics).
func (c *Coordinator) Vault() *Vault {
	return c.vault
}

// SyncSnapshot decrypts account credentials into Go's Vault and pushes non-secret routing/auth/wallet state into slipgate-core.
func (c *Coordinator) SyncSnapshot(ctx context.Context, snap SyncSnapshot) (SyncAckResult, error) {
	nextSecrets := make(map[string]AccountSecret, len(snap.Accounts))
	for _, acc := range snap.Accounts {
		if strings.TrimSpace(acc.CredentialsEncHex) == "" {
			continue
		}
		sec, err := c.vault.DecryptHex(acc.CredentialsEncHex)
		if err != nil {
			c.logger.Printf("[dataplane] warning: failed to decrypt credentials for account %s: %v", acc.ID, err)
			continue
		}
		nextSecrets[acc.ID] = sec
	}
	c.vault.ReplaceAll(nextSecrets)

	type coreGroup struct {
		ID                   string   `json:"id"`
		Platform             string   `json:"platform"`
		SubscriptionType     string   `json:"subscriptionType"`
		RateMultiplierMicros uint64   `json:"rateMultiplierMicros"`
		ModelAllowlist       []string `json:"modelAllowlist"`
		Enabled              bool     `json:"enabled"`
	}
	type coreAccount struct {
		ID               string `json:"id"`
		GroupID          string `json:"groupId"`
		Platform         string `json:"platform"`
		ExecutionMode    string `json:"executionMode"`
		AuthKind         string `json:"authKind"`
		SubscriptionTier string `json:"subscriptionTier"`
		TierMultiplier   uint16 `json:"tierMultiplier"`
		MaxConcurrency   uint32 `json:"maxConcurrency"`
		Priority         int32  `json:"priority"`
		Status           string `json:"status"`
		Window5hUsedBps  uint16 `json:"window5hUsedBps"`
		Window7dUsedBps  uint16 `json:"window7dUsedBps"`
	}
	type coreAPIKey struct {
		ID               string `json:"id"`
		UserID           string `json:"userId"`
		GroupID          string `json:"groupId"`
		KeyHashHex       string `json:"keyHashHex"`
		RPMLimit         uint32 `json:"rpmLimit"`
		ConcurrencyLimit uint32 `json:"concurrencyLimit"`
		Enabled          bool   `json:"enabled"`
	}
	type coreWallet struct {
		UserID         string `json:"userId"`
		BalanceNanoUSD string `json:"balanceNanoUsd"`
	}

	coreGroups := make([]coreGroup, 0, len(snap.Groups))
	for _, g := range snap.Groups {
		mult := g.RateMultiplier
		if mult <= 0 {
			mult = 1.0
		}
		allow := g.ModelAllowlist
		if allow == nil {
			allow = []string{}
		}
		coreGroups = append(coreGroups, coreGroup{
			ID:                   g.ID,
			Platform:             g.Platform,
			SubscriptionType:     g.SubscriptionType,
			RateMultiplierMicros: uint64(max(1, int64(math.Round(mult*1_000_000)))),
			ModelAllowlist:       allow,
			Enabled:              g.Enabled,
		})
	}

	nextAuthKinds := make(map[string]string, len(snap.Accounts))
	nextTiers := make(map[string]string, len(snap.Accounts))
	nextMetas := make(map[string]accountMeta, len(snap.Accounts))
	coreAccounts := make([]coreAccount, 0, len(snap.Accounts))
	for _, a := range snap.Accounts {
		authKind := firstNonEmpty(a.AuthKind, "api_key")
		secTier := nextSecrets[a.ID].SubscriptionTier
		subTier := firstNonEmpty(NormalizeSubscriptionTier(a.SubscriptionTier), secTier, "standard")
		tierMult := a.TierMultiplier
		if tierMult == 0 {
			tierMult = SubscriptionTierMultiplier(a.Platform, subTier)
		}
		nextAuthKinds[a.ID] = authKind
		nextTiers[a.ID] = subTier
		nextMetas[a.ID] = accountMeta{
			Platform:         a.Platform,
			ExecutionMode:    a.ExecutionMode,
			AuthKind:         authKind,
			SubscriptionTier: subTier,
			TierMultiplier:   tierMult,
		}
		coreAccounts = append(coreAccounts, coreAccount{
			ID:               a.ID,
			GroupID:          a.GroupID,
			Platform:         a.Platform,
			ExecutionMode:    a.ExecutionMode,
			AuthKind:         authKind,
			SubscriptionTier: subTier,
			TierMultiplier:   tierMult,
			MaxConcurrency:   max(1, a.MaxConcurrency),
			Priority:         a.Priority,
			Status:           a.Status,
			Window5hUsedBps:  a.Window5hUsedBps,
			Window7dUsedBps:  a.Window7dUsedBps,
		})
	}

	now := time.Now()
	nextIPAllowlists := make(map[string][]string)
	coreKeys := make([]coreAPIKey, 0, len(snap.APIKeys))
	for _, k := range snap.APIKeys {
		enabled := k.Enabled
		if enabled && k.ExpiresAtISO != nil && strings.TrimSpace(*k.ExpiresAtISO) != "" {
			if exp, err := time.Parse(time.RFC3339, strings.TrimSpace(*k.ExpiresAtISO)); err == nil && now.After(exp) {
				enabled = false
			}
		}
		if len(k.IPAllowlist) > 0 {
			nextIPAllowlists[k.ID] = append([]string(nil), k.IPAllowlist...)
		}
		coreKeys = append(coreKeys, coreAPIKey{
			ID:               k.ID,
			UserID:           k.UserID,
			GroupID:          k.GroupID,
			KeyHashHex:       strings.ToLower(strings.TrimSpace(k.KeyHashHex)),
			RPMLimit:         max(1, k.RPMLimit),
			ConcurrencyLimit: max(1, k.ConcurrencyLimit),
			Enabled:          enabled,
		})
	}

	coreWallets := make([]coreWallet, 0, len(snap.Wallets))
	for _, w := range snap.Wallets {
		coreWallets = append(coreWallets, coreWallet{
			UserID:         w.UserID,
			BalanceNanoUSD: w.BalanceNanoUSD,
		})
	}

	routes := snap.Routes
	if routes == nil {
		routes = []SyncRouteInput{}
	}

	corePayload, err := json.Marshal(map[string]any{
		"groups":   coreGroups,
		"routes":   routes,
		"accounts": coreAccounts,
		"apiKeys":  coreKeys,
		"wallets":  coreWallets,
	})
	if err != nil {
		return SyncAckResult{}, err
	}

	c.mu.Lock()
	c.keyIPAllowlists = nextIPAllowlists
	c.accountAuthKinds = nextAuthKinds
	c.accountTiers = nextTiers
	c.accountMetas = nextMetas
	c.lastCoreSyncJSON = corePayload
	c.lastRevisionUnixMs = snap.RevisionUnixMs
	c.mu.Unlock()

	res := SyncAckResult{
		OK:             true,
		RevisionUnixMs: snap.RevisionUnixMs,
		VaultAccounts:  len(nextSecrets),
	}

	if strings.TrimSpace(c.coreIPC) == "" {
		return res, nil
	}

	ipcCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	reply, err := dpbridge.Exchange(ipcCtx, c.coreIPC, dpbridge.Frame{
		StreamID: c.streamSeq.Add(1),
		Type:     dpbridge.FrameSyncState,
		Flags:    dpbridge.FlagEndStream,
		Payload:  corePayload,
	})
	if err != nil {
		return res, fmt.Errorf("dataplane: sync slipgate-core IPC failed: %w", err)
	}
	if json.Valid(reply.Payload) {
		res.CoreAck = json.RawMessage(reply.Payload)
	}
	return res, nil
}

// PullSnapshotFromBFF fetches the latest DataPlaneSyncSnapshot from slipgate-bff and applies it to Vault + slipgate-core.
func (c *Coordinator) PullSnapshotFromBFF(ctx context.Context) error {
	if c.bffOrigin == "" || c.internalToken == "" {
		return nil
	}
	reqCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, c.bffOrigin+"/api/v1/internal/dataplane/snapshot", nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)

	resp, err := c.bffClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("bff snapshot status %d", resp.StatusCode)
	}

	var snap SyncSnapshot
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&snap); err != nil {
		return err
	}
	_, err = c.SyncSnapshot(ctx, snap)
	return err
}

// StartBackgroundSync reconciles ControlPlane snapshot state with slipgate-bff and slipgate-core on startup and every 15s.
func (c *Coordinator) StartBackgroundSync(ctx context.Context) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	go func() {
		// Fast startup convergence loop while BFF and Core finish booting.
		for attempt := range 10 {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if err := c.PullSnapshotFromBFF(ctx); err == nil {
				break
			}
			wait := time.Duration(min(2000, 250*(attempt+1))) * time.Millisecond
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = c.PullSnapshotFromBFF(ctx)
			}
		}
	}()
}

type coreTurnEvalRequest struct {
	RequestID            string `json:"requestId"`
	Method               string `json:"method"`
	Path                 string `json:"path"`
	APIKey               string `json:"apiKey"`
	ClientIP             string `json:"clientIp"`
	Model                string `json:"model"`
	Stream               bool   `json:"stream"`
	MaxTokens            uint64 `json:"maxTokens"`
	EstimatedInputTokens uint64 `json:"estimatedInputTokens"`
	BodyExcerpt          string `json:"bodyExcerpt"`
	NowUnixMs            int64  `json:"nowUnixMs"`
}

type coreDispatchDirective struct {
	Engine        string   `json:"engine"`
	Action        string   `json:"action"`
	Status        int      `json:"status"`
	HoldID        uint64   `json:"holdId"`
	UserID        string   `json:"userId"`
	APIKeyID      string   `json:"apiKeyId"`
	GroupID       string   `json:"groupId"`
	AccountID     string   `json:"accountId"`
	Provider         string   `json:"provider"`
	ExecutionMode    string   `json:"executionMode"`
	AuthKind         string   `json:"authKind"`
	SubscriptionTier string   `json:"subscriptionTier"`
	TierMultiplier   uint16   `json:"tierMultiplier"`
	PublicModel      string   `json:"publicModel"`
	UpstreamModel string   `json:"upstreamModel"`
	CleanseMode   string   `json:"cleanseMode"`
	HoldNanoUSD   string   `json:"holdNanoUsd"`
	Models        []string `json:"models"`
	ErrorType     string   `json:"errorType"`
	ErrorCode     string   `json:"errorCode"`
	Message       string   `json:"message"`
	RiskTriggered bool     `json:"riskTriggered"`
	SubjectKind   string   `json:"subjectKind"`
	SubjectHash   string   `json:"subjectHash"`
	StrikeLevel   uint8    `json:"strikeLevel"`
	BanDuration   string   `json:"banDuration"`
}

type coreSettleReport struct {
	HoldID           uint64 `json:"holdId"`
	UpstreamStatus   uint16 `json:"upstreamStatus"`
	InputTokens      uint64 `json:"inputTokens"`
	OutputTokens     uint64 `json:"outputTokens"`
	CacheReadTokens  uint64 `json:"cacheReadTokens"`
	CacheWriteTokens uint64 `json:"cacheWriteTokens"`
	Window5hUsedBps  uint16 `json:"window5hUsedBps"`
	Window7dUsedBps  uint16 `json:"window7dUsedBps"`
}

type coreSettleAck struct {
	OK                          bool   `json:"ok"`
	SettledCostNanoUSD          string `json:"settledCostNanoUsd"`
	BalanceAfterNanoUSD         string `json:"balanceAfterNanoUsd"`
	OrdinaryUpstream400Exempted bool   `json:"ordinaryUpstream400Exempted"`
}

// HandleHTTP serves /v1/*, /v1beta/*, and /mcp/* strictly on the DataPlane (Go <-> Zig IPC, zero BFF hot path).
func (c *Coordinator) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	w.Header().Set("X-Slipgate-Plane", "dataplane-direct")

	streamID := c.streamSeq.Add(1)
	requestID := sanitizeRequestID(r.Header.Get("X-Request-Id"), streamID)
	w.Header().Set("X-Request-Id", requestID)

	ingressCodec, _, _ := DetectIngressCodec(r.URL.Path, r.URL.RawQuery)

	var rawBody []byte
	if r.Body != nil {
		var readErr error
		rawBody, readErr = io.ReadAll(io.LimitReader(r.Body, maxIngressBodyBytes+1))
		if readErr != nil {
			WriteProtocolError(w, ingressCodec, http.StatusBadRequest, "invalid_request_error", "body_read_failed", readErr.Error())
			return
		}
		if len(rawBody) > maxIngressBodyBytes {
			WriteProtocolError(w, ingressCodec, http.StatusRequestEntityTooLarge, "invalid_request_error", "payload_too_large", "request body exceeds 16 MiB limit")
			return
		}
	}

	isModelsReq := r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/models")
	var turn *CanonicalTurn
	if isModelsReq {
		turn = &CanonicalTurn{
			IngressCodec: CodecOpenAIChat,
			MaxTokens:    64,
		}
	} else {
		var parseErr error
		turn, parseErr = ParseIngressRequest(r.URL.Path, r.URL.RawQuery, rawBody)
		if parseErr != nil {
			WriteProtocolError(w, ingressCodec, http.StatusBadRequest, "invalid_request_error", "malformed_json", parseErr.Error())
			return
		}
	}

	clientIP := extractClientIP(r)
	evalPayload, _ := json.Marshal(coreTurnEvalRequest{
		RequestID:            requestID,
		Method:               r.Method,
		Path:                 r.URL.Path,
		APIKey:               extractAPIKey(r),
		ClientIP:             clientIP,
		Model:                turn.PublicModel,
		Stream:               turn.Stream,
		MaxTokens:            turn.MaxTokens,
		EstimatedInputTokens: turn.EstimatedInputTokens,
		BodyExcerpt:          turn.BodyExcerpt,
		NowUnixMs:            startedAt.UnixMilli(),
	})

	ipcCtx, ipcCancel := context.WithTimeout(r.Context(), 5*time.Second)
	replyFrame, ipcErr := dpbridge.Exchange(ipcCtx, c.coreIPC, dpbridge.Frame{
		StreamID: streamID,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  evalPayload,
	})
	ipcCancel()
	if ipcErr != nil {
		WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "core_unavailable", "core_unreachable", "slipgate-core dataplane unreachable: "+ipcErr.Error())
		return
	}

	var directive coreDispatchDirective
	_ = json.Unmarshal(replyFrame.Payload, &directive)

	// Preserve compatibility with lightweight IPC listeners that emit raw FrameDispatchDirective payloads without an engine action.
	if directive.Action == "" {
		rawDirective := replyFrame.Payload
		if !json.Valid(rawDirective) {
			rawDirective, _ = json.Marshal(string(replyFrame.Payload))
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"object":    "slipgate.dataplane.dispatch",
			"stream_id": replyFrame.StreamID,
			"frame":     fmt.Sprintf("0x%02x", replyFrame.Type),
			"directive": json.RawMessage(rawDirective),
		})
		return
	}

	switch directive.Action {
	case "models":
		items := make([]map[string]any, 0, len(directive.Models))
		for _, id := range directive.Models {
			items = append(items, map[string]any{
				"id":       id,
				"object":   "model",
				"created":  1735689600,
				"owned_by": "slipgate",
			})
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"object": "list",
			"data":   items,
		})
		return

	case "reject":
		if directive.RiskTriggered && directive.SubjectHash != "" {
			c.postRiskEventBounded(RiskBanEventPayload{
				SubjectKind:     firstNonEmpty(directive.SubjectKind, "api_key"),
				SubjectHash:     directive.SubjectHash,
				StrikeLevel:     max(1, directive.StrikeLevel),
				BanDuration:     normalizeBanDuration(directive.BanDuration),
				Reason:          firstNonEmpty(directive.ErrorCode, "pre_hop_risk_gate"),
				SourceRequestID: requestID,
			})
		}
		WriteProtocolError(w, turn.IngressCodec, directive.Status, directive.ErrorType, directive.ErrorCode, directive.Message)
		return

	case "dispatch":
		// Continue below to execute three-mode upstream dispatch and guaranteed settlement.
	default:
		WriteProtocolError(w, turn.IngressCodec, http.StatusBadGateway, "ipc_error", "unknown_core_action", "unexpected slipgate-core action: "+directive.Action)
		return
	}

	var settled atomic.Bool
	settleHold := func(metrics RelayMetrics) coreSettleAck {
		if directive.HoldID == 0 || !settled.CompareAndSwap(false, true) {
			return coreSettleAck{}
		}
		statusU16 := uint16(http.StatusInternalServerError)
		if metrics.UpstreamStatus > 0 && metrics.UpstreamStatus <= 599 {
			statusU16 = uint16(metrics.UpstreamStatus)
		}
		reportRaw, _ := json.Marshal(coreSettleReport{
			HoldID:           directive.HoldID,
			UpstreamStatus:   statusU16,
			InputTokens:      metrics.InputTokens,
			OutputTokens:     metrics.OutputTokens,
			CacheReadTokens:  metrics.CacheReadTokens,
			CacheWriteTokens: metrics.CacheWriteTokens,
			Window5hUsedBps:  metrics.Window5hUsedBps,
			Window7dUsedBps:  metrics.Window7dUsedBps,
		})
		settleCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		ackFrame, err := dpbridge.Exchange(settleCtx, c.coreIPC, dpbridge.Frame{
			StreamID: c.streamSeq.Add(1),
			Type:     dpbridge.FrameSettleReport,
			Flags:    dpbridge.FlagEndStream,
			Payload:  reportRaw,
		})
		if err != nil {
			c.logger.Printf("[dataplane] warning: hold %d settle IPC failed: %v", directive.HoldID, err)
			return coreSettleAck{SettledCostNanoUSD: "0"}
		}
		var ack coreSettleAck
		_ = json.Unmarshal(ackFrame.Payload, &ack)
		if ack.SettledCostNanoUSD == "" {
			ack.SettledCostNanoUSD = "0"
		}
		return ack
	}
	defer func() {
		// Safety net if an early return or panic occurred before explicit settlement.
		settleHold(RelayMetrics{UpstreamStatus: http.StatusInternalServerError})
	}()

	if !c.isClientIPAllowed(directive.APIKeyID, clientIP) {
		settleHold(RelayMetrics{UpstreamStatus: http.StatusForbidden})
		WriteProtocolError(w, turn.IngressCodec, http.StatusForbidden, "permission_error", "ip_not_allowed", "client IP is not in API key allowlist")
		return
	}

	if turn.IsMetadataOnlyMCP() {
		WriteMCPMetadataResponse(w, turn)
		settleHold(RelayMetrics{UpstreamStatus: http.StatusOK})
		return
	}

	secret, hasSecret := c.vault.Get(directive.AccountID)
	if !hasSecret {
		settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
		WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", "account_secret_unavailable", "upstream account credentials not yet synchronized in vault")
		return
	}

	cleanseMode := firstNonEmpty(directive.CleanseMode, "zero")
	tracker := &NativeTurnTracker{}
	subTier := firstNonEmpty(
		NormalizeSubscriptionTier(directive.SubscriptionTier),
		c.accountTier(directive.AccountID),
		secret.SubscriptionTier,
		"standard",
	)
	tierMult := directive.TierMultiplier
	if tierMult == 0 {
		tierMult = SubscriptionTierMultiplier(directive.Provider, subTier)
	}
	pctx := OutboundPersonaContext{
		Provider:         directive.Provider,
		AuthKind:         firstNonEmpty(directive.AuthKind, c.accountAuthKind(directive.AccountID)),
		SubscriptionTier: subTier,
		TierMultiplier:   tierMult,
		ExecutionMode:    directive.ExecutionMode,
		AccountID:        directive.AccountID,
		CleanseMode:      cleanseMode,
		RequestID:        requestID,
	}

	if directive.ExecutionMode == "vm_slot" {
		if c.vmSlots == nil {
			settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
			WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", "vm_fleet_unavailable", "VM slot manager is not attached")
			return
		}
		slot, ok := c.vmSlots.GetSlotByAccount(directive.AccountID)
		if !ok {
			settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
			WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", "vm_slot_not_provisioned", "no VM slot provisioned for selected vm_slot account")
			return
		}
		if err := c.vmSlots.AcquireSubagentSeat(slot.ID); err != nil {
			status := http.StatusServiceUnavailable
			code := "vm_slot_not_ready"
			if errors.Is(err, vmslot.ErrSubagentCapacityFull) {
				status = http.StatusTooManyRequests
				code = "vm_subagent_capacity_full"
			}
			settleHold(RelayMetrics{UpstreamStatus: status})
			WriteProtocolError(w, turn.IngressCodec, status, "overloaded_error", code, err.Error())
			return
		}
		defer func() { _ = c.vmSlots.ReleaseSubagentSeat(slot.ID) }()

		if strings.TrimSpace(slot.GuestUDSPath) != "" {
			pingCtx, pingCancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
			pingErr := dpbridge.Ping(pingCtx, slot.GuestUDSPath)
			pingCancel()
			if pingErr != nil {
				settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
				WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", "vm_guestd_unreachable", "slipgate-guestd failed health check: "+pingErr.Error())
				return
			}
		}
		if strings.TrimSpace(slot.CleanseMode) != "" {
			cleanseMode = slot.CleanseMode
		}
		pctx.CleanseMode = cleanseMode
		pctx.GuestMachineID = slot.Persona.GuestMachineID
		pctx.RuntimeProfile = string(slot.RuntimeProfile)
		w.Header().Set("X-Slipgate-VM-Slot", slot.ID)
		if slot.RuntimeProfile != "" {
			w.Header().Set("X-Slipgate-VM-Runtime", string(slot.RuntimeProfile))
		}
	}

	w.Header().Set("X-Slipgate-Execution-Mode", directive.ExecutionMode)
	w.Header().Set("X-Slipgate-Provider", directive.Provider)
	w.Header().Set("X-Slipgate-Subscription-Tier", subTier)

	upstreamReq, egressCodec, buildErr := BuildUpstreamHTTPRequestWithPersona(
		r.Context(),
		pctx,
		directive.UpstreamModel,
		secret,
		turn,
	)
	if buildErr != nil {
		settleHold(RelayMetrics{UpstreamStatus: http.StatusBadRequest})
		WriteProtocolError(w, turn.IngressCodec, http.StatusBadRequest, "invalid_request_error", "request_transcode_failed", buildErr.Error())
		return
	}

	upstreamResp, execErr := c.executeOutbound(r.Context(), pctx, secret, upstreamReq, directive.UpstreamModel, egressCodec, turn)
	if execErr != nil {
		settleHold(RelayMetrics{UpstreamStatus: http.StatusBadGateway})
		WriteProtocolError(w, turn.IngressCodec, http.StatusBadGateway, "upstream_error", "outbound_dispatch_failed", execErr.Error())
		return
	}
	defer upstreamResp.Body.Close()

	metrics, relayErr := RelayAndTranscodeResponse(
		w,
		upstreamResp,
		egressCodec,
		turn,
		directive.PublicModel,
		cleanseMode,
		startedAt,
		tracker.OnVisibleToolDelta,
	)
	if relayErr != nil {
		c.logger.Printf("[dataplane] warning: stream relay interrupted on %s: %v", requestID, relayErr)
	}

	ack := settleHold(metrics)
	durationMs := elapsedMs(startedAt)

	c.postSettlementBounded(TurnSettlementEvent{
		RequestID:        requestID,
		UserID:           directive.UserID,
		APIKeyID:         directive.APIKeyID,
		AccountID:        directive.AccountID,
		GroupID:          directive.GroupID,
		Platform:         directive.Provider,
		PublicModel:      directive.PublicModel,
		UpstreamModel:    directive.UpstreamModel,
		IngressCodec:     string(turn.IngressCodec),
		EgressCodec:      string(egressCodec),
		InputTokens:      metrics.InputTokens,
		OutputTokens:     metrics.OutputTokens,
		CacheReadTokens:  metrics.CacheReadTokens,
		CacheWriteTokens: metrics.CacheWriteTokens,
		CostNanoUSD:      firstNonEmpty(ack.SettledCostNanoUSD, "0"),
		Window5hUsedBps:  metrics.Window5hUsedBps,
		Window7dUsedBps:  metrics.Window7dUsedBps,
		TTFTMs:           metrics.TTFTMs,
		DurationMs:       durationMs,
		StatusCode:       metrics.UpstreamStatus,
	})
}

func (c *Coordinator) executeOutbound(
	ctx context.Context,
	pctx OutboundPersonaContext,
	secret AccountSecret,
	req *http.Request,
	upstreamModel string,
	egressCodec CodecKind,
	turn *CanonicalTurn,
) (*http.Response, error) {
	switch pctx.ExecutionMode {
	case "stealth_http", "vm_slot":
		// Fail-closed: stealth_http and vm_slot ALWAYS require a healthy bound Clash exit node.
		if c.pool != nil {
			if _, err := c.pool.ResolveDialTarget(pctx.AccountID); err != nil {
				return nil, fmt.Errorf("fail-closed egress guard (%s): %w", pctx.ExecutionMode, err)
			}
		}
		if secret.IsMock() {
			return ExecuteMockTurn(secret.EffectiveMockTarget(), upstreamModel, egressCodec, turn), nil
		}
		if c.stealth == nil {
			return nil, errors.New("stealth uTLS dialer is not configured")
		}
		utlsProfileID := strings.TrimSpace(secret.UTLSProfileID)
		if utlsProfileID == "" && c.pool != nil {
			if binding, ok := c.pool.GetBinding(pctx.AccountID); ok && strings.TrimSpace(binding.UTLSProfileID) != "" {
				utlsProfileID = strings.TrimSpace(binding.UTLSProfileID)
			}
		}
		if utlsProfileID == "" {
			utlsProfileID = stealth.DefaultProfileForProvider(pctx.Provider, pctx.AuthKind)
		}
		out, err := c.stealth.DoAccountRequest(ctx, pctx.AccountID, utlsProfileID, req)
		if err != nil {
			return nil, err
		}
		return out.Response, nil

	default:
		if secret.IsMock() {
			return ExecuteMockTurn(secret.EffectiveMockTarget(), upstreamModel, egressCodec, turn), nil
		}
		return c.directClient.Do(req)
	}
}

func (c *Coordinator) accountAuthKind(accountID string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accountAuthKinds[accountID]
}

func (c *Coordinator) accountTier(accountID string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accountTiers[accountID]
}

func (c *Coordinator) isClientIPAllowed(apiKeyID, clientIP string) bool {
	c.mu.RLock()
	allow := c.keyIPAllowlists[apiKeyID]
	c.mu.RUnlock()
	if len(allow) == 0 {
		return true
	}
	parsedIP := net.ParseIP(clientIP)
	for _, entry := range allow {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if trimmed == clientIP {
			return true
		}
		if parsedIP != nil {
			if _, cidr, err := net.ParseCIDR(trimmed); err == nil && cidr.Contains(parsedIP) {
				return true
			}
		}
	}
	return false
}

func (c *Coordinator) postSettlementBounded(ev TurnSettlementEvent) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	c.postInternalJSONBounded("/api/v1/internal/dataplane/settlement", ev)
}

func (c *Coordinator) postRiskEventBounded(ev RiskBanEventPayload) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	c.postInternalJSONBounded("/api/v1/internal/dataplane/risk-events", ev)
}

func (c *Coordinator) postInternalJSONBounded(path string, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, c.bffOrigin+path, bytes.NewReader(raw))
		if reqErr != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
		resp, doErr := c.bffClient.Do(req)
		if doErr != nil {
			c.logger.Printf("[dataplane] warning: POST %s failed: %v", path, doErr)
			return
		}
		_ = resp.Body.Close()
	}()

	timer := time.NewTimer(syncWaitBound)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

func extractAPIKey(r *http.Request) string {
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
			return strings.TrimSpace(auth[7:])
		}
	}
	if xKey := strings.TrimSpace(r.Header.Get("x-api-key")); xKey != "" {
		return xKey
	}
	if gKey := strings.TrimSpace(r.Header.Get("x-goog-api-key")); gKey != "" {
		return gKey
	}
	if qKey := strings.TrimSpace(r.URL.Query().Get("key")); qKey != "" {
		return qKey
	}
	return ""
}

func extractClientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx > 0 {
			return strings.TrimSpace(xff[:idx])
		}
		return xff
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func sanitizeRequestID(raw string, seq uint32) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) >= 4 && len(trimmed) <= 96 {
		valid := true
		for i := range len(trimmed) {
			ch := trimmed[i]
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
				valid = false
				break
			}
		}
		if valid {
			return trimmed
		}
	}
	return fmt.Sprintf("req_%d_%d", time.Now().UnixMilli(), seq)
}

func normalizeBanDuration(d string) string {
	switch d {
	case "10m", "24h", "permanent":
		return d
	default:
		return "10m"
	}
}
