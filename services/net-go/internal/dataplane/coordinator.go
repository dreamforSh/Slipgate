package dataplane

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
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
	ID                    string `json:"id"`
	GroupID               string `json:"groupId"`
	Platform              string `json:"platform"`
	ExecutionMode         string `json:"executionMode"`
	AuthKind              string `json:"authKind"`
	SubscriptionTier      string `json:"subscriptionTier"`
	TierMultiplier        uint16 `json:"tierMultiplier"`
	CredentialsEncHex     string `json:"credentialsEncHex"`
	MaxConcurrency        uint32 `json:"maxConcurrency"`
	Priority              int32  `json:"priority"`
	Status                string `json:"status"`
	Window5hUsedBps       uint16 `json:"window5hUsedBps"`
	Window7dUsedBps       uint16 `json:"window7dUsedBps"`
	Window5hResetAtUnixMs int64  `json:"window5hResetAtUnixMs,omitempty"`
	Window7dResetAtUnixMs int64  `json:"window7dResetAtUnixMs,omitempty"`
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
	// IPDenylist blocks matching client IPs/CIDRs; it wins over IPAllowlist.
	IPDenylist   []string `json:"ipDenylist"`
	Enabled      bool     `json:"enabled"`
	ExpiresAtISO *string  `json:"expiresAtIso"`
}

// SyncWalletInput matches DataPlaneSyncWalletSchema from @slipgate/contracts.
type SyncWalletInput struct {
	UserID         string `json:"userId"`
	BalanceNanoUSD string `json:"balanceNanoUsd"`
	HeldNanoUSD    string `json:"heldNanoUsd"`
}

// SyncPriceRuleInput matches DataPlaneSyncPriceRuleSchema: an enabled admin price rule in nano-USD
// per 1M tokens, forwarded to slipgate-core so its holds and settlements use the billed prices.
type SyncPriceRuleInput struct {
	Pattern                              string `json:"pattern"`
	InputNanoPerMTok                     string `json:"inputNanoPerMTok"`
	OutputNanoPerMTok                    string `json:"outputNanoPerMTok"`
	CacheReadNanoPerMTok                 string `json:"cacheReadNanoPerMTok"`
	CacheWriteNanoPerMTok                string `json:"cacheWriteNanoPerMTok"`
	PerRequestNanoUSD                    string `json:"perRequestNanoUsd,omitempty"`
	PerImageNanoUSD                      string `json:"perImageNanoUsd,omitempty"`
	PerVideoSecondNanoUSD                string `json:"perVideoSecondNanoUsd,omitempty"`
	LongContextThresholdTokens           uint64 `json:"longContextThresholdTokens,omitempty"`
	LongContextInputMultiplierMicros     uint64 `json:"longContextInputMultiplierMicros,omitempty"`
	LongContextOutputMultiplierMicros    uint64 `json:"longContextOutputMultiplierMicros,omitempty"`
	ServiceTierFastMultiplierMicros      uint64 `json:"serviceTierFastMultiplierMicros,omitempty"`
	ServiceTierFlexMultiplierMicros      uint64 `json:"serviceTierFlexMultiplierMicros,omitempty"`
	ReasoningEffortLowMultiplierMicros    uint64 `json:"reasoningEffortLowMultiplierMicros,omitempty"`
	ReasoningEffortMediumMultiplierMicros uint64 `json:"reasoningEffortMediumMultiplierMicros,omitempty"`
	ReasoningEffortHighMultiplierMicros   uint64 `json:"reasoningEffortHighMultiplierMicros,omitempty"`
	ReasoningEffortXhighMultiplierMicros  uint64 `json:"reasoningEffortXhighMultiplierMicros,omitempty"`
}

// SyncRiskBanInput matches DataPlaneSyncRiskBanSchema: an active risk ban restored into slipgate-core.
type SyncRiskBanInput struct {
	SubjectKind       string `json:"subjectKind"`
	SubjectHash       string `json:"subjectHash"`
	StrikeLevel       uint8  `json:"strikeLevel"`
	BannedUntilUnixMs int64  `json:"bannedUntilUnixMs"`
}

// SyncSnapshot matches DataPlaneSyncSnapshotSchema exported by slipgate-bff.
type SyncSnapshot struct {
	RevisionUnixMs   int64                 `json:"revisionUnixMs"`
	Groups           []SyncGroupInput      `json:"groups"`
	Routes           []SyncRouteInput      `json:"routes"`
	Accounts         []SyncAccountInput    `json:"accounts"`
	APIKeys          []SyncApiKeyInput     `json:"apiKeys"`
	Wallets          []SyncWalletInput     `json:"wallets"`
	PriceRules       []SyncPriceRuleInput  `json:"priceRules"`
	RiskBans            []SyncRiskBanInput     `json:"riskBans"`
	ClearedRiskSubjects []string               `json:"clearedRiskSubjects,omitempty"`
	ClearAllRiskBans    bool                   `json:"clearAllRiskBans,omitempty"`
	UserLimits          *SyncUserLimitsInput   `json:"userLimits"` // enforced in user_limits.go
	DiscoveredModels    map[string][]string    `json:"discoveredModels,omitempty"`
	Moderation          *SyncModerationInput   `json:"moderation,omitempty"`
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
	// SettlementID is minted here once per settled turn and reused on every redelivery: it is the
	// BFF's billing idempotency key. RequestID is the caller's X-Request-Id (correlation only).
	SettlementID string `json:"settlementId"`
	// CoreSettled is false when slipgate-core did not settle the hold (IPC failure, or the hold
	// was lost in a core restart); CostNanoUSD is then "0" and the BFF prices the tokens itself.
	CoreSettled      bool   `json:"coreSettled"`
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
	Window5hUsedBps       uint16  `json:"window5hUsedBps"`
	Window7dUsedBps       uint16  `json:"window7dUsedBps"`
	Window5hResetAtUnixMs int64   `json:"window5hResetAtUnixMs,omitempty"`
	Window7dResetAtUnixMs int64   `json:"window7dResetAtUnixMs,omitempty"`
	ServiceTier           string  `json:"serviceTier,omitempty"`
	ReasoningEffort       string  `json:"reasoningEffort,omitempty"`
	ImageCount            uint32  `json:"imageCount,omitempty"`
	VideoSeconds          float64 `json:"videoSeconds,omitempty"`
	TTFTMs                uint32  `json:"ttftMs"`
	DurationMs            uint32  `json:"durationMs"`
	StatusCode            int     `json:"statusCode"`
	// CoreHoldID is read back by the edge once the BFF accepts the settlement, to tell
	// slipgate-core that this hold's local debit is now committed (the BFF ignores it).
	CoreHoldID uint64 `json:"coreHoldId,omitempty"`
	// CoreRateMultiplierMicros is the rate slipgate-core priced CostNanoUSD at (settled turns only).
	CoreRateMultiplierMicros uint64 `json:"coreRateMultiplierMicros,omitempty"`
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
	// AllowPrivateUpstreams permits loopback/RFC1918 targets on direct_api upstreams (local tests/dev only).
	AllowPrivateUpstreams bool
	// TrustedProxies controls which peers may supply X-Forwarded-For / X-Real-IP (nil = SLIPGATE_TRUSTED_PROXIES env).
	TrustedProxies *netguard.TrustedProxies
	// AccessLogEnabled reports whether each turn should write an "[http.access]" line (the BFF
	// persists access logs; cmd/slipgate passes the system-log forwarder's flag). Nil = never.
	AccessLogEnabled func() bool
	// SettlementSpoolDir keeps undelivered settlements across restarts (defaults to the
	// SLIPGATE_SETTLEMENT_SPOOL_DIR environment variable; empty or "off" = in-memory retry queue
	// only). cmd/slipgate always passes one (see ResolveSettlementSpoolDir).
	SettlementSpoolDir string
	// UpstreamTimeouts bounds the header wait and stream stalls of every AI upstream call (zero
	// values = unbounded; cmd/slipgate passes SLIPGATE_UPSTREAM_*_TIMEOUT_SEC).
	UpstreamTimeouts UpstreamTimeouts
	// GuestToken authenticates host->slipgate-guestd IPC frames (defaults to SLIPGATE_GUEST_TOKEN env).
	GuestToken string
}

// Coordinator bridges HTTP AI ingress, L2 Zig hot-path policy/ledger IPC, three-mode outbound execution, and BFF settlement.
type Coordinator struct {
	coreIPC               string
	bffOrigin             string
	internalToken         string
	vault                 *Vault
	pool                  *clashpool.Manager
	stealth               *stealth.AccountDialer
	vmSlots               *vmslot.Manager
	directClient          *http.Client
	upstreamTimeouts      UpstreamTimeouts
	bffClient             *http.Client
	allowPrivateUpstreams bool
	trustedProxies        *netguard.TrustedProxies
	logger                *log.Logger
	streamSeq             atomic.Uint32
	settlements           *settlementOutbox
	requestErrors         *requestErrorWorker
	confirmOnce           sync.Once
	confirms              chan settleConfirm

	// accessLogEnabled gates the per-turn http.access line (turn_log.go).
	accessLogEnabled func() bool

	mu                 sync.RWMutex
	keyByHash          map[string]edgeKeyMeta
	groupPlatforms     map[string]string
	keyIPAllowlists    map[string][]string
	keyIPDenylists     map[string][]string
	accountAuthKinds   map[string]string
	accountTiers       map[string]string
	accountMetas       map[string]accountMeta
	lastCoreSyncJSON   []byte
	lastRevisionUnixMs int64
	userLimits         userLimitGate  // per-user / per-group caps (user_limits.go)
	moderation         moderationGate // prompt moderation rules & external gate (moderation.go)
	oauthRefresher     oauthRefreshDeduper
	vertexTokens       *VertexTokenCache
	guestToken         string
	responsesState     responseStateStore
	mediaTasks         mediaTaskStore
	modelCatalog       modelCatalogCache
	protocolCatalog    modelProtocolCatalog

	// snapshotApplied: keyByHash holds the same key set slipgate-core authenticates against.
	snapshotApplied bool
}

