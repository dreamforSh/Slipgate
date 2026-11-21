package clashpool

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashcore"
)

const (
	maxSubscriptionBytes = 10 << 20 // 10 MiB
	defaultProbeTimeout  = 10 * time.Second
)

// OutboundMeta describes the result of an HTTP/TLS verification request routed through a Clash node + uTLS profile.
type OutboundMeta struct {
	StatusCode     int        `json:"statusCode"`
	BodySnippet    string     `json:"bodySnippet"`
	Target         DialTarget `json:"-"`
	TLSVersion     string     `json:"tlsVersion"`
	NegotiatedALPN string     `json:"negotiatedAlpn"`
	LatencyMS      uint32     `json:"latencyMs"`
}

const (
	TLSProfileReasonKeyShareNotInCurves            = "TLS_PROFILE_KEY_SHARE_NOT_IN_CURVES"
	TLSProfileReasonKeyShareWithoutSupportedGroups = "TLS_PROFILE_KEY_SHARE_WITHOUT_SUPPORTED_GROUPS"
	TLSProfileReasonInvalid                        = "TLS_PROFILE_INVALID"
)

var (
	// ErrKeyShareWithoutSupportedGroups indicates key_share wire negotiation lacks extension 10 (supported_groups).
	ErrKeyShareWithoutSupportedGroups = errors.New("key_share extension requires supported_groups (extension 10)")
	// ErrBuiltInProfileLock indicates an immutable built-in TLS profile cannot be modified or deleted.
	ErrBuiltInProfileLock = errors.New("clashpool: built-in TLS profile cannot be modified or deleted")
)

// KeyShareNotInSupportedGroupsError identifies a key_share curve absent from curves/supported_groups.
type KeyShareNotInSupportedGroupsError struct {
	Group uint16
}

func (e *KeyShareNotInSupportedGroupsError) Error() string {
	return fmt.Sprintf("key_share group 0x%04x (%d) must be included in curves", e.Group, e.Group)
}

// TLSProfileValidationError carries structured diagnostics for HTTP/RPC error serialization.
type TLSProfileValidationError struct {
	Reason string
	Field  string
	Group  uint16
	Err    error
}

func (e *TLSProfileValidationError) Error() string {
	if e == nil || e.Err == nil {
		return "invalid TLS profile"
	}
	return e.Err.Error()
}

