package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
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
	Pattern               string `json:"pattern"`
	InputNanoPerMTok      string `json:"inputNanoPerMTok"`
	OutputNanoPerMTok     string `json:"outputNanoPerMTok"`
	CacheReadNanoPerMTok  string `json:"cacheReadNanoPerMTok"`
	CacheWriteNanoPerMTok string `json:"cacheWriteNanoPerMTok"`
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
	RevisionUnixMs int64                `json:"revisionUnixMs"`
	Groups         []SyncGroupInput     `json:"groups"`
	Routes         []SyncRouteInput     `json:"routes"`
	Accounts       []SyncAccountInput   `json:"accounts"`
	APIKeys        []SyncApiKeyInput    `json:"apiKeys"`
	Wallets        []SyncWalletInput    `json:"wallets"`
	PriceRules     []SyncPriceRuleInput `json:"priceRules"`
	RiskBans       []SyncRiskBanInput   `json:"riskBans"`
	UserLimits     *SyncUserLimitsInput `json:"userLimits"` // enforced in user_limits.go
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
	bffClient             *http.Client
	allowPrivateUpstreams bool
	trustedProxies        *netguard.TrustedProxies
	logger                *log.Logger
	streamSeq             atomic.Uint32
	settlements           *settlementOutbox

	// accessLogEnabled gates the per-turn http.access line (turn_log.go).
	accessLogEnabled func() bool

	mu                 sync.RWMutex
	keyIPAllowlists    map[string][]string
	keyIPDenylists     map[string][]string
	accountAuthKinds   map[string]string
	accountTiers       map[string]string
	accountMetas       map[string]accountMeta
	lastCoreSyncJSON   []byte
	lastRevisionUnixMs int64
	userLimits         userLimitGate // per-user / per-group caps (user_limits.go)
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
		directClient = netguard.NewSafeHTTPClient(120*time.Second, allowPrivate)
	}
	trustedProxies := opts.TrustedProxies
	if trustedProxies == nil {
		trustedProxies = netguard.ParseTrustedProxiesFromEnv()
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
		bffClient:             &http.Client{Timeout: 5 * time.Second},
		allowPrivateUpstreams: allowPrivate,
		trustedProxies:        trustedProxies,
		logger:                logger,
		accessLogEnabled: opts.AccessLogEnabled,
		keyIPAllowlists:  make(map[string][]string),
		keyIPDenylists:   make(map[string][]string),
		accountAuthKinds: make(map[string]string),
		accountTiers:     make(map[string]string),
		accountMetas:     make(map[string]accountMeta),
	}
	spoolDir := strings.TrimSpace(opts.SettlementSpoolDir)
	if spoolDir == "" {
		spoolDir = strings.TrimSpace(os.Getenv(SettlementSpoolDirEnv))
	}
	c.settlements = newSettlementOutbox(c.postSettlementOnce, logger, spoolDir)
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
	// Drain so the keep-alive connection is reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
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
	priceRules := snap.PriceRules
	if priceRules == nil {
		priceRules = []SyncPriceRuleInput{}
	}
	riskBans := snap.RiskBans
	if riskBans == nil {
		riskBans = []SyncRiskBanInput{}
	}

	corePayload, err := json.Marshal(map[string]any{
		"groups":     coreGroups,
		"routes":     routes,
		"accounts":   coreAccounts,
		"apiKeys":    coreKeys,
		"wallets":    coreWallets,
		"priceRules": priceRules,
		"riskBans":   riskBans,
	})
	if err != nil {
		return SyncAckResult{}, err
	}

	c.mu.Lock()
	c.keyIPAllowlists = nextIPAllowlists
	c.keyIPDenylists = nextIPDenylists
	c.accountAuthKinds = nextAuthKinds
	c.accountTiers = nextTiers
	c.accountMetas = nextMetas
	c.lastCoreSyncJSON = corePayload
	c.lastRevisionUnixMs = snap.RevisionUnixMs
	c.mu.Unlock()
	c.userLimits.apply(snap.UserLimits)

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
	// APIKeyID lets the core refuse a report whose hold id now names another turn's hold.
	APIKeyID         string `json:"apiKeyId,omitempty"`
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
		turn.AnthropicVersion = r.Header.Get("anthropic-version")
		turn.AnthropicBeta = r.Header.Get("anthropic-beta")
	}
	access.setTurn(turn)

	clientIP := c.clientIPFromRequest(r)
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
	replyFrame, ipcErr := dpbridge.ExchangeAuth(ipcCtx, c.coreIPC, c.internalToken, dpbridge.Frame{
		StreamID: streamID,
		Type:     dpbridge.FrameReqHeaders,
		Flags:    dpbridge.FlagEndStream,
		Payload:  evalPayload,
	})
	ipcCancel()
	if ipcErr != nil {
		c.logTurn("error", "slipgate-core dataplane unreachable: "+ipcErr.Error(), requestID, nil, turn.PublicModel)
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
		setRetryAfter(w.Header(), directive.RetryAfterMs)
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
			APIKeyID:         directive.APIKeyID,
			UpstreamStatus:   statusU16,
			InputTokens:      metrics.InputTokens,
			OutputTokens:     metrics.OutputTokens,
			CacheReadTokens:  metrics.CacheReadTokens,
			CacheWriteTokens: metrics.CacheWriteTokens,
			Window5hUsedBps:  metrics.Window5hUsedBps,
			Window7dUsedBps:  metrics.Window7dUsedBps,
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

		guestEndpoint := strings.TrimSpace(slot.GuestUDSPath)
		if guestEndpoint != "" && !strings.HasPrefix(guestEndpoint, "sandbox://") && !strings.HasPrefix(guestEndpoint, "ssh://") {
			pingCtx, pingCancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
			pingErr := dpbridge.Ping(pingCtx, guestEndpoint)
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
		c.logTurn("warn", "outbound dispatch failed: "+execErr.Error(), requestID, &directive, turn.PublicModel,
			"execution_mode", directive.ExecutionMode, "upstream_model", directive.UpstreamModel)
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
		// Structured (logx): the system log keeps the request, user, key, account, platform and model.
		c.logTurn("warn", fmt.Sprintf("stream relay interrupted: %v", relayErr), requestID, &directive, turn.PublicModel,
			"upstream_status", fmtInt(int64(metrics.UpstreamStatus)))
	}

	ack := settleHold(metrics)
	durationMs := elapsedMs(startedAt)

	c.postSettlementBounded(TurnSettlementEvent{
		SettlementID:     newSettlementID(),
		CoreSettled:      ack.settled,
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
		if err := netguard.ValidateOutboundURL(req.URL.String(), c.allowPrivateUpstreams); err != nil {
			return nil, err
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

// isSupportedDataPlaneRoute lists the AI endpoints the DataPlane implements. Anything else under
// /v1 (embeddings, images, files, ...) gets a clean 404 instead of being misread as a chat turn.
func isSupportedDataPlaneRoute(method, path string) bool {
	if path == "/mcp" || strings.HasPrefix(path, "/mcp/") {
		return true
	}
	if method == http.MethodGet {
		return path == "/v1/models" || strings.HasPrefix(path, "/v1/models/")
	}
	if method != http.MethodPost {
		return false
	}
	switch strings.TrimSuffix(path, "/") {
	case "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens":
		return true
	}
	if rest, ok := strings.CutPrefix(path, "/v1beta/models/"); ok {
		if idx := strings.LastIndexByte(rest, ':'); idx > 0 {
			switch rest[idx+1:] {
			case "generateContent", "streamGenerateContent", "countTokens":
				return true
			}
		}
	}
	return false
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