// NewCoordinator constructs a DataPlane Coordinator.
func NewCoordinator(opts CoordinatorOptions) *Coordinator {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	allowPrivate := opts.AllowPrivateUpstreams || netguard.AllowPrivateUpstreamsFromEnv()
	directClient := opts.DirectClient
	if directClient == nil {
		// No whole-request deadline: UpstreamTimeouts bounds the header wait and stream stalls.
		directClient = netguard.NewSafeHTTPClient(0, allowPrivate)
	}
	trustedProxies := opts.TrustedProxies
	if trustedProxies == nil {
		trustedProxies = netguard.ParseTrustedProxiesFromEnv()
	}
	guestToken := strings.TrimSpace(opts.GuestToken)
	if guestToken == "" {
		guestToken = strings.TrimSpace(os.Getenv("SLIPGATE_GUEST_TOKEN"))
	}
	bffOrigin := strings.TrimRight(strings.TrimSpace(opts.BFFOrigin), "/")
	if bffOrigin != "" && !strings.HasPrefix(bffOrigin, "http://") && !strings.HasPrefix(bffOrigin, "https://") {
		bffOrigin = "http://" + bffOrigin
	}

	c := &Coordinator{
		coreIPC:               opts.CoreIPC,
		bffOrigin:             bffOrigin,
		internalToken:         opts.InternalToken,
		vault:                 NewVault(opts.VaultSecret),
		pool:                  opts.ClashPool,
		stealth:               opts.StealthDialer,
		vmSlots:               opts.VMSlots,
		directClient:          directClient,
		upstreamTimeouts:      opts.UpstreamTimeouts,
		bffClient:             &http.Client{Timeout: 5 * time.Second},
		allowPrivateUpstreams: allowPrivate,
		trustedProxies:        trustedProxies,
		logger:                logger,
		accessLogEnabled:      opts.AccessLogEnabled,
		vertexTokens:          NewVertexTokenCache(),
		guestToken:            guestToken,
		keyByHash:             make(map[string]edgeKeyMeta),
		groupPlatforms:   make(map[string]string),
		keyIPAllowlists:  make(map[string][]string),
		keyIPDenylists:   make(map[string][]string),
		accountAuthKinds: make(map[string]string),
		accountTiers:     make(map[string]string),
		accountMetas:     make(map[string]accountMeta),
	}
	if bffOrigin != "" && opts.InternalToken != "" {
		c.responsesState.persistPut = c.persistResponseStatePut
		c.responsesState.persistGet = c.persistResponseStateGet
		c.responsesState.persistDelete = c.persistResponseStateDelete
		c.mediaTasks.persistPut = c.persistMediaTaskPut
		c.mediaTasks.persistGet = c.persistMediaTaskGet
	}
	spoolDir := strings.TrimSpace(opts.SettlementSpoolDir)
	if spoolDir == "" {
		spoolDir = strings.TrimSpace(os.Getenv(SettlementSpoolDirEnv))
	}
	c.settlements = newSettlementOutbox(c.postSettlementOnce, logger, spoolDir)
	c.requestErrors = newRequestErrorWorker(c.postRequestErrorsBatch)
	if c.settlements.spoolDir != "" {
		logger.Printf("[dataplane] settlement spool: %s", c.settlements.spoolDir)
	}
	if bffOrigin != "" && opts.InternalToken != "" {
		c.settlements.loadSpool()
	}
	return c
}

// FlushSettlements runs on shutdown once the edge has stopped serving turns, while slipgate-bff is
// still up: it waits for settlement deliveries in flight and retries queued ones until ctx ends or
// the BFF turns out to be down. Whatever is left stays in the spool for the next start.
func (c *Coordinator) FlushSettlements(ctx context.Context) {
	left := c.settlements.flush(ctx)
	if left == 0 {
		return
	}
	if c.settlements.spoolDir != "" {
		c.logger.Printf("[dataplane] %d undelivered settlement(s) kept in %s for the next start", left, c.settlements.spoolDir)
		return
	}
	c.logger.Printf("[dataplane] error: %d undelivered settlement(s) lost at shutdown: the settlement spool is off (%s)", left, SettlementSpoolDirEnv)
}

// SettlementDeadLetters reports how many settlements the BFF rejected or that aged out undelivered
// are parked in the spool's dead-letter directory.
func (c *Coordinator) SettlementDeadLetters() int {
	return c.settlements.deadLetterCount()
}

// ReplaySettlementDeadLetters queues every parked settlement for delivery again (after the cause
// of the rejection is fixed) and returns how many were queued.
func (c *Coordinator) ReplaySettlementDeadLetters() (int, error) {
	return c.settlements.replayDeadLetters()
}

// postSettlementOnce makes one settlement POST and reports the BFF's status code.
func (c *Coordinator) postSettlementOnce(ctx context.Context, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.bffOrigin+"/api/v1/internal/dataplane/settlement", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	resp, err := c.bffClient.Do(req)
	if err != nil {
		return 0, err
	}
	// Read fully so the keep-alive connection is reused.
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		c.confirmDeliveredSettlement(body, answer)
	}
	return resp.StatusCode, nil
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
			c.logEvent("warn", fmt.Sprintf("failed to decrypt credentials: %v", err), "account_id", acc.ID)
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
		ID                    string `json:"id"`
		GroupID               string `json:"groupId"`
		Platform              string `json:"platform"`
		ExecutionMode         string `json:"executionMode"`
		AuthKind              string `json:"authKind"`
		SubscriptionTier      string `json:"subscriptionTier"`
		TierMultiplier        uint16 `json:"tierMultiplier"`
		MaxConcurrency        uint32 `json:"maxConcurrency"`
		Priority              int32  `json:"priority"`
		Status                string `json:"status"`
		Window5hUsedBps       uint16 `json:"window5hUsedBps"`
		Window7dUsedBps       uint16 `json:"window7dUsedBps"`
		Window5hResetAtUnixMs int64  `json:"window5hResetAtUnixMs,omitempty"`
		Window7dResetAtUnixMs int64  `json:"window7dResetAtUnixMs,omitempty"`
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

	nextGroupPlatforms := make(map[string]string, len(snap.Groups))
	coreGroups := make([]coreGroup, 0, len(snap.Groups))
	for _, g := range snap.Groups {
		nextGroupPlatforms[g.ID] = g.Platform
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
			ID:                    a.ID,
			GroupID:               a.GroupID,
			Platform:              a.Platform,
			ExecutionMode:         a.ExecutionMode,
			AuthKind:              authKind,
			SubscriptionTier:      subTier,
			TierMultiplier:        tierMult,
			MaxConcurrency:        max(1, a.MaxConcurrency),
			Priority:              a.Priority,
			Status:                a.Status,
			Window5hUsedBps:       a.Window5hUsedBps,
			Window7dUsedBps:       a.Window7dUsedBps,
			Window5hResetAtUnixMs: a.Window5hResetAtUnixMs,
			Window7dResetAtUnixMs: a.Window7dResetAtUnixMs,
		})
	}

	now := time.Now()
	nextKeyByHash := make(map[string]edgeKeyMeta, len(snap.APIKeys))
	nextIPAllowlists := make(map[string][]string)
	nextIPDenylists := make(map[string][]string)
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
		if len(k.IPDenylist) > 0 {
			nextIPDenylists[k.ID] = append([]string(nil), k.IPDenylist...)
		}
		normHash := strings.ToLower(strings.TrimSpace(k.KeyHashHex))
		if normHash != "" {
			nextKeyByHash[normHash] = edgeKeyMeta{
				ID:       k.ID,
				UserID:   k.UserID,
				GroupID:  k.GroupID,
				Platform: nextGroupPlatforms[k.GroupID],
				Enabled:  enabled,
			}
		}
		coreKeys = append(coreKeys, coreAPIKey{
			ID:               k.ID,
			UserID:           k.UserID,
			GroupID:          k.GroupID,
			KeyHashHex:       normHash,
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
	priceRules := snap.PriceRules
	if priceRules == nil {
		priceRules = []SyncPriceRuleInput{}
	}
	riskBans := snap.RiskBans
	if riskBans == nil {
		riskBans = []SyncRiskBanInput{}
	}
	clearedRiskSubjects := snap.ClearedRiskSubjects
	if clearedRiskSubjects == nil {
		clearedRiskSubjects = []string{}
	}

	type coreUserGroupRate struct {
		UserID               string `json:"userId"`
		GroupID              string `json:"groupId"`
		RateMultiplierMicros uint64 `json:"rateMultiplierMicros"`
	}
	var userGroupRates []coreUserGroupRate
	if snap.UserLimits != nil {
		for _, ov := range snap.UserLimits.Overrides {
			if ov.RateMultiplier == nil || *ov.RateMultiplier <= 0 || strings.TrimSpace(ov.UserID) == "" || strings.TrimSpace(ov.GroupID) == "" {
				continue
			}
			userGroupRates = append(userGroupRates, coreUserGroupRate{
				UserID:               ov.UserID,
				GroupID:              ov.GroupID,
				RateMultiplierMicros: uint64(max(1, int64(math.Round(*ov.RateMultiplier*1_000_000)))),
			})
		}
	}
	if userGroupRates == nil {
		userGroupRates = []coreUserGroupRate{}
	}

	type coreProviderModels struct {
		Provider string   `json:"provider"`
		Models   []string `json:"models"`
	}
	mergedDiscovered := make(map[string][]string)
	for prov, list := range snap.DiscoveredModels {
		mergedDiscovered[strings.ToLower(strings.TrimSpace(prov))] = append([]string(nil), list...)
	}
	for prov, list := range c.modelCatalog.snapshot() {
		mergedDiscovered[prov] = append(mergedDiscovered[prov], list...)
	}
	providerModels := make([]coreProviderModels, 0, len(mergedDiscovered))
	for prov, list := range mergedDiscovered {
		uniq := dedupSortedStrings(list)
		if prov != "" && len(uniq) > 0 {
			providerModels = append(providerModels, coreProviderModels{Provider: prov, Models: uniq})
		}
	}

	corePayload, err := json.Marshal(map[string]any{
		"revisionUnixMs":      snap.RevisionUnixMs,
		"groups":              coreGroups,
		"routes":              routes,
		"accounts":            coreAccounts,
		"apiKeys":             coreKeys,
		"wallets":             coreWallets,
		"priceRules":          priceRules,
		"riskBans":            riskBans,
		"clearedRiskSubjects": clearedRiskSubjects,
		"clearAllRiskBans":    snap.ClearAllRiskBans,
		"userGroupRates":      userGroupRates,
		"providerModels":      providerModels,
	})
	if err != nil {
		return SyncAckResult{}, err
	}

	c.mu.Lock()
	c.keyByHash = nextKeyByHash
	c.groupPlatforms = nextGroupPlatforms
	c.keyIPAllowlists = nextIPAllowlists
	c.keyIPDenylists = nextIPDenylists
	c.accountAuthKinds = nextAuthKinds
	c.accountTiers = nextTiers
	c.accountMetas = nextMetas
	c.lastCoreSyncJSON = corePayload
	c.lastRevisionUnixMs = snap.RevisionUnixMs
	c.snapshotApplied = true
	c.mu.Unlock()
	c.userLimits.apply(snap.UserLimits)
	c.moderation.Apply(snap.Moderation, c.vault, c.allowPrivateUpstreams)

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

	reply, err := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
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

// ResyncCore immediately pushes the latest cached snapshot (or pulls a fresh one from BFF) into slipgate-core
// after a supervised core restart, eliminating any unauthenticated/cold window.
func (c *Coordinator) ResyncCore(ctx context.Context) error {
	for attempt := range 10 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := c.PullSnapshotFromBFF(ctx); err == nil {
			return nil
		}
		c.mu.RLock()
		cachedPayload := c.lastCoreSyncJSON
		c.mu.RUnlock()
		if len(cachedPayload) > 0 && strings.TrimSpace(c.coreIPC) != "" {
			ipcCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			_, ipcErr := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
				StreamID: c.streamSeq.Add(1),
				Type:     dpbridge.FrameSyncState,
				Flags:    dpbridge.FlagEndStream,
				Payload:  cachedPayload,
			})
			cancel()
			if ipcErr == nil {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(100*(attempt+1)) * time.Millisecond):
		}
	}
	return errors.New("dataplane: failed to resync slipgate-core after restart")
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
		var tickCount uint64
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				tickCount++
				_ = c.PullSnapshotFromBFF(ctx)
				if tickCount%4 == 0 {
					c.ProactiveRefreshSweep(ctx)
				}
				if tickCount%40 == 1 {
					go c.RefreshUpstreamModelCatalog(ctx, false)
				}
			}
		}
	}()
}