func (e *TLSProfileValidationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// StealthDialer decouples uTLS outbound operations from clashpool without creating package import cycles.
type StealthDialer interface {
	ListProfiles() []TLSProfile
	RegisterProfile(spec TLSProfile)
	UpdateProfile(spec TLSProfile) error
	DeleteProfile(profileID string) error
	ValidateProfile(spec TLSProfile) error
	TestAccountHTTP(ctx context.Context, accountID, utlsProfileID, targetURL string) (OutboundMeta, error)
	ProbeNodeExitIP(ctx context.Context, socksAddr, username, password, ipEchoURL string, timeout time.Duration) (string, uint32, error)
}

// RuntimeStatus summarizes embedded mihomo kernel health for ControlPlane dashboards.
type RuntimeStatus struct {
	Mode            string     `json:"mode"`
	Ready           bool       `json:"ready"`
	Version         string     `json:"version"`
	ConfigHash      string     `json:"configHash"`
	ActiveListeners int        `json:"activeListeners"`
	ActiveProxies   int        `json:"activeProxies"`
	LastReconciled  *time.Time `json:"lastReconciledAtIso"`
	LastError       string     `json:"lastError,omitempty"`
}

// CreateSubscriptionInput holds inputs to register a Clash subscription URL or inline payload.
type CreateSubscriptionInput struct {
	ID           string `json:"id,omitempty"`
	Name         string `json:"name"`
	SourceKind   string `json:"sourceKind"` // "url" | "inline"
	SourceURL    string `json:"sourceUrl"`
	UserAgent    string `json:"userAgent,omitempty"`
	ExcludeRegex string `json:"excludeRegex,omitempty"`
	AutoSync     bool   `json:"autoSync"`
}

// SyncResult reports the outcome of syncing a subscription into mihomo.
type SyncResult struct {
	Subscription     Subscription `json:"subscription"`
	Format           string       `json:"format"`
	TotalNodes       int          `json:"totalNodes"`
	SkippedCount     int          `json:"skippedCount"`
	SkippedByGuard   bool         `json:"skippedByDropGuard"`
	ConfigHash       string       `json:"configHash"`
	ActiveListeners  int          `json:"activeListeners"`
	ReconcileApplied bool         `json:"reconcileApplied"`
}

// ProbeOutcome reports one node's latency and optional exit IP check.
type ProbeOutcome struct {
	NodeID           string `json:"nodeId"`
	Name             string `json:"name"`
	Success          bool   `json:"success"`
	ExitIP           string `json:"exitIp"`
	LatencyMS        uint32 `json:"latencyMs"`
	Health           string `json:"healthStatus"`
	DriftUnconfirmed bool   `json:"driftUnconfirmed"`
	Error            string `json:"error,omitempty"`
}

// EnrichedNode combines Node metadata with live bound-account count for UI/API serialization.
type EnrichedNode struct {
	NodeID           string `json:"nodeId"`
	SubscriptionID   string `json:"subscriptionId"`
	Name             string `json:"name"`
	ProxySlotID      string `json:"proxySlotId"`
	ListenerPort     int    `json:"listenerPort"`
	ExitIP           string `json:"exitIp"`
	LatencyMS        uint32 `json:"latencyMs"`
	HealthStatus     string `json:"healthStatus"`
	DriftUnconfirmed bool   `json:"driftUnconfirmed"`
	BoundAccounts    int    `json:"boundAccounts"`
	MaxAccounts      int    `json:"maxAccounts"`
	ProxyType        string `json:"proxyType,omitempty"`
	Server           string `json:"server,omitempty"`
	ServerPort       int    `json:"serverPort,omitempty"`
	Enabled          bool   `json:"enabled"`
	LastProbedAtIso  string `json:"lastProbedAtIso,omitempty"`
	LastError        string `json:"lastError,omitempty"`
}

// PoolOverview aggregates full Clash & uTLS runtime state for the admin console.
type PoolOverview struct {
	Runtime       RuntimeStatus          `json:"runtime"`
	Subscriptions []Subscription         `json:"subscriptions"`
	Nodes         []EnrichedNode         `json:"nodes"`
	Bindings      []AccountBindingRecord `json:"bindings"`
	Profiles      []TLSProfile           `json:"profiles"`
	Policy        struct {
		MaxAccountsPerExitIP int     `json:"maxAccountsPerExitIp"`
		FailClosed           bool    `json:"failClosed"`
		DropGuardThreshold   float64 `json:"dropGuardThreshold"`
	} `json:"policy"`
}

// CoordinatorOptions configures NewCoordinator.
type CoordinatorOptions struct {
	Manager              *Manager
	Runtime              clashcore.Runtime
	Store                NetStore
	Stealth              StealthDialer
	Logger               *log.Logger
	ProbeURL             string
	IPEchoURL            string
	ProbeIntervalSec     int
	AllowLoopbackServers bool
	HTTPClient           *http.Client
}

// Coordinator ties together clashpool.Manager, embedded mihomo Runtime, NetStore, and StealthDialer.
type Coordinator struct {
	mgr              *Manager
	rt               clashcore.Runtime
	store            NetStore
	stealth          StealthDialer
	logger           *log.Logger
	probeURL         string
	ipEchoURL        string
	probeIntervalSec int
	allowLoopback    bool
	httpClient       *http.Client

	reconcileMu    sync.Mutex
	syncMu         sync.Mutex
	lastConfigHash string
	lastListeners  int
	lastProxies    int
	lastReconciled *time.Time
	lastRuntimeErr string

	trafficMu       sync.Mutex
	lastConnSamples map[string][2]int64
}

// NewCoordinator constructs a production Clash pool coordinator.
func NewCoordinator(opts CoordinatorOptions) *Coordinator {
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	probeURL := strings.TrimSpace(opts.ProbeURL)
	if probeURL == "" {
		probeURL = "https://www.gstatic.com/generate_204"
	}
	ipEchoURL := strings.TrimSpace(opts.IPEchoURL)
	if ipEchoURL == "" {
		ipEchoURL = "https://api.ipify.org?format=json"
	}
	httpCli := opts.HTTPClient
	if httpCli == nil {
		httpCli = &http.Client{Timeout: 15 * time.Second}
	}
	store := opts.Store
	if store == nil {
		store = NewMemoryNetStore()
	}
	rt := opts.Runtime
	if rt == nil {
		rt = clashcore.DisabledRuntime{}
	}

	return &Coordinator{
		mgr:              opts.Manager,
		rt:               rt,
		store:            store,
		stealth:          opts.Stealth,
		logger:           logger,
		probeURL:         probeURL,
		ipEchoURL:        ipEchoURL,
		probeIntervalSec: opts.ProbeIntervalSec,
		allowLoopback:    opts.AllowLoopbackServers,
		httpClient:       httpCli,
		lastConnSamples:  make(map[string][2]int64),
	}
}

// Bootstrap initializes storage, restores persisted TLS profiles/nodes/bindings, and applies mihomo config.
func (c *Coordinator) Bootstrap(ctx context.Context) error {
	if err := c.store.Init(ctx); err != nil {
		return err
	}

	// Ensure built-in TLS profiles exist in persistent storage (satisfying FK references in net.proxy_bindings).
	if c.stealth != nil {
		for _, builtIn := range c.stealth.ListProfiles() {
			if builtIn.BuiltIn {
				_ = c.store.UpsertTLSProfile(ctx, builtIn)
			}
		}
		savedProfiles, err := c.store.ListTLSProfiles(ctx)
		if err != nil {
			return fmt.Errorf("clashpool: load tls profiles: %w", err)
		}
		for _, p := range savedProfiles {
			c.stealth.RegisterProfile(p)
		}
	}

	nodes, err := c.store.ListNodes(ctx)
	if err != nil {
		return fmt.Errorf("clashpool: load nodes: %w", err)
	}
	for _, n := range nodes {
		c.mgr.UpsertNode(n)
	}

	bindings, err := c.store.ListBindings(ctx)
	if err != nil {
		return fmt.Errorf("clashpool: load bindings: %w", err)
	}
	for _, b := range bindings {
		c.mgr.RestoreBinding(b)
	}

	_, err = c.ReconcileRuntime(ctx)
	return err
}

// StartBackgroundTasks launches periodic node health/IP probes and runtime traffic accounting.
func (c *Coordinator) StartBackgroundTasks(ctx context.Context) {
	if c.probeIntervalSec > 0 {
		probeEvery := time.Duration(c.probeIntervalSec) * time.Second
		go func() {
			timer := time.NewTimer(15 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if _, err := c.ProbeNodes(ctx, nil, true, true); err != nil {
				c.logger.Printf("[clashpool] initial probe warning: %v", err)
			}

			ticker := time.NewTicker(probeEvery)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if _, err := c.ProbeNodes(ctx, nil, true, true); err != nil {
						c.logger.Printf("[clashpool] background probe warning: %v", err)
					}
				}
			}
		}()
	}

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.flushTrafficStats(ctx)
			}
		}
	}()
}