type coreTurnEvalRequest struct {
	RequestID               string   `json:"requestId"`
	Method                  string   `json:"method"`
	Path                    string   `json:"path"`
	APIKey                  string   `json:"apiKey"`
	ClientIP                string   `json:"clientIp"`
	Model                   string   `json:"model"`
	Stream                  bool     `json:"stream"`
	MaxTokens               uint64   `json:"maxTokens"`
	EstimatedInputTokens    uint64   `json:"estimatedInputTokens"`
	BodyExcerpt             string   `json:"bodyExcerpt"`
	NowUnixMs               int64    `json:"nowUnixMs"`
	SessionKey              string   `json:"sessionKey,omitempty"`
	ExcludeAccountIDs       []string `json:"excludeAccountIds,omitempty"`
	RebindHoldID            uint64   `json:"rebindHoldId,omitempty"`
	RebindCooldownAccountID string   `json:"rebindCooldownAccountId,omitempty"`
	RebindCooldownMs        uint64   `json:"rebindCooldownMs,omitempty"`
	ServiceTier             string   `json:"serviceTier,omitempty"`
	ReasoningEffort         string   `json:"reasoningEffort,omitempty"`
	ImageCount              uint32   `json:"imageCount,omitempty"`
	VideoSeconds            uint32   `json:"videoSeconds,omitempty"`
	// TurnNonce lets the edge release the hold this evaluation creates if the reply never arrives.
	TurnNonce string `json:"turnNonce,omitempty"`
}

type coreDispatchDirective struct {
	Engine           string   `json:"engine"`
	Action           string   `json:"action"`
	Status           int      `json:"status"`
	HoldID           uint64   `json:"holdId"`
	UserID           string   `json:"userId"`
	APIKeyID         string   `json:"apiKeyId"`
	GroupID          string   `json:"groupId"`
	AccountID        string   `json:"accountId"`
	Provider         string   `json:"provider"`
	ExecutionMode    string   `json:"executionMode"`
	AuthKind         string   `json:"authKind"`
	SubscriptionTier string   `json:"subscriptionTier"`
	TierMultiplier   uint16   `json:"tierMultiplier"`
	PublicModel      string   `json:"publicModel"`
	UpstreamModel    string   `json:"upstreamModel"`
	CleanseMode      string   `json:"cleanseMode"`
	HoldNanoUSD      string   `json:"holdNanoUsd"`
	Models           []string `json:"models"`
	ErrorType        string   `json:"errorType"`
	ErrorCode        string   `json:"errorCode"`
	Message          string   `json:"message"`
	RiskTriggered    bool     `json:"riskTriggered"`
	SubjectKind      string   `json:"subjectKind"`
	SubjectHash      string   `json:"subjectHash"`
	StrikeLevel      uint8    `json:"strikeLevel"`
	BanDuration      string   `json:"banDuration"`
	RetryAfterMs     uint64   `json:"retryAfterMs"`
}

type coreSettleReport struct {
	HoldID uint64 `json:"holdId"`
	// TurnNonce names the hold by the evaluation that created it when HoldID is 0.
	TurnNonce string `json:"turnNonce,omitempty"`
	// ReleaseOnly gives the hold back uncharged (the BFF prices the turn if it ran).
	ReleaseOnly bool `json:"releaseOnly,omitempty"`
	// APIKeyID lets the core refuse a report whose hold id now names another turn's hold.
	APIKeyID              string `json:"apiKeyId,omitempty"`
	UpstreamStatus        uint16 `json:"upstreamStatus"`
	InputTokens           uint64 `json:"inputTokens"`
	OutputTokens          uint64 `json:"outputTokens"`
	CacheReadTokens       uint64 `json:"cacheReadTokens"`
	CacheWriteTokens      uint64 `json:"cacheWriteTokens"`
	Window5hUsedBps       uint16 `json:"window5hUsedBps"`
	Window7dUsedBps       uint16 `json:"window7dUsedBps"`
	Window5hResetAtUnixMs int64  `json:"window5hResetAtUnixMs,omitempty"`
	Window7dResetAtUnixMs int64  `json:"window7dResetAtUnixMs,omitempty"`
	CooldownDurationMs    uint64 `json:"cooldownDurationMs,omitempty"`
	ServiceTier           string `json:"serviceTier,omitempty"`
	ReasoningEffort       string `json:"reasoningEffort,omitempty"`
	ImageCount            uint32 `json:"imageCount,omitempty"`
	VideoSeconds          uint32 `json:"videoSeconds,omitempty"`
	NowUnixMs             int64  `json:"nowUnixMs,omitempty"`
}

type coreSettleAck struct {
	OK                          bool   `json:"ok"`
	SettledCostNanoUSD          string `json:"settledCostNanoUsd"`
	BalanceAfterNanoUSD         string `json:"balanceAfterNanoUsd"`
	OrdinaryUpstream400Exempted bool   `json:"ordinaryUpstream400Exempted"`
	RateMultiplierMicros        uint64 `json:"rateMultiplierMicros"`
	// settled is true only when slipgate-core acknowledged settling this hold; otherwise the
	// reported cost is not the core's valuation and the BFF must price the turn.
	settled bool
}

// HandleHTTP serves /v1/*, /v1beta/*, and /mcp/* strictly on the DataPlane (Go <-> Zig IPC, zero BFF hot path).
func (c *Coordinator) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	// One "[http.access]" line per turn while the BFF persists access logs (nil = off).
	access := c.beginAccess(&w, r, startedAt)
	defer c.finishAccess(access)
	w.Header().Set("X-Slipgate-Plane", "dataplane-direct")

	streamID := c.streamSeq.Add(1)
	requestID := sanitizeRequestID(r.Header.Get("X-Request-Id"), streamID)
	w.Header().Set("X-Request-Id", requestID)
	// Anthropic SDKs read request-id, OpenAI SDKs x-request-id.
	w.Header().Set("Request-Id", requestID)

	ingressCodec, _, _ := DetectIngressCodec(r.URL.Path, r.URL.RawQuery)
	if !isSupportedDataPlaneRoute(r.Method, r.URL.Path) {
		WriteProtocolError(w, ingressCodec, http.StatusNotFound, "not_found_error", "unsupported_endpoint",
			"Slipgate does not serve "+r.Method+" "+r.URL.Path)
		return
	}

	if isStatefulResponsesLookup(r.Method, r.URL.Path) {
		c.handleStatefulResponsesRoute(w, r, requestID, startedAt)
		return
	}
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/videos/") {
		c.handleGetVideoTask(w, r, requestID, startedAt)
		return
	}

	apiKey := extractAPIKey(r)
	// Refuse keys slipgate-core is certain to refuse before reading a body of up to 16 MiB for them.
	if msg := c.upfrontKeyRejection(apiKey); msg != "" {
		WriteProtocolError(w, ingressCodec, http.StatusUnauthorized, "authentication_error", "invalid_api_key", msg)
		return
	}

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

	isV1BetaModelsReq := r.Method == http.MethodGet && strings.TrimSuffix(r.URL.Path, "/") == "/v1beta/models"
	isModelsReq := (r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/models")) || isV1BetaModelsReq
	isMultimodal := r.Method == http.MethodPost && (isEmbeddingsEndpoint(r.URL.Path) || isImagesEndpoint(r.URL.Path) || isVideosPostEndpoint(r.URL.Path))
	isExtended := r.Method == http.MethodPost && isExtendedEndpoint(r.URL.Path)
	var turn *CanonicalTurn
	if isModelsReq {
		turn = &CanonicalTurn{
			IngressCodec: CodecOpenAIChat,
			MaxTokens:    64,
		}
		if isV1BetaModelsReq {
			turn.IngressCodec = CodecGeminiGenerate
		}
	} else if isMultimodal {
		var parseErr error
		turn, parseErr = parseMultimodalIngress(r, rawBody)
		if parseErr != nil {
			c.reportRequestError(buildDirectiveErrorReport(
				r, requestID, startedAt, nil, "",
				"ingress", "malformed_json", http.StatusBadRequest, 0,
				"invalid_request_error", "malformed_json", parseErr.Error(), "", 1, false,
			))
			WriteProtocolError(w, ingressCodec, http.StatusBadRequest, "invalid_request_error", "malformed_json", parseErr.Error())
			return
		}
	} else if isExtended {
		var parseErr error
		turn, parseErr = parseExtendedIngress(r, rawBody)
		if parseErr != nil {
			c.reportRequestError(buildDirectiveErrorReport(
				r, requestID, startedAt, nil, "",
				"ingress", "malformed_json", http.StatusBadRequest, 0,
				"invalid_request_error", "malformed_json", parseErr.Error(), "", 1, false,
			))
			WriteProtocolError(w, ingressCodec, http.StatusBadRequest, "invalid_request_error", "malformed_json", parseErr.Error())
			return
		}
	} else {
		var parseErr error
		turn, parseErr = ParseIngressRequest(r.URL.Path, r.URL.RawQuery, rawBody)
		if parseErr != nil {
			c.reportRequestError(buildDirectiveErrorReport(
				r, requestID, startedAt, nil, "",
				"ingress", "malformed_json", http.StatusBadRequest, 0,
				"invalid_request_error", "malformed_json", parseErr.Error(), "", 1, false,
			))
			WriteProtocolError(w, ingressCodec, http.StatusBadRequest, "invalid_request_error", "malformed_json", parseErr.Error())
			return
		}
		turn.AnthropicVersion = r.Header.Get("anthropic-version")
		turn.AnthropicBeta = r.Header.Get("anthropic-beta")
	}
	access.setTurn(turn)

	clientIP := c.clientIPFromRequest(r)
	// [M-06] Enforce IP allowlist/denylist and pre-check user/group caps BEFORE calling slipgate-core
	// so unauthorized client IPs or throttled users cannot burn legitimate per-key RPM in core-zig.
	if km, known := c.lookupKeyByPlaintext(apiKey); known && km.Enabled {
		if !c.isClientIPAllowed(km.ID, clientIP) {
			rep := buildDirectiveErrorReport(
				r, requestID, startedAt, nil, turn.PublicModel,
				"ingress", "ip_not_allowed", http.StatusForbidden, 0,
				"permission_error", "ip_not_allowed", "client IP is not in API key allowlist", "", 1, false,
			)
			rep.UserID = optStringPtr(km.UserID)
			rep.APIKeyID = optStringPtr(km.ID)
			rep.GroupID = optStringPtr(km.GroupID)
			c.reportRequestError(rep)
			WriteProtocolError(w, turn.IngressCodec, http.StatusForbidden, "permission_error", "ip_not_allowed", "client IP is not in API key allowlist")
			return
		}
		if !isModelsReq {
			if rej := c.userLimits.precheck(km.UserID, km.GroupID, km.Platform); rej != nil {
				setRetryAfter(w.Header(), rej.retryAfterMs)
				rep := buildDirectiveErrorReport(
					r, requestID, startedAt, nil, turn.PublicModel,
					"ingress", rej.code, rej.status, 0,
					rej.errType, rej.code, rej.message, "", 1, false,
				)
				rep.UserID = optStringPtr(km.UserID)
				rep.APIKeyID = optStringPtr(km.ID)
				rep.GroupID = optStringPtr(km.GroupID)
				c.reportRequestError(rep)
				WriteProtocolError(w, turn.IngressCodec, rej.status, rej.errType, rej.code, rej.message)
				return
			}
		}
	}

	if !isModelsReq && strings.TrimSpace(turn.BodyExcerpt) != "" {
		var modPlatform, modGroupID, modUserID, modKeyID string
		if km, known := c.lookupKeyByPlaintext(apiKey); known && km.Enabled {
			modPlatform = km.Platform
			modGroupID = km.GroupID
			modUserID = km.UserID
			modKeyID = km.ID
		}
		if verdict := c.moderation.Evaluate(r.Context(), turn.BodyExcerpt, modPlatform, modGroupID); verdict != nil {
			ev := ModerationEventPayload{
				RequestID:      requestID,
				Platform:       modPlatform,
				PublicModel:    turn.PublicModel,
				RuleID:         optStringPtr(verdict.RuleID),
				RuleName:       verdict.RuleName,
				Source:         verdict.Source,
				Action:         verdict.Action,
				MatchedExcerpt: verdict.MatchedExcerpt,
			}
			if modUserID != "" {
				ev.UserID = &modUserID
			}
			if modKeyID != "" {
				ev.APIKeyID = &modKeyID
			}
			if modGroupID != "" {
				ev.GroupID = &modGroupID
			}
			c.postModerationEventBounded(ev)
			if verdict.Action == "block" || verdict.Action == "strike" {
				if verdict.Action == "strike" && modKeyID != "" {
					c.postRiskEventBounded(RiskBanEventPayload{
						SubjectKind:     "api_key",
						SubjectHash:     modKeyID,
						StrikeLevel:     1,
						BanDuration:     "10m",
						Reason:          "moderation:" + verdict.RuleName,
						SourceRequestID: requestID,
					})
				}
				rep := buildDirectiveErrorReport(
					r, requestID, startedAt, nil, turn.PublicModel,
					"ingress", "content_policy_violation", http.StatusBadRequest, 0,
					"invalid_request_error", "content_policy_violation", verdict.RejectMessage, "", 1, false,
				)
				if modUserID != "" {
					rep.UserID = &modUserID
				}
				if modKeyID != "" {
					rep.APIKeyID = &modKeyID
				}
				if modGroupID != "" {
					rep.GroupID = &modGroupID
				}
				c.reportRequestError(rep)
				WriteProtocolError(w, turn.IngressCodec, http.StatusBadRequest, "invalid_request_error", "content_policy_violation", verdict.RejectMessage)
				return
			}
		}
	}

	sessionKey := deriveSessionKey(r, turn, apiKey)
	baseEvalReq := coreTurnEvalRequest{
		RequestID:            requestID,
		Method:               r.Method,
		Path:                 r.URL.Path,
		APIKey:               apiKey,
		ClientIP:             clientIP,
		Model:                turn.PublicModel,
		Stream:               turn.Stream,
		MaxTokens:            turn.MaxTokens,
		EstimatedInputTokens: turn.EstimatedInputTokens,
		BodyExcerpt:          turn.BodyExcerpt,
		NowUnixMs:            startedAt.UnixMilli(),
		SessionKey:           sessionKey,
		ServiceTier:          turn.ServiceTier,
		ReasoningEffort:      turn.ReasoningEffort,
		ImageCount:           turn.ImageCount,
		VideoSeconds:         turn.VideoSeconds,
		TurnNonce:            newTurnNonce(),
	}
	evalPayload, _ := json.Marshal(baseEvalReq)

	ipcCtx, ipcCancel := context.WithTimeout(r.Context(), 5*time.Second)
	replyFrame, ipcErr := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
		StreamID: streamID,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  evalPayload,
	})
	ipcCancel()
	if ipcErr != nil {
		if !isModelsReq {
			// The core may have created a hold before the reply was lost.
			c.releaseCoreHold(0, baseEvalReq.TurnNonce, "")
		}
		c.logTurn("error", "slipgate-core dataplane unreachable: "+ipcErr.Error(), requestID, nil, turn.PublicModel)
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, nil, turn.PublicModel,
			"core_eval", "core_unreachable", http.StatusServiceUnavailable, 0,
			"core_unavailable", "core_unreachable", "slipgate-core dataplane unreachable: "+ipcErr.Error(), "", 1, false,
		))
		WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "core_unavailable", "core_unreachable", "slipgate-core dataplane unreachable: "+ipcErr.Error())
		return
	}

	var directive coreDispatchDirective
	_ = json.Unmarshal(replyFrame.Payload, &directive)
	access.setDirective(&directive)

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
		if isV1BetaModelsReq {
			gemModels := make([]map[string]any, 0, len(directive.Models))
			for _, id := range directive.Models {
				gemModels = append(gemModels, map[string]any{
					"name":                       "models/" + id,
					"displayName":                id,
					"supportedGenerationMethods": []string{"generateContent", "streamGenerateContent", "countTokens"},
				})
			}
			writeJSONResponse(w, http.StatusOK, map[string]any{"models": gemModels})
			return
		}
		items := make([]map[string]any, 0, len(directive.Models))
		for _, id := range directive.Models {
			items = append(items, modelObject(id))
		}
		list := map[string]any{"object": "list", "data": items, "has_more": false}
		if len(directive.Models) > 0 {
			list["first_id"] = directive.Models[0]
			list["last_id"] = directive.Models[len(directive.Models)-1]
		}
		writeJSONResponse(w, http.StatusOK, list)
		return

	case "model":
		if len(directive.Models) == 0 {
			WriteProtocolError(w, turn.IngressCodec, http.StatusNotFound, "not_found_error", "model_not_found", "Model is not available to this API key")
			return
		}
		writeJSONResponse(w, http.StatusOK, modelObject(directive.Models[0]))
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
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"core_eval", firstNonEmpty(directive.ErrorCode, "core_rejected"), directive.Status, 0,
			directive.ErrorType, directive.ErrorCode, directive.Message, "", 1, false,
		))
		setRetryAfter(w.Header(), directive.RetryAfterMs)
		WriteProtocolError(w, turn.IngressCodec, directive.Status, directive.ErrorType, directive.ErrorCode, directive.Message)
		return

	case "dispatch":
		// Continue below to execute three-mode upstream dispatch and guaranteed settlement.
	default:
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"core_eval", "unknown_core_action", http.StatusBadGateway, 0,
			"ipc_error", "unknown_core_action", "unexpected slipgate-core action: "+directive.Action, "", 1, false,
		))
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
			HoldID:                directive.HoldID,
			APIKeyID:              directive.APIKeyID,
			UpstreamStatus:        statusU16,
			InputTokens:           metrics.InputTokens,
			OutputTokens:          metrics.OutputTokens,
			CacheReadTokens:       metrics.CacheReadTokens,
			CacheWriteTokens:      metrics.CacheWriteTokens,
			Window5hUsedBps:       metrics.Window5hUsedBps,
			Window7dUsedBps:       metrics.Window7dUsedBps,
			Window5hResetAtUnixMs: metrics.Window5hResetAtUnixMs,
			Window7dResetAtUnixMs: metrics.Window7dResetAtUnixMs,
			CooldownDurationMs:    metrics.CooldownDurationMs,
			ServiceTier:           billedServiceTier(turn),
			ReasoningEffort:       turn.ReasoningEffort,
			ImageCount:            metrics.ImageCount,
			VideoSeconds:          metrics.VideoSeconds,
			NowUnixMs:             time.Now().UnixMilli(),
		})
		var (
			ackFrame dpbridge.Frame
			err      error
		)
		// One retry for a transient IPC failure. A retry that reaches a core which already
		// settled the hold just gets ok:false, and the BFF bills the turn exactly once either way.
		for attempt := range 2 {
			if attempt > 0 {
				time.Sleep(100 * time.Millisecond)
			}
			settleCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			ackFrame, err = dpbridge.ExchangeAuth(settleCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
				StreamID: c.streamSeq.Add(1),
				Type:     dpbridge.FrameSettleReport,
				Flags:    dpbridge.FlagEndStream,
				Payload:  reportRaw,
			})
			cancel()
			if err == nil {
				break
			}
		}
		if err != nil {
			c.logTurn("warn", fmt.Sprintf("hold %d settle IPC failed: %v", directive.HoldID, err), requestID, &directive, turn.PublicModel,
				"hold_id", fmtUint(directive.HoldID))
			// The BFF prices this turn (coreSettled=false); the core must not keep the hold's slots.
			c.releaseCoreHold(directive.HoldID, "", directive.APIKeyID)
			return coreSettleAck{SettledCostNanoUSD: "0"}
		}
		var ack coreSettleAck
		_ = json.Unmarshal(ackFrame.Payload, &ack)
		if ack.SettledCostNanoUSD == "" {
			ack.SettledCostNanoUSD = "0"
		}
		// ok:false means the core no longer knew the hold (e.g. it restarted mid-stream).
		ack.settled = ack.OK
		if !ack.OK {
			c.logTurn("warn", fmt.Sprintf("slipgate-core did not settle hold %d; the BFF will price the turn", directive.HoldID), requestID, &directive, turn.PublicModel,
				"hold_id", fmtUint(directive.HoldID))
		}
		return ack
	}
	defer func() {
		// Safety net if an early return or panic occurred before explicit settlement.
		settleHold(RelayMetrics{UpstreamStatus: http.StatusInternalServerError})
	}()

	if !c.isClientIPAllowed(directive.APIKeyID, clientIP) {
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"ingress", "ip_not_allowed", http.StatusForbidden, 0,
			"permission_error", "ip_not_allowed", "client IP is not in API key allowlist", "", 1, false,
		))
		settleHold(RelayMetrics{UpstreamStatus: http.StatusForbidden})
		WriteProtocolError(w, turn.IngressCodec, http.StatusForbidden, "permission_error", "ip_not_allowed", "client IP is not in API key allowlist")
		return
	}
	releaseUserLimits, admitted := c.admitUserLimits(w, turn.IngressCodec, &directive, settleHold)
	defer releaseUserLimits()
	if !admitted {
		return
	}

	// Token counting only exists natively on Anthropic; every other upstream gets the local estimate
	// (slipgate-core takes no hold for counting, so nothing is billed either way).
	if turn.IngressCodec == CodecAnthropicCountTokens && !strings.EqualFold(directive.Provider, "anthropic") {
		writeJSONResponse(w, http.StatusOK, map[string]any{"input_tokens": turn.EstimatedInputTokens})
		settleHold(RelayMetrics{UpstreamStatus: http.StatusOK})
		return
	}
	if turn.IngressCodec == CodecGeminiGenerate && strings.HasSuffix(r.URL.Path, ":countTokens") {
		writeJSONResponse(w, http.StatusOK, map[string]any{"totalTokens": turn.EstimatedInputTokens})
		settleHold(RelayMetrics{UpstreamStatus: http.StatusOK})
		return
	}

	if turn.IsMetadataOnlyMCP() {
		WriteMCPMetadataResponse(w, turn)
		settleHold(RelayMetrics{UpstreamStatus: http.StatusOK})
		return
	}

	if turn.IngressCodec == CodecTypeSafeSystemOne && !strings.EqualFold(strings.TrimSpace(directive.Provider), "typesafe") {
		msg := "System One is only available for TypeSafe and compatible Composite groups"
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"ingress", "unsupported_platform", http.StatusNotFound, 0,
			"not_found_error", "unsupported_platform", msg, "", 1, false,
		))
		settleHold(RelayMetrics{UpstreamStatus: http.StatusNotFound})
		WriteProtocolError(w, CodecAnthropicMessages, http.StatusNotFound, "not_found_error", "unsupported_platform", msg)
		return
	}
	if turn.IngressCodec != CodecTypeSafeSystemOne && strings.EqualFold(strings.TrimSpace(directive.Provider), "typesafe") {
		msg := "TypeSafe models are only available through POST /v1/systemone"
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"ingress", "unsupported_platform", http.StatusNotFound, 0,
			"not_found_error", "unsupported_platform", msg, "", 1, false,
		))
		settleHold(RelayMetrics{UpstreamStatus: http.StatusNotFound})
		WriteProtocolError(w, turn.IngressCodec, http.StatusNotFound, "not_found_error", "unsupported_platform", msg)
		return
	}
	if strings.EqualFold(strings.TrimSpace(directive.Provider), "opencode_go") && IsOpenCodeUnsupportedModel(directive.UpstreamModel) {
		errMsg := ErrOpenCodeUnsupportedModel{Model: directive.UpstreamModel}.Error()
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"ingress", "model_not_supported", http.StatusBadRequest, 0,
			"invalid_request_error", "model_not_supported", errMsg, "", 1, false,
		))
		settleHold(RelayMetrics{UpstreamStatus: http.StatusBadRequest})
		WriteProtocolError(w, turn.IngressCodec, http.StatusBadRequest, "invalid_request_error", "model_not_supported", errMsg)
		return
	}

	if turn.IngressCodec == CodecOpenAIResponses && turn.PreviousResponseID != "" {
		c.responsesState.hydratePreviousTurn(directive.APIKeyID, turn)
	}

	cleanseMode := firstNonEmpty(directive.CleanseMode, "zero")
	tracker := &NativeTurnTracker{}

	var (
		upstreamResp    *http.Response
		egressCodec     CodecKind
		pctx            OutboundPersonaContext
		subTier         string
		excludedAccIDs  []string
		pendingCooldown uint64
		attemptsMade    int
	)

	const maxDispatchAttempts = 3
	for attempt := 0; attempt < maxDispatchAttempts; attempt++ {
		attemptsMade = attempt + 1
		secret, hasSecret := c.vault.Get(directive.AccountID)
		if !hasSecret {
			if attempt+1 < maxDispatchAttempts && tracker.CanFailover() {
				c.reportRequestError(buildDirectiveErrorReport(
					r, requestID, startedAt, &directive, turn.PublicModel,
					"outbound", "account_secret_unavailable", http.StatusServiceUnavailable, 0,
					"overloaded_error", "account_secret_unavailable", "upstream account credentials not yet synchronized in vault", "", attemptsMade, true,
				))
				excludedAccIDs = append(excludedAccIDs, directive.AccountID)
				if nextDir, ok := c.tryRebindFailover(r.Context(), baseEvalReq, directive.HoldID, excludedAccIDs, "", 0); ok {
					directive = nextDir
					access.setDirective(&directive)
					continue
				}
			}
			c.reportRequestError(buildDirectiveErrorReport(
				r, requestID, startedAt, &directive, turn.PublicModel,
				"outbound", "account_secret_unavailable", http.StatusServiceUnavailable, 0,
				"overloaded_error", "account_secret_unavailable", "upstream account credentials not yet synchronized in vault", "", attemptsMade, attemptsMade > 1,
			))
			settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
			WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", "account_secret_unavailable", "upstream account credentials not yet synchronized in vault")
			return
		}

		// Proactive OAuth token renewal when expiring within 5 minutes.
		if secret.NeedsOAuthRefresh(time.Now()) {
			if refreshed, refErr := c.RefreshAccountOAuth(r.Context(), directive.AccountID, false); refErr == nil {
				secret = refreshed
			}
		}

		subTier = firstNonEmpty(
			NormalizeSubscriptionTier(directive.SubscriptionTier),
			c.accountTier(directive.AccountID),
			secret.SubscriptionTier,
			"standard",
		)
		tierMult := directive.TierMultiplier
		if tierMult == 0 {
			tierMult = SubscriptionTierMultiplier(directive.Provider, subTier)
		}
		var catalogProtocols []string
		if strings.EqualFold(strings.TrimSpace(directive.Provider), "command_code") {
			accMeta, _ := c.accountMetaFor(directive.AccountID)
			catalogProtocols = c.lookupCommandCodeModelProtocols(r.Context(), directive.AccountID, accMeta, secret, directive.UpstreamModel)
		}
		pctx = OutboundPersonaContext{
			Provider:         directive.Provider,
			AuthKind:         firstNonEmpty(directive.AuthKind, c.accountAuthKind(directive.AccountID)),
			SubscriptionTier: subTier,
			TierMultiplier:   tierMult,
			ExecutionMode:    directive.ExecutionMode,
			AccountID:        directive.AccountID,
			CleanseMode:      cleanseMode,
			RequestID:        requestID,
			CatalogProtocols: catalogProtocols,
		}

		var releaseVMSeat func()
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
			releaseVMSeat = func() { _ = c.vmSlots.ReleaseSubagentSeat(slot.ID) }

			guestEndpoint := strings.TrimSpace(slot.GuestUDSPath)
			if guestEndpoint != "" && !strings.HasPrefix(guestEndpoint, "sandbox://") && !strings.HasPrefix(guestEndpoint, "ssh://") {
				handoffMeta, _ := json.Marshal(map[string]any{
					"request_id": requestID,
					"slot_id":    slot.ID,
					"provider":   directive.Provider,
					"model":      directive.UpstreamModel,
					"stream":     turn.Stream,
				})
				handoffCtx, handoffCancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
				_, liveHandoff, handoffErr := vmslot.HandoffGuestTurn(handoffCtx, guestEndpoint, c.guestToken, slot.Persona.GuestMachineID, handoffMeta)
				handoffCancel()
				if handoffErr != nil {
					releaseVMSeat()
					settleHold(RelayMetrics{UpstreamStatus: http.StatusServiceUnavailable})
					errCode := "vm_guestd_unreachable"
					errMsg := "slipgate-guestd failed health check: " + handoffErr.Error()
					if errors.Is(handoffErr, vmslot.ErrGuestMachineIDMismatch) {
						errCode = "vm_guest_identity_mismatch"
						errMsg = handoffErr.Error()
					}
					WriteProtocolError(w, turn.IngressCodec, http.StatusServiceUnavailable, "overloaded_error", errCode, errMsg)
					return
				}
				if liveHandoff {
					w.Header().Set("X-Slipgate-Guest-Handoff", "live")
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

		execOnce := func(sec AccountSecret) (*http.Response, CodecKind, error) {
			preparedSec, prepErr := c.prepareCloudProviderSecret(r.Context(), pctx.Provider, sec)
			if prepErr != nil {
				return nil, turn.IngressCodec, prepErr
			}
			if isMultimodal {
				if preparedSec.IsMock() {
					return executeMockMultimodalTurn(turn, directive.UpstreamModel), turn.IngressCodec, nil
				}
				mReq, mCodec, bErr := buildMultimodalUpstreamRequest(r.Context(), r.URL.Path, pctx, directive.UpstreamModel, preparedSec, turn)
				if bErr != nil {
					return nil, mCodec, errRequestTranscode{err: bErr}
				}
				resp, dErr := c.executeOutbound(r.Context(), pctx, preparedSec, mReq, directive.UpstreamModel, mCodec, turn)
				return resp, mCodec, dErr
			}
			if isExtended {
				if preparedSec.IsMock() {
					return executeMockExtendedTurn(turn, directive.UpstreamModel), turn.IngressCodec, nil
				}
				eReq, eCodec, bErr := buildExtendedUpstreamRequest(r.Context(), r.URL.Path, pctx, directive.UpstreamModel, preparedSec, turn)
				if bErr != nil {
					return nil, eCodec, errRequestTranscode{err: bErr}
				}
				resp, dErr := c.executeOutbound(r.Context(), pctx, preparedSec, eReq, directive.UpstreamModel, eCodec, turn)
				return resp, eCodec, dErr
			}
			uReq, uCodec, bErr := BuildUpstreamHTTPRequestWithPersona(r.Context(), pctx, directive.UpstreamModel, preparedSec, turn)
			if bErr != nil {
				return nil, uCodec, errRequestTranscode{err: bErr}
			}
			resp, dErr := c.executeOutbound(r.Context(), pctx, preparedSec, uReq, directive.UpstreamModel, uCodec, turn)
			return resp, uCodec, dErr
		}

		var execErr error
		upstreamResp, egressCodec, execErr = execOnce(secret)
		if mutErr, isTranscodeErr := execErr.(errRequestTranscode); isTranscodeErr {
			if releaseVMSeat != nil {
				releaseVMSeat()
			}
			settleHold(RelayMetrics{UpstreamStatus: http.StatusBadRequest})
			WriteProtocolError(w, turn.IngressCodec, http.StatusBadRequest, "invalid_request_error", "request_transcode_failed", mutErr.err.Error())
			return
		}

		// Reactive 401 OAuth RefreshToken retry on the same account before failing over.
		if execErr == nil && upstreamResp != nil && upstreamResp.StatusCode == http.StatusUnauthorized && strings.TrimSpace(secret.RefreshToken) != "" {
			if refreshed, refErr := c.RefreshAccountOAuth(r.Context(), directive.AccountID, true); refErr == nil {
				_ = upstreamResp.Body.Close()
				secret = refreshed
				upstreamResp, egressCodec, execErr = execOnce(secret)
			}
		}

		if execErr != nil {
			c.logTurn("warn", "outbound dispatch failed: "+execErr.Error(), requestID, &directive, turn.PublicModel,
				"execution_mode", directive.ExecutionMode, "upstream_model", directive.UpstreamModel)
			if attempt+1 < maxDispatchAttempts && tracker.CanFailover() {
				if releaseVMSeat != nil {
					releaseVMSeat()
				}
				excludedAccIDs = append(excludedAccIDs, directive.AccountID)
				if nextDir, ok := c.tryRebindFailover(r.Context(), baseEvalReq, directive.HoldID, excludedAccIDs, "", 0); ok {
					c.reportRequestError(buildDirectiveErrorReport(
						r, requestID, startedAt, &directive, turn.PublicModel,
						"outbound", "outbound_dispatch_failed", http.StatusBadGateway, 0,
						"upstream_error", "outbound_dispatch_failed", execErr.Error(), "", attemptsMade, true,
					))
					directive = nextDir
					access.setDirective(&directive)
					continue
				}
			}
			if releaseVMSeat != nil {
				defer releaseVMSeat()
			}
			c.reportRequestError(buildDirectiveErrorReport(
				r, requestID, startedAt, &directive, turn.PublicModel,
				"outbound", "outbound_dispatch_failed", http.StatusBadGateway, 0,
				"upstream_error", "outbound_dispatch_failed", execErr.Error(), "", attemptsMade, attemptsMade > 1,
			))
			settleHold(RelayMetrics{UpstreamStatus: http.StatusBadGateway})
			WriteProtocolError(w, turn.IngressCodec, http.StatusBadGateway, "upstream_error", "outbound_dispatch_failed", execErr.Error())
			return
		}

		// Check pre-first-byte upstream HTTP errors eligible for cooldown and cross-account failover.
		if !(turn.IngressCodec == CodecTypeSafeSystemOne && IsSystemOneRequestErrorStatus(upstreamResp.StatusCode)) && isFailoverEligibleStatus(upstreamResp.StatusCode) {
			cooldownMs := computeUpstreamCooldownMs(upstreamResp.StatusCode, upstreamResp.Header)
			if cooldownMs > 0 {
				pendingCooldown = cooldownMs
				c.persistAccountCooldownBounded(directive.AccountID, cooldownMs, fmt.Sprintf("upstream_http_%d", upstreamResp.StatusCode))
			}
			if attempt+1 < maxDispatchAttempts && tracker.CanFailover() {
				excludedAccIDs = append(excludedAccIDs, directive.AccountID)
				if nextDir, ok := c.tryRebindFailover(r.Context(), baseEvalReq, directive.HoldID, excludedAccIDs, directive.AccountID, cooldownMs); ok {
					rawErr, _ := io.ReadAll(io.LimitReader(upstreamResp.Body, requestErrorMaxBodyLen))
					errType, errCode, errMsg := extractUpstreamError(rawErr, upstreamResp.Status)
					c.reportRequestError(buildDirectiveErrorReport(
						r, requestID, startedAt, &directive, turn.PublicModel,
						"upstream_http", fmt.Sprintf("upstream_http_%d", upstreamResp.StatusCode),
						upstreamResp.StatusCode, upstreamResp.StatusCode,
						firstNonEmpty(errType, "upstream_error"),
						firstNonEmpty(errCode, fmt.Sprintf("upstream_http_%d", upstreamResp.StatusCode)),
						errMsg, truncateUTF8(string(rawErr), requestErrorMaxBodyLen), attemptsMade, true,
					))
					_ = upstreamResp.Body.Close()
					if releaseVMSeat != nil {
						releaseVMSeat()
					}
					pendingCooldown = 0
					directive = nextDir
					access.setDirective(&directive)
					continue
				}
			}
		}

		if releaseVMSeat != nil {
			defer releaseVMSeat()
		}
		break
	}
	defer upstreamResp.Body.Close()

	w.Header().Set("X-Slipgate-Execution-Mode", directive.ExecutionMode)
	w.Header().Set("X-Slipgate-Provider", directive.Provider)
	w.Header().Set("X-Slipgate-Subscription-Tier", subTier)

	var (
		metrics  RelayMetrics
		relayErr error
	)
	if isMultimodal {
		metrics, relayErr = relayMultimodalResponse(w, upstreamResp, egressCodec, turn, &directive, startedAt, &c.mediaTasks)
	} else if isExtended {
		metrics, relayErr = relayExtendedResponse(w, upstreamResp, egressCodec, turn, &directive, startedAt)
	} else {
		targetWriter := w
		var respCapturer *responseCaptureWriter
		if turn.IngressCodec == CodecOpenAIResponses {
			respCapturer = newResponseCaptureWriter(w, 2*1024*1024)
			targetWriter = respCapturer
		}
		metrics, relayErr = RelayAndTranscodeResponse(
			targetWriter,
			upstreamResp,
			egressCodec,
			turn,
			directive.PublicModel,
			cleanseMode,
			startedAt,
			tracker.OnVisibleToolDelta,
		)
		if respCapturer != nil && metrics.UpstreamStatus >= 200 && metrics.UpstreamStatus < 300 {
			c.responsesState.captureTurn(directive.APIKeyID, directive.PublicModel, turn, respCapturer.buf.Bytes())
		}
	}
	if pendingCooldown > 0 && metrics.CooldownDurationMs == 0 {
		metrics.CooldownDurationMs = pendingCooldown
	}
	if relayErr != nil {
		// Structured (logx): the system log keeps the request, user, key, account, platform and model.
		c.logTurn("warn", fmt.Sprintf("stream relay interrupted: %v", relayErr), requestID, &directive, turn.PublicModel,
			"upstream_status", fmtInt(int64(metrics.UpstreamStatus)))
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"stream_relay", "stream_relay_interrupted",
			settlementStatusCode(metrics.UpstreamStatus), metrics.UpstreamStatus,
			firstNonEmpty(metrics.ErrorType, "stream_error"),
			firstNonEmpty(metrics.ErrorCode, "stream_relay_interrupted"),
			firstNonEmpty(metrics.ErrorMessage, relayErr.Error()),
			metrics.ErrorBody, attemptsMade, attemptsMade > 1,
		))
	} else if metrics.UpstreamStatus >= 400 {
		c.reportRequestError(buildDirectiveErrorReport(
			r, requestID, startedAt, &directive, turn.PublicModel,
			"upstream_http", fmt.Sprintf("upstream_http_%d", metrics.UpstreamStatus),
			metrics.UpstreamStatus, metrics.UpstreamStatus,
			firstNonEmpty(metrics.ErrorType, "upstream_error"),
			firstNonEmpty(metrics.ErrorCode, fmt.Sprintf("upstream_http_%d", metrics.UpstreamStatus)),
			firstNonEmpty(metrics.ErrorMessage, http.StatusText(metrics.UpstreamStatus)),
			metrics.ErrorBody, attemptsMade, attemptsMade > 1,
		))
	}

	ack := settleHold(metrics)
	durationMs := elapsedMs(startedAt)
	var coreRate uint64
	if ack.settled {
		coreRate = ack.RateMultiplierMicros
	}

	c.postSettlementBounded(TurnSettlementEvent{
		SettlementID:             newSettlementID(),
		CoreSettled:              ack.settled,
		RequestID:                requestID,
		UserID:                   directive.UserID,
		APIKeyID:                 directive.APIKeyID,
		AccountID:                directive.AccountID,
		GroupID:                  directive.GroupID,
		Platform:                 directive.Provider,
		PublicModel:              directive.PublicModel,
		UpstreamModel:            directive.UpstreamModel,
		IngressCodec:             string(turn.IngressCodec),
		EgressCodec:              string(egressCodec),
		InputTokens:              metrics.InputTokens,
		OutputTokens:             metrics.OutputTokens,
		CacheReadTokens:          metrics.CacheReadTokens,
		CacheWriteTokens:         metrics.CacheWriteTokens,
		CostNanoUSD:              firstNonEmpty(ack.SettledCostNanoUSD, "0"),
		Window5hUsedBps:          metrics.Window5hUsedBps,
		Window7dUsedBps:          metrics.Window7dUsedBps,
		Window5hResetAtUnixMs:    metrics.Window5hResetAtUnixMs,
		Window7dResetAtUnixMs:    metrics.Window7dResetAtUnixMs,
		ServiceTier:              turn.UpstreamServiceTier,
		ReasoningEffort:          turn.ReasoningEffort,
		ImageCount:               metrics.ImageCount,
		VideoSeconds:             float64(metrics.VideoSeconds),
		TTFTMs:                   metrics.TTFTMs,
		DurationMs:               durationMs,
		StatusCode:               settlementStatusCode(metrics.UpstreamStatus),
		CoreHoldID:               directive.HoldID,
		CoreRateMultiplierMicros: coreRate,
	})
}