// RuntimeStatusSnapshot reports the current state of the mihomo core runtime.
func (c *Coordinator) RuntimeStatusSnapshot() RuntimeStatus {
	c.reconcileMu.Lock()
	defer c.reconcileMu.Unlock()
	var ts *time.Time
	if c.lastReconciled != nil {
		t := *c.lastReconciled
		ts = &t
	}
	return RuntimeStatus{
		Mode:            c.rt.Mode(),
		Ready:           c.rt.Ready(),
		Version:         c.rt.Version(),
		ConfigHash:      c.lastConfigHash,
		ActiveListeners: c.lastListeners,
		ActiveProxies:   c.lastProxies,
		LastReconciled:  ts,
		LastError:       c.lastRuntimeErr,
	}
}

// Overview returns complete state for ControlPlane API responses.
func (c *Coordinator) Overview(ctx context.Context) (PoolOverview, error) {
	subs, err := c.store.ListSubscriptions(ctx)
	if err != nil {
		return PoolOverview{}, err
	}
	var out PoolOverview
	out.Runtime = c.RuntimeStatusSnapshot()
	out.Subscriptions = subs
	if out.Subscriptions == nil {
		out.Subscriptions = []Subscription{}
	}
	out.Nodes = c.EnrichedNodes()
	out.Bindings = c.mgr.ListBindings()
	if out.Bindings == nil {
		out.Bindings = []AccountBindingRecord{}
	}
	if c.stealth != nil {
		out.Profiles = c.stealth.ListProfiles()
	}
	if out.Profiles == nil {
		out.Profiles = []TLSProfile{}
	}
	out.Policy.MaxAccountsPerExitIP = c.mgr.maxAccountsPerExit
	out.Policy.FailClosed = true
	out.Policy.DropGuardThreshold = c.mgr.dropGuardThreshold
	return out, nil
}

// EnrichedNodes converts current Manager nodes into sorted API views.
func (c *Coordinator) EnrichedNodes() []EnrichedNode {
	raw := c.mgr.Snapshot()
	out := make([]EnrichedNode, 0, len(raw))
	for _, n := range raw {
		var probedISO string
		if n.LastProbedAt != nil {
			probedISO = n.LastProbedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, EnrichedNode{
			NodeID:           n.ID,
			SubscriptionID:   n.SubscriptionID,
			Name:             n.Name,
			ProxySlotID:      n.ProxySlotID,
			ListenerPort:     n.ListenerPort,
			ExitIP:           n.ExitIP,
			LatencyMS:        n.LatencyMS,
			HealthStatus:     string(n.Health),
			DriftUnconfirmed: n.DriftUnconfirmed,
			BoundAccounts:    c.mgr.BoundCount(n.ID),
			MaxAccounts:      c.mgr.maxAccountsPerExit,
			ProxyType:        n.ProxyType,
			Server:           n.Server,
			ServerPort:       n.ServerPort,
			Enabled:          n.Enabled,
			LastProbedAtIso:  probedISO,
			LastError:        n.LastError,
		})
	}
	slices.SortFunc(out, func(a, b EnrichedNode) int {
		if a.ListenerPort != b.ListenerPort {
			return a.ListenerPort - b.ListenerPort
		}
		return strings.Compare(a.NodeID, b.NodeID)
	})
	return out
}

// CreateSubscription persists a new Clash subscription (and optionally triggers an initial sync).
func (c *Coordinator) CreateSubscription(ctx context.Context, input CreateSubscriptionInput) (Subscription, *SyncResult, error) {
	name := strings.TrimSpace(input.Name)
	source := strings.TrimSpace(input.SourceURL)
	if name == "" || source == "" {
		return Subscription{}, nil, errors.New("clashpool: subscription name and sourceUrl are required")
	}
	sourceKind := strings.ToLower(strings.TrimSpace(input.SourceKind))
	if sourceKind != "inline" {
		sourceKind = "url"
		if !strings.HasPrefix(strings.ToLower(source), "http://") && !strings.HasPrefix(strings.ToLower(source), "https://") {
			return Subscription{}, nil, errors.New("clashpool: URL subscription must use http:// or https://")
		}
	}

	subID := strings.TrimSpace(input.ID)
	if subID == "" {
		subID = "sub-" + randomHex(4)
	}
	ua := strings.TrimSpace(input.UserAgent)
	if ua == "" {
		ua = "clash.meta"
	}
	excludeRegex := input.ExcludeRegex
	if strings.TrimSpace(excludeRegex) == "" {
		excludeRegex = "剩余流量|到期时间|官网"
	}

	sub := Subscription{
		ID:             subID,
		Name:           name,
		SourceKind:     sourceKind,
		SourceURL:      source,
		UserAgent:      ua,
		ExcludeRegex:   excludeRegex,
		Enabled:        true,
		LastSyncStatus: "pending",
		CreatedAt:      time.Now().UTC(),
	}
	if err := c.store.UpsertSubscription(ctx, sub); err != nil {
		return Subscription{}, nil, err
	}

	if !input.AutoSync {
		return sub, nil, nil
	}
	res, syncErr := c.SyncSubscription(ctx, sub.ID, true)
	if syncErr != nil {
		updated, _ := c.store.GetSubscription(ctx, sub.ID)
		return updated, &res, syncErr
	}
	return res.Subscription, &res, nil
}

// DeleteSubscription removes a subscription, clears bindings & nodes, and re-reconciles mihomo.
func (c *Coordinator) DeleteSubscription(ctx context.Context, subID string) error {
	c.syncMu.Lock()
	defer c.syncMu.Unlock()

	removed := c.mgr.RemoveSubscriptionNodes(subID)
	if err := c.store.DeleteSubscription(ctx, subID); err != nil {
		return err
	}
	listenerNames := make([]string, 0, len(removed))
	for _, id := range removed {
		listenerNames = append(listenerNames, clashcore.ListenerName(id))
	}
	c.rt.CloseInboundConnections(listenerNames)
	_, err := c.ReconcileRuntime(ctx)
	return err
}