// settlementStatusCode keeps the recorded status inside the HTTP range the BFF accepts: an upstream
// answering with a non-standard code is still a turn that has to be settled.
func settlementStatusCode(status int) int {
	if status < 100 || status > 599 {
		return http.StatusBadGateway
	}
	return status
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
		return c.upstreamTimeouts.do(req.WithContext(ctx), func(out *http.Request) (*http.Response, error) {
			res, err := c.stealth.DoAccountRequest(out.Context(), pctx.AccountID, utlsProfileID, out)
			if err != nil {
				return nil, err
			}
			return res.Response, nil
		})

	default:
		if secret.IsMock() {
			return ExecuteMockTurn(secret.EffectiveMockTarget(), upstreamModel, egressCodec, turn), nil
		}
		if err := netguard.ValidateOutboundURL(req.URL.String(), c.allowPrivateUpstreams); err != nil {
			return nil, err
		}
		return c.upstreamTimeouts.do(req, c.directClient.Do)
	}
}

func (c *Coordinator) accountAuthKind(accountID string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accountAuthKinds[accountID]
}

func (c *Coordinator) prepareCloudProviderSecret(ctx context.Context, provider string, sec AccountSecret) (AccountSecret, error) {
	if sec.IsMock() || !strings.EqualFold(strings.TrimSpace(provider), "vertex") {
		return sec, nil
	}
	if strings.TrimSpace(sec.GCPPrivateKey) == "" || strings.TrimSpace(sec.GCPClientEmail) == "" {
		return sec, nil
	}
	cache := c.vertexTokens
	if cache == nil {
		cache = defaultVertexTokenCache
	}
	tok, err := cache.Resolve(ctx, c.directClient, c.allowPrivateUpstreams, sec)
	if err != nil {
		return sec, err
	}
	sec.APIKey = tok
	return sec, nil
}