// SyncSubscription downloads or reads subID's payload, sanitizes nodes, checks drop-guard,
// allocates stable SOCKS5 listener ports, persists state, and applies mihomo configuration.
func (c *Coordinator) SyncSubscription(ctx context.Context, subID string, force bool) (SyncResult, error) {
	c.syncMu.Lock()
	defer c.syncMu.Unlock()

	sub, err := c.store.GetSubscription(ctx, subID)
	if err != nil {
		return SyncResult{}, err
	}

	var rawBody []byte
	if sub.SourceKind == "inline" {
		rawBody = []byte(sub.SourceURL)
	} else {
		rawBody, err = c.fetchSubscriptionURL(ctx, sub.SourceURL, sub.UserAgent)
		if err != nil {
			now := time.Now().UTC()
			sub.LastSyncAt = &now
			sub.LastSyncStatus = "fetch_error: " + err.Error()
			_ = c.store.UpsertSubscription(ctx, sub)
			return SyncResult{Subscription: sub}, err
		}
	}

	parsed, err := clashcore.ParseSubscription(rawBody, clashcore.ParseOptions{
		ExcludeRegex:         sub.ExcludeRegex,
		AllowLoopbackServers: c.allowLoopback,
	})
	if err != nil {
		now := time.Now().UTC()
		sub.LastSyncAt = &now
		sub.LastSyncStatus = "parse_error: " + err.Error()
		_ = c.store.UpsertSubscription(ctx, sub)
		return SyncResult{Subscription: sub}, err
	}

	existingByID := make(map[string]Node)
	for _, n := range c.mgr.Snapshot() {
		existingByID[n.ID] = n
	}
	usedPorts := c.mgr.AllocatedPorts()

	incoming := make([]Node, 0, len(parsed.Nodes))
	nameSeq := make(map[string]int, len(parsed.Nodes))
	for _, pn := range parsed.Nodes {
		baseKey := fmt.Sprintf("%s|%s|%s:%d", sub.ID, pn.Type, pn.Server, pn.Port)
		occ := nameSeq[baseKey]
		nameSeq[baseKey] = occ + 1
		nodeID := deterministicNodeID(fmt.Sprintf("%s#%d", baseKey, occ))

		node := Node{
			ID:             nodeID,
			SubscriptionID: sub.ID,
			Name:           pn.Name,
			ProxyType:      pn.Type,
			Server:         pn.Server,
			ServerPort:     pn.Port,
			RawConfig:      pn.Config,
			Enabled:        true,
		}
		if prev, ok := existingByID[nodeID]; ok {
			node.ProxySlotID = prev.ProxySlotID
			node.ListenerPort = prev.ListenerPort
			node.SocksUsername = prev.SocksUsername
			node.SocksPassword = prev.SocksPassword
			node.Enabled = prev.Enabled
		} else {
			port, allocErr := allocateFreePort(c.mgr.portMin, c.mgr.portMax, usedPorts)
			if allocErr != nil {
				return SyncResult{Subscription: sub}, allocErr
			}
			usedPorts[port] = struct{}{}
			node.ListenerPort = port
			node.ProxySlotID = fmt.Sprintf("slot-%d", port)
			node.SocksUsername = "sg-" + nodeID
			node.SocksPassword = randomHex(12)
		}
		incoming = append(incoming, node)
	}

	report, syncErr := c.mgr.SyncNodes(sub.ID, incoming, force)
	now := time.Now().UTC()
	sub.LastSyncAt = &now
	if syncErr != nil {
		if report.SkippedByDropGuard {
			sub.LastSyncStatus = "drop_guard_blocked"
		} else {
			sub.LastSyncStatus = "error: " + syncErr.Error()
		}
		_ = c.store.UpsertSubscription(ctx, sub)
		return SyncResult{
			Subscription:   sub,
			Format:         string(parsed.Format),
			TotalNodes:     len(incoming),
			SkippedCount:   len(parsed.Skipped),
			SkippedByGuard: report.SkippedByDropGuard,
		}, syncErr
	}

	// Persist all subscription nodes (including circuit-opened placeholders absent from latest feed).
	var toPersist []Node
	for _, n := range c.mgr.Snapshot() {
		if n.SubscriptionID == sub.ID {
			toPersist = append(toPersist, n)
		}
	}
	if err := c.store.UpsertNodes(ctx, toPersist); err != nil {
		return SyncResult{Subscription: sub}, err
	}

	sub.LastSyncStatus = "ok"
	sub.LastNodeCount = len(incoming)
	if err := c.store.UpsertSubscription(ctx, sub); err != nil {
		return SyncResult{Subscription: sub}, err
	}

	applied, err := c.ReconcileRuntime(ctx)
	if err != nil {
		return SyncResult{Subscription: sub}, err
	}

	st := c.RuntimeStatusSnapshot()
	return SyncResult{
		Subscription:     sub,
		Format:           string(parsed.Format),
		TotalNodes:       len(incoming),
		SkippedCount:     len(parsed.Skipped),
		SkippedByGuard:   false,
		ConfigHash:       st.ConfigHash,
		ActiveListeners:  st.ActiveListeners,
		ReconcileApplied: applied,
	}, nil
}

// ReconcileRuntime renders deterministic fail-closed mihomo config from current Manager state
// and applies it only if the content SHA-256 differs from the last applied configuration.
func (c *Coordinator) ReconcileRuntime(ctx context.Context) (bool, error) {
	c.reconcileMu.Lock()
	defer c.reconcileMu.Unlock()

	nodes := c.mgr.Snapshot()
	renderNodes := make([]clashcore.RenderNode, 0, len(nodes))
	for _, n := range nodes {
		active := n.Enabled && !n.DriftUnconfirmed && n.Health != HealthCircuitOpen && len(n.RawConfig) > 0
		renderNodes = append(renderNodes, clashcore.RenderNode{
			NodeID:     n.ID,
			ListenPort: n.ListenerPort,
			Username:   n.SocksUsername,
			Password:   n.SocksPassword,
			Active:     active,
			Config:     n.RawConfig,
		})
	}

	rendered, err := clashcore.RenderConfig(renderNodes, clashcore.RenderOptions{
		ListenAddress: "127.0.0.1",
	})
	if err != nil {
		c.lastRuntimeErr = err.Error()
		return false, err
	}

	if rendered.Hash == c.lastConfigHash {
		return false, nil
	}

	if err := c.rt.Apply(ctx, rendered.Payload); err != nil {
		c.lastRuntimeErr = err.Error()
		return false, err
	}

	now := time.Now().UTC()
	c.lastConfigHash = rendered.Hash
	c.lastListeners = rendered.Listeners
	c.lastProxies = rendered.ActiveProxies
	c.lastReconciled = &now
	c.lastRuntimeErr = ""
	return true, nil
}

// ProbeNodes checks latency (through mihomo DelayTest) and optionally verifies actual exit IP via SOCKS5h.
func (c *Coordinator) ProbeNodes(ctx context.Context, nodeIDs []string, verifyExitIP, guardGlobalFailure bool) ([]ProbeOutcome, error) {
	targets := c.selectNodesForProbe(nodeIDs)
	if len(targets) == 0 {
		return []ProbeOutcome{}, nil
	}

	type rawResult struct {
		node    Node
		exitIP  string
		latency uint32
		errMsg  string
		success bool
	}

	results := make([]rawResult, len(targets))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)

	for i, node := range targets {
		wg.Add(1)
		go func(idx int, n Node) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			r := rawResult{node: n}
			delay, err := c.rt.DelayTest(ctx, clashcore.ProxyName(n.ID), c.probeURL)
			if err != nil {
				r.errMsg = err.Error()
				results[idx] = r
				return
			}
			r.latency = uint32(delay.Milliseconds())

			if (verifyExitIP || n.ExitIP == "") && c.stealth != nil && n.Enabled {
				socksAddr := fmt.Sprintf("127.0.0.1:%d", n.ListenerPort)
				ip, echoMS, ipErr := c.stealth.ProbeNodeExitIP(ctx, socksAddr, n.SocksUsername, n.SocksPassword, c.ipEchoURL, defaultProbeTimeout)
				if ipErr != nil {
					r.errMsg = ipErr.Error()
					results[idx] = r
					return
				}
				r.exitIP = ip
				if r.latency == 0 {
					r.latency = echoMS
				}
			}

			r.success = true
			results[idx] = r
		}(i, node)
	}
	wg.Wait()

	failures := 0
	for _, r := range results {
		if !r.success {
			failures++
		}
	}
	suppressGlobal := guardGlobalFailure && len(results) >= 5 && float64(failures) >= 0.8*float64(len(results))

	outcomes := make([]ProbeOutcome, 0, len(results))
	var trippedListeners []string
	now := time.Now().UTC()

	for _, r := range results {
		if r.success || !suppressGlobal {
			_ = c.mgr.ReportProbe(r.node.ID, r.exitIP, r.latency, r.success)
		}
		if r.errMsg != "" {
			c.mgr.SetNodeProbeError(r.node.ID, now, r.errMsg)
		} else {
			c.mgr.SetNodeProbeError(r.node.ID, now, "")
		}

		updated, _ := c.mgr.GetNode(r.node.ID)
		_ = c.store.UpdateNodeRuntime(ctx, updated)

		if updated.Health == HealthCircuitOpen || updated.DriftUnconfirmed {
			trippedListeners = append(trippedListeners, clashcore.ListenerName(updated.ID))
		}
		outcomes = append(outcomes, ProbeOutcome{
			NodeID:           updated.ID,
			Name:             updated.Name,
			Success:          r.success,
			ExitIP:           updated.ExitIP,
			LatencyMS:        updated.LatencyMS,
			Health:           string(updated.Health),
			DriftUnconfirmed: updated.DriftUnconfirmed,
			Error:            r.errMsg,
		})
	}

	if len(trippedListeners) > 0 {
		_, _ = c.ReconcileRuntime(ctx)
		c.rt.CloseInboundConnections(trippedListeners)
	}
	return outcomes, nil
}

// ConfirmDrift clears the drift lock on nodeID, updates Postgres, and re-enables the mihomo listener.
func (c *Coordinator) ConfirmDrift(ctx context.Context, nodeID string) (Node, error) {
	if err := c.mgr.ConfirmExitDrift(nodeID); err != nil {
		return Node{}, err
	}
	updated, _ := c.mgr.GetNode(nodeID)
	if err := c.store.UpdateNodeRuntime(ctx, updated); err != nil {
		return Node{}, err
	}
	if _, err := c.ReconcileRuntime(ctx); err != nil {
		return Node{}, err
	}
	return updated, nil
}