func (c *Coordinator) accountTier(accountID string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accountTiers[accountID]
}

func (c *Coordinator) isClientIPAllowed(apiKeyID, clientIP string) bool {
	c.mu.RLock()
	allow := c.keyIPAllowlists[apiKeyID]
	deny := c.keyIPDenylists[apiKeyID]
	c.mu.RUnlock()
	if ipListMatches(deny, clientIP) {
		return false
	}
	if len(allow) == 0 {
		return true
	}
	return ipListMatches(allow, clientIP)
}

// ipListMatches reports whether clientIP equals an entry or falls inside a CIDR entry.
func ipListMatches(entries []string, clientIP string) bool {
	if len(entries) == 0 {
		return false
	}
	parsedIP := net.ParseIP(clientIP)
	for _, entry := range entries {
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

// postSettlementBounded hands the event to the at-least-once outbox (retried with backoff until the
// BFF accepts it) and waits at most syncWaitBound for the first attempt.
func (c *Coordinator) postSettlementBounded(ev TurnSettlementEvent) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	if ev.SettlementID == "" {
		ev.SettlementID = newSettlementID()
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	done := c.settlements.deliver(ev.SettlementID, raw)
	timer := time.NewTimer(syncWaitBound)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

func (c *Coordinator) postRiskEventBounded(ev RiskBanEventPayload) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	c.postInternalJSONBounded("/api/v1/internal/dataplane/risk-events", ev)
}

func (c *Coordinator) postModerationEventBounded(ev ModerationEventPayload) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	c.postInternalJSONBounded("/api/v1/internal/dataplane/moderation-events", ev)
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

// modelObject serves both SDK families: OpenAI reads id/object/created/owned_by, Anthropic reads
// id/type/display_name/created_at.
func modelObject(id string) map[string]any {
	return map[string]any{
		"id":           id,
		"object":       "model",
		"created":      1735689600,
		"owned_by":     "slipgate",
		"type":         "model",
		"display_name": id,
		"created_at":   "2025-01-01T00:00:00Z",
	}
}

// isSupportedDataPlaneRoute lists the AI endpoints the DataPlane implements.
func isSupportedDataPlaneRoute(method, path string) bool {
	if path == "/mcp" || strings.HasPrefix(path, "/mcp/") {
		return true
	}
	trimmed := strings.TrimSuffix(path, "/")
	if method == http.MethodGet {
		if trimmed == "/v1/models" || strings.HasPrefix(path, "/v1/models/") || trimmed == "/v1beta/models" {
			return true
		}
		if strings.HasPrefix(trimmed, "/v1/responses/") || strings.HasPrefix(trimmed, "/v1/videos/") {
			return true
		}
		return false
	}
	if method == http.MethodDelete {
		return strings.HasPrefix(trimmed, "/v1/responses/") && !strings.HasSuffix(trimmed, "/input_items")
	}
	if method != http.MethodPost {
		return false
	}
	switch trimmed {
	case "/v1/chat/completions",
		"/v1/responses",
		"/v1/messages",
		"/v1/messages/count_tokens",
		"/v1/embeddings",
		"/v1/images/generations",
		"/v1/images/edits",
		"/v1/videos",
		"/v1/videos/generations":
		return true
	}
	if isExtendedEndpoint(trimmed) {
		return true
	}
	if rest, ok := strings.CutPrefix(path, "/v1beta/models/"); ok {
		if idx := strings.LastIndexByte(rest, ':'); idx > 0 {
			switch rest[idx+1:] {
			case "generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents":
				return true
			}
		}
	}
	return false
}

type errRequestTranscode struct {
	err error
}

func (e errRequestTranscode) Error() string { return e.err.Error() }

func isFailoverEligibleStatus(code int) bool {
	switch code {
	case http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout,
		529:
		return true
	default:
		return false
	}
}

func computeUpstreamCooldownMs(status int, h http.Header) uint64 {
	if status != http.StatusTooManyRequests && status != 529 {
		return 0
	}
	if msRaw := strings.TrimSpace(h.Get("Retry-After-Ms")); msRaw != "" {
		if ms, err := strconv.ParseUint(msRaw, 10, 64); err == nil && ms > 0 {
			return min(uint64(3600_000), max(uint64(5_000), ms))
		}
	}
	if secRaw := strings.TrimSpace(h.Get("Retry-After")); secRaw != "" {
		if sec, err := strconv.ParseUint(secRaw, 10, 64); err == nil && sec > 0 {
			return min(uint64(3600_000), max(uint64(5_000), sec*1000))
		}
		if when, err := http.ParseTime(secRaw); err == nil {
			if diff := time.Until(when).Milliseconds(); diff > 0 {
				return min(uint64(3600_000), max(uint64(5_000), uint64(diff)))
			}
		}
	}
	if status == 529 {
		return 30_000
	}
	return 60_000
}

func (c *Coordinator) tryRebindFailover(
	ctx context.Context,
	baseReq coreTurnEvalRequest,
	currentHoldID uint64,
	excluded []string,
	cooldownAccID string,
	cooldownMs uint64,
) (coreDispatchDirective, bool) {
	if strings.TrimSpace(c.coreIPC) == "" || currentHoldID == 0 {
		return coreDispatchDirective{}, false
	}
	req := baseReq
	req.RebindHoldID = currentHoldID
	req.ExcludeAccountIDs = excluded
	req.RebindCooldownAccountID = cooldownAccID
	req.RebindCooldownMs = cooldownMs
	req.NowUnixMs = time.Now().UnixMilli()
	req.TurnNonce = newTurnNonce()
	payload, err := json.Marshal(req)
	if err != nil {
		return coreDispatchDirective{}, false
	}
	ipcCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	reply, err := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
		StreamID: c.streamSeq.Add(1),
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  payload,
	})
	if err != nil {
		// A core that did rebind retired the old hold and created one the edge never learnt about.
		c.releaseCoreHold(0, req.TurnNonce, "")
		return coreDispatchDirective{}, false
	}
	var next coreDispatchDirective
	if json.Unmarshal(reply.Payload, &next) != nil || next.Action != "dispatch" || next.AccountID == "" {
		return coreDispatchDirective{}, false
	}
	return next, true
}