// SetNodeEnabled toggles a node on/off, saves state, closes active connections when disabled, and reconciles mihomo.
func (c *Coordinator) SetNodeEnabled(ctx context.Context, nodeID string, enabled bool) (Node, error) {
	updated, err := c.mgr.SetNodeEnabled(nodeID, enabled)
	if err != nil {
		return Node{}, err
	}
	if err := c.store.UpdateNodeRuntime(ctx, updated); err != nil {
		return Node{}, err
	}
	if !enabled {
		c.rt.CloseInboundConnections([]string{clashcore.ListenerName(nodeID)})
	}
	if _, err := c.ReconcileRuntime(ctx); err != nil {
		return Node{}, err
	}
	return updated, nil
}

// BindAccount binds an upstream account to an exit node (and optional uTLS profile) strictly enforcing 1-exit-IP uniqueness.
func (c *Coordinator) BindAccount(ctx context.Context, accountID, nodeID, utlsProfileID string, isShadowFollower bool) (AccountBindingRecord, error) {
	if err := c.mgr.BindAccountWithProfile(accountID, nodeID, isShadowFollower, utlsProfileID); err != nil {
		return AccountBindingRecord{}, err
	}
	rec, ok := c.mgr.GetBinding(accountID)
	if !ok {
		return AccountBindingRecord{}, errors.New("clashpool: binding missing after insert")
	}
	if err := c.store.UpsertBinding(ctx, rec); err != nil {
		return AccountBindingRecord{}, err
	}
	return rec, nil
}

// UnbindAccount removes an account's exit binding cleanly.
func (c *Coordinator) UnbindAccount(ctx context.Context, accountID string) error {
	c.mgr.UnbindAccount(accountID)
	return c.store.DeleteBinding(ctx, accountID)
}

// ListTLSProfiles returns built-in + custom uTLS profiles.
func (c *Coordinator) ListTLSProfiles() []TLSProfile {
	if c.stealth == nil {
		return nil
	}
	return c.stealth.ListProfiles()
}

// CreateTLSProfile validates and persists a custom uTLS fingerprint profile.
func (c *Coordinator) CreateTLSProfile(ctx context.Context, profile TLSProfile) (TLSProfile, error) {
	profile.ID = strings.TrimSpace(profile.ID)
	profile.Name = strings.TrimSpace(profile.Name)
	if profile.ID == "" {
		profile.ID = "tls-" + randomHex(4)
	}
	if profile.ID == "auto" || profile.ID == "random" {
		return TLSProfile{}, &TLSProfileValidationError{
			Reason: TLSProfileReasonInvalid,
			Field:  "id",
			Err:    fmt.Errorf("clashpool: TLS profile id %q is reserved", profile.ID),
		}
	}
	if profile.Name == "" {
		return TLSProfile{}, &TLSProfileValidationError{
			Reason: TLSProfileReasonInvalid,
			Field:  "name",
			Err:    errors.New("clashpool: TLS profile name is required"),
		}
	}
	if strings.TrimSpace(profile.ClientHelloPreset) == "" {
		if profile.HasCustomWireSpec() {
			profile.ClientHelloPreset = "custom_wire"
		} else {
			profile.ClientHelloPreset = "chrome_auto"
		}
	}
	if len(profile.ALPNProtocols) == 0 {
		profile.ALPNProtocols = []string{"h2", "http/1.1"}
	}
	profile.BuiltIn = false

	if c.stealth != nil {
		if err := c.stealth.ValidateProfile(profile); err != nil {
			return TLSProfile{}, err
		}
	}
	if err := c.store.UpsertTLSProfile(ctx, profile); err != nil {
		return TLSProfile{}, err
	}
	if c.stealth != nil {
		c.stealth.RegisterProfile(profile)
	}
	return profile, nil
}

// UpdateTLSProfile validates and persists modifications to an existing non-built-in TLS profile.
func (c *Coordinator) UpdateTLSProfile(ctx context.Context, profileID string, patch TLSProfile) (TLSProfile, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return TLSProfile{}, &TLSProfileValidationError{
			Reason: TLSProfileReasonInvalid,
			Field:  "id",
			Err:    errors.New("clashpool: TLS profile id is required"),
		}
	}
	var existing *TLSProfile
	for _, p := range c.ListTLSProfiles() {
		if p.ID == profileID {
			cp := p.Clone()
			existing = &cp
			break
		}
	}
	if existing == nil {
		return TLSProfile{}, ErrProfileNotFound
	}
	if existing.BuiltIn {
		return TLSProfile{}, ErrBuiltInProfileLock
	}

	patch.ID = profileID
	patch.BuiltIn = false
	patch.Name = strings.TrimSpace(patch.Name)
	if patch.Name == "" {
		patch.Name = existing.Name
	}
	if strings.TrimSpace(patch.ClientHelloPreset) == "" {
		if patch.HasCustomWireSpec() {
			patch.ClientHelloPreset = "custom_wire"
		} else if existing.ClientHelloPreset != "" {
			patch.ClientHelloPreset = existing.ClientHelloPreset
		} else {
			patch.ClientHelloPreset = "chrome_auto"
		}
	}
	if len(patch.ALPNProtocols) == 0 {
		if len(existing.ALPNProtocols) > 0 {
			patch.ALPNProtocols = append([]string(nil), existing.ALPNProtocols...)
		} else {
			patch.ALPNProtocols = []string{"h2", "http/1.1"}
		}
	}

	if c.stealth != nil {
		if err := c.stealth.ValidateProfile(patch); err != nil {
			return TLSProfile{}, err
		}
	}
	if err := c.store.UpsertTLSProfile(ctx, patch); err != nil {
		return TLSProfile{}, err
	}
	if c.stealth != nil {
		if err := c.stealth.UpdateProfile(patch); err != nil {
			return TLSProfile{}, err
		}
	}
	return patch, nil
}