func deriveSessionKey(r *http.Request, turn *CanonicalTurn, apiKey string) string {
	explicit := firstNonEmpty(
		r.Header.Get("X-Session-Id"),
		r.Header.Get("session_id"),
		r.Header.Get("Conversation_id"),
		turn.SessionHint,
	)
	if explicit != "" {
		sum := sha256.Sum256([]byte("sg-sess:" + apiKey + "|" + explicit))
		return hex.EncodeToString(sum[:16])
	}
	if len(turn.Messages) > 0 {
		firstMsg := turn.Messages[0].Content
		if len(firstMsg) > 256 {
			firstMsg = firstMsg[:256]
		}
		if turn.SystemPrompt != "" || firstMsg != "" {
			sum := sha256.Sum256([]byte("sg-conv:" + apiKey + "|" + turn.SystemPrompt[:min(len(turn.SystemPrompt), 256)] + "|" + firstMsg))
			return hex.EncodeToString(sum[:16])
		}
	}
	return ""
}

func isStatefulResponsesLookup(method, path string) bool {
	if method != http.MethodGet && method != http.MethodDelete {
		return false
	}
	return strings.HasPrefix(strings.TrimSuffix(path, "/"), "/v1/responses/")
}

func (c *Coordinator) authenticateAPIKeyViaCore(ctx context.Context, r *http.Request, requestID string, startedAt time.Time) (coreDispatchDirective, bool) {
	clientIP := c.clientIPFromRequest(r)
	rawKey := extractAPIKey(r)
	if km, known := c.lookupKeyByPlaintext(rawKey); known && km.Enabled {
		if !c.isClientIPAllowed(km.ID, clientIP) {
			return coreDispatchDirective{
				Action:    "reject",
				Status:    http.StatusForbidden,
				ErrorType: "permission_error",
				ErrorCode: "ip_not_allowed",
				Message:   "client IP is not in API key allowlist",
			}, false
		}
	}
	evalPayload, _ := json.Marshal(coreTurnEvalRequest{
		RequestID: requestID,
		Method:    http.MethodGet,
		Path:      "/v1/models",
		APIKey:    rawKey,
		ClientIP:  clientIP,
		NowUnixMs: startedAt.UnixMilli(),
	})
	ipcCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	reply, err := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
		StreamID: c.streamSeq.Add(1),
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  evalPayload,
	})
	if err != nil {
		return coreDispatchDirective{
			Action:    "reject",
			Status:    http.StatusServiceUnavailable,
			ErrorType: "core_unavailable",
			ErrorCode: "core_unreachable",
			Message:   "slipgate-core dataplane unreachable: " + err.Error(),
		}, false
	}
	var dir coreDispatchDirective
	_ = json.Unmarshal(reply.Payload, &dir)
	if dir.Action == "reject" {
		return dir, false
	}
	if !c.isClientIPAllowed(dir.APIKeyID, clientIP) {
		return coreDispatchDirective{
			Action:    "reject",
			Status:    http.StatusForbidden,
			ErrorType: "permission_error",
			ErrorCode: "ip_not_allowed",
			Message:   "client IP is not in API key allowlist",
		}, false
	}
	return dir, dir.APIKeyID != ""
}

func (c *Coordinator) handleStatefulResponsesRoute(w http.ResponseWriter, r *http.Request, requestID string, startedAt time.Time) {
	dir, ok := c.authenticateAPIKeyViaCore(r.Context(), r, requestID, startedAt)
	if !ok {
		setRetryAfter(w.Header(), dir.RetryAfterMs)
		WriteProtocolError(w, CodecOpenAIResponses, max(http.StatusUnauthorized, dir.Status), dir.ErrorType, dir.ErrorCode, dir.Message)
		return
	}
	rest := strings.TrimPrefix(strings.TrimSuffix(r.URL.Path, "/"), "/v1/responses/")
	if strings.HasSuffix(rest, "/input_items") && r.Method == http.MethodGet {
		respID := strings.TrimSuffix(rest, "/input_items")
		items, found := c.responsesState.inputItems(dir.APIKeyID, respID)
		if !found {
			WriteProtocolError(w, CodecOpenAIResponses, http.StatusNotFound, "not_found_error", "response_not_found", "Response not found")
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"object":   "list",
			"data":     items,
			"has_more": false,
		})
		return
	}

	respID := rest
	if r.Method == http.MethodDelete {
		if !c.responsesState.delete(dir.APIKeyID, respID) {
			WriteProtocolError(w, CodecOpenAIResponses, http.StatusNotFound, "not_found_error", "response_not_found", "Response not found")
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":      respID,
			"object":  "response.deleted",
			"deleted": true,
		})
		return
	}

	obj, found := c.responsesState.get(dir.APIKeyID, respID)
	if !found {
		WriteProtocolError(w, CodecOpenAIResponses, http.StatusNotFound, "not_found_error", "response_not_found", "Response not found")
		return
	}
	writeJSONResponse(w, http.StatusOK, obj)
}

func (c *Coordinator) handleGetVideoTask(w http.ResponseWriter, r *http.Request, requestID string, startedAt time.Time) {
	dir, ok := c.authenticateAPIKeyViaCore(r.Context(), r, requestID, startedAt)
	if !ok {
		setRetryAfter(w.Header(), dir.RetryAfterMs)
		WriteProtocolError(w, CodecOpenAIChat, max(http.StatusUnauthorized, dir.Status), dir.ErrorType, dir.ErrorCode, dir.Message)
		return
	}
	taskID := strings.TrimPrefix(strings.TrimSuffix(r.URL.Path, "/"), "/v1/videos/")
	task, found := c.mediaTasks.get(dir.APIKeyID, taskID)
	if !found {
		WriteProtocolError(w, CodecOpenAIChat, http.StatusNotFound, "not_found_error", "video_not_found", "Video generation task not found")
		return
	}
	sec, hasSec := c.vault.Get(task.accountID)
	if !hasSec {
		WriteProtocolError(w, CodecOpenAIChat, http.StatusServiceUnavailable, "overloaded_error", "account_secret_unavailable", "Upstream account credentials unavailable")
		return
	}
	if sec.IsMock() {
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"id":     task.taskID,
			"object": "video",
			"status": "completed",
			"model":  task.publicModel,
		})
		return
	}
	meta, _ := c.accountMetaFor(task.accountID)
	baseURL := resolveProviderBaseURL(task.provider, sec.BaseURL)
	targetURL := joinProviderPath(baseURL, "/v1/videos/"+task.taskID)
	reqCtx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	upReq, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		WriteProtocolError(w, CodecOpenAIChat, http.StatusBadRequest, "invalid_request_error", "bad_video_id", err.Error())
		return
	}
	applyUpstreamAuthHeaders(upReq, OutboundPersonaContext{
		Provider:      task.provider,
		AuthKind:      meta.AuthKind,
		ExecutionMode: meta.ExecutionMode,
		AccountID:     task.accountID,
	}, sec)
	resp, err := c.executeControlHTTPRequest(reqCtx, task.accountID, meta, sec, upReq)
	if err != nil {
		WriteProtocolError(w, CodecOpenAIChat, http.StatusBadGateway, "upstream_error", "outbound_dispatch_failed", err.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	w.Header().Set("Content-Type", firstNonEmpty(resp.Header.Get("Content-Type"), "application/json; charset=utf-8"))
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rewriteTopLevelModel(raw, CodecOpenAIChat, task.publicModel))
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

func (c *Coordinator) clientIPFromRequest(r *http.Request) string {
	if c != nil && c.trustedProxies != nil {
		return c.trustedProxies.ClientIP(r)
	}
	return extractClientIP(r)
}

func extractClientIP(r *http.Request) string {
	return netguard.ParseTrustedProxiesFromEnv().ClientIP(r)
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

type edgeKeyMeta struct {
	ID       string
	UserID   string
	GroupID  string
	Platform string
	Enabled  bool
}

func (c *Coordinator) groupPlatform(groupID string) string {
	c.mu.RLock()
	p := c.groupPlatforms[groupID]
	c.mu.RUnlock()
	return p
}

// upfrontKeyRejection is slipgate-core's 401 message for a key it is certain to refuse: a missing
// or malformed one, or (once a snapshot is applied) one the snapshot does not contain. "" = let
// the core decide (disabled keys, quotas, ...).
func (c *Coordinator) upfrontKeyRejection(apiKey string) string {
	if apiKey == "" || len(apiKey) > 512 {
		return "Missing or malformed API key"
	}
	c.mu.RLock()
	synced := c.snapshotApplied
	c.mu.RUnlock()
	if _, known := c.lookupKeyByPlaintext(apiKey); synced && !known {
		return "Invalid or revoked sk-sg-* API key"
	}
	return ""
}

func (c *Coordinator) lookupKeyByPlaintext(apiKey string) (edgeKeyMeta, bool) {
	trimmed := strings.TrimSpace(apiKey)
	if trimmed == "" {
		return edgeKeyMeta{}, false
	}
	sum := sha256.Sum256([]byte(trimmed))
	hashHex := hex.EncodeToString(sum[:])
	c.mu.RLock()
	meta, ok := c.keyByHash[hashHex]
	c.mu.RUnlock()
	return meta, ok
}

func (c *Coordinator) persistResponseStatePut(
	apiKeyID, respID, publicModel string,
	expiresAt time.Time,
	payload persistedResponseStatePayload,
) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	body, err := json.Marshal(map[string]any{
		"id":           respID,
		"apiKeyId":     apiKeyID,
		"kind":         "response_state",
		"publicModel":  publicModel,
		"status":       "completed",
		"expiresAtIso": expiresAt.UTC().Format(time.RFC3339),
		"resultJson":   payload,
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.bffOrigin+"/api/v1/internal/dataplane/media-tasks", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	if resp, err := c.bffClient.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))
		_ = resp.Body.Close()
	}
}

func (c *Coordinator) persistResponseStateGet(apiKeyID, respID string) (persistedResponseStatePayload, time.Time, bool) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return persistedResponseStatePayload{}, time.Time{}, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	target := fmt.Sprintf("%s/api/v1/internal/dataplane/media-tasks/response_state/%s?apiKeyId=%s",
		c.bffOrigin, url.PathEscape(respID), url.QueryEscape(apiKeyID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return persistedResponseStatePayload{}, time.Time{}, false
	}
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	resp, err := c.bffClient.Do(req)
	if err != nil {
		return persistedResponseStatePayload{}, time.Time{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return persistedResponseStatePayload{}, time.Time{}, false
	}
	var env struct {
		Item struct {
			ExpiresAtISO string                        `json:"expiresAtIso"`
			ResultJSON   persistedResponseStatePayload `json:"resultJson"`
		} `json:"item"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4*1024*1024)).Decode(&env) != nil {
		return persistedResponseStatePayload{}, time.Time{}, false
	}
	exp, err := time.Parse(time.RFC3339, env.Item.ExpiresAtISO)
	if err != nil {
		exp = time.Now().Add(responseStateTTL)
	}
	return env.Item.ResultJSON, exp, len(env.Item.ResultJSON.ResponseJSON) > 0
}

func (c *Coordinator) persistResponseStateDelete(apiKeyID, respID string) bool {
	if c.bffOrigin == "" || c.internalToken == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	target := fmt.Sprintf("%s/api/v1/internal/dataplane/media-tasks/response_state/%s?apiKeyId=%s",
		c.bffOrigin, url.PathEscape(respID), url.QueryEscape(apiKeyID))
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, target, nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	resp, err := c.bffClient.Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (c *Coordinator) persistMediaTaskPut(entry mediaTaskAffinity) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	body, err := json.Marshal(map[string]any{
		"id":             entry.taskID,
		"upstreamTaskId": entry.taskID,
		"apiKeyId":       entry.ownerKeyID,
		"userId":         entry.userID,
		"groupId":        entry.groupID,
		"accountId":      entry.accountID,
		"platform":       entry.provider,
		"kind":           "video",
		"publicModel":    entry.publicModel,
		"upstreamModel":  entry.upstreamModel,
		"status":         "pending",
		"expiresAtIso":   entry.expiresAt.UTC().Format(time.RFC3339),
		"resultJson":     map[string]any{},
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.bffOrigin+"/api/v1/internal/dataplane/media-tasks", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	if resp, err := c.bffClient.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))
		_ = resp.Body.Close()
	}
}

func (c *Coordinator) persistMediaTaskGet(apiKeyID, taskID string) (mediaTaskAffinity, bool) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return mediaTaskAffinity{}, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	target := fmt.Sprintf("%s/api/v1/internal/dataplane/media-tasks/video/%s?apiKeyId=%s",
		c.bffOrigin, url.PathEscape(taskID), url.QueryEscape(apiKeyID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return mediaTaskAffinity{}, false
	}
	req.Header.Set("X-Slipgate-Internal-Token", c.internalToken)
	resp, err := c.bffClient.Do(req)
	if err != nil {
		return mediaTaskAffinity{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return mediaTaskAffinity{}, false
	}
	var env struct {
		Item struct {
			ID            string `json:"id"`
			APIKeyID      string `json:"apiKeyId"`
			UserID        string `json:"userId"`
			GroupID       string `json:"groupId"`
			AccountID     string `json:"accountId"`
			Platform      string `json:"platform"`
			PublicModel   string `json:"publicModel"`
			UpstreamModel string `json:"upstreamModel"`
			ExpiresAtISO  string `json:"expiresAtIso"`
		} `json:"item"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(&env) != nil || env.Item.AccountID == "" {
		return mediaTaskAffinity{}, false
	}
	exp, err := time.Parse(time.RFC3339, env.Item.ExpiresAtISO)
	if err != nil {
		exp = time.Now().Add(24 * time.Hour)
	}
	return mediaTaskAffinity{
		taskID:        taskID,
		ownerKeyID:    apiKeyID,
		userID:        env.Item.UserID,
		groupID:       env.Item.GroupID,
		accountID:     env.Item.AccountID,
		provider:      env.Item.Platform,
		publicModel:   env.Item.PublicModel,
		upstreamModel: env.Item.UpstreamModel,
		expiresAt:     exp,
	}, true
}