// DeleteTLSProfile deletes a non-built-in TLS profile from both runtime registry and net.tls_profiles.
func (c *Coordinator) DeleteTLSProfile(ctx context.Context, profileID string) error {
	if c.stealth != nil {
		if err := c.stealth.DeleteProfile(profileID); err != nil {
			return err
		}
	}
	return c.store.DeleteTLSProfile(ctx, profileID)
}

// TestAccountOutbound runs an actual HTTPS/HTTP request through accountID's bound Clash exit using uTLS.
func (c *Coordinator) TestAccountOutbound(ctx context.Context, accountID, utlsProfileID, targetURL string) (OutboundMeta, error) {
	if c.stealth == nil {
		return OutboundMeta{}, errors.New("clashpool: stealth dialer unavailable")
	}
	if strings.TrimSpace(targetURL) == "" {
		targetURL = c.ipEchoURL
	}
	if utlsProfileID == "" {
		if b, ok := c.mgr.GetBinding(accountID); ok && b.UTLSProfileID != "" {
			utlsProfileID = b.UTLSProfileID
		}
	}
	return c.stealth.TestAccountHTTP(ctx, accountID, utlsProfileID, targetURL)
}

func (c *Coordinator) selectNodesForProbe(nodeIDs []string) []Node {
	all := c.mgr.Snapshot()
	if len(nodeIDs) == 0 {
		var out []Node
		for _, n := range all {
			if n.Enabled {
				out = append(out, n)
			}
		}
		return out
	}
	wanted := make(map[string]struct{}, len(nodeIDs))
	for _, id := range nodeIDs {
		wanted[id] = struct{}{}
	}
	var out []Node
	for _, n := range all {
		if _, ok := wanted[n.ID]; ok {
			out = append(out, n)
		}
	}
	return out
}

func (c *Coordinator) fetchSubscriptionURL(ctx context.Context, rawURL, userAgent string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("subscription HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSubscriptionBytes {
		return nil, fmt.Errorf("subscription exceeds %d bytes", maxSubscriptionBytes)
	}
	return data, nil
}

func (c *Coordinator) flushTrafficStats(ctx context.Context) {
	conns := c.rt.Connections()
	if len(conns) == 0 {
		return
	}

	c.trafficMu.Lock()
	defer c.trafficMu.Unlock()

	activeIDs := make(map[string]struct{}, len(conns))
	deltas := make(map[string][2]int64)
	for _, conn := range conns {
		activeIDs[conn.ID] = struct{}{}
		nodeID, ok := strings.CutPrefix(conn.Inbound, "sg-l-")
		if !ok || nodeID == "" {
			continue
		}
		prev := c.lastConnSamples[conn.ID]
		upDelta := max(0, conn.Upload-prev[0])
		downDelta := max(0, conn.Download-prev[1])
		c.lastConnSamples[conn.ID] = [2]int64{conn.Upload, conn.Download}
		if upDelta > 0 || downDelta > 0 {
			cur := deltas[nodeID]
			cur[0] += upDelta
			cur[1] += downDelta
			deltas[nodeID] = cur
		}
	}
	for id := range c.lastConnSamples {
		if _, alive := activeIDs[id]; !alive {
			delete(c.lastConnSamples, id)
		}
	}

	today := time.Now().UTC()
	for nodeID, pair := range deltas {
		_ = c.store.AddDailyTraffic(ctx, nodeID, today, pair[0], pair[1])
	}
}

func deterministicNodeID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "node-" + hex.EncodeToString(sum[:6])
}

func randomHex(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf)
}

func allocateFreePort(portMin, portMax int, used map[int]struct{}) (int, error) {
	if portMin <= 0 {
		portMin = 20000
	}
	if portMax < portMin {
		portMax = portMin
	}
	for port := portMin; port <= portMax; port++ {
		if _, taken := used[port]; !taken {
			return port, nil
		}
	}
	return 0, fmt.Errorf("clashpool: no free listener ports in [%d,%d]", portMin, portMax)
}
