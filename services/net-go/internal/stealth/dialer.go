package stealth

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
)

const (
	defaultDialTimeout    = 12 * time.Second
	defaultRequestTimeout = 30 * time.Second
	maxSnippetBytes       = 4096
)

var (
	ipPattern        = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	errFallbackHTTP1 = errors.New("stealth: origin negotiated non-h2 ALPN, fallback to http/1.1")
)

// OutboundResult encapsulates the upstream HTTP response and uTLS handshake telemetry.
type OutboundResult struct {
	Response       *http.Response
	Target         clashpool.DialTarget
	TLSVersion     string
	NegotiatedALPN string
	LatencyMS      uint32
	ProfileIDUsed  string
}

type transportCacheKey struct {
	AccountID   string
	SocksAddr   string
	ProfileHash uint64
}

// AccountDialer executes fail-closed HTTPS/HTTP requests over account-bound Clash SOCKS5 tunnels with pooled uTLS transports.
type AccountDialer struct {
	pool *clashpool.Manager

	mu         sync.RWMutex
	profiles   map[string]ProfileSpec
	sessCaches map[string]utls.ClientSessionCache
	transports map[transportCacheKey]*http2AdaptiveTransport
	rootCAs    *x509.CertPool
}

// NewAccountDialer constructs an AccountDialer backed by Clash exit bindings and built-in uTLS profiles.
func NewAccountDialer(pool *clashpool.Manager) *AccountDialer {
	profiles := make(map[string]ProfileSpec)
	for _, p := range DefaultProfiles() {
		profiles[p.ID] = p.Clone()
	}
	return &AccountDialer{
		pool:       pool,
		profiles:   profiles,
		sessCaches: make(map[string]utls.ClientSessionCache),
		transports: make(map[transportCacheKey]*http2AdaptiveTransport),
	}
}

// SetRootCAs overrides trusted roots (used in unit tests with ephemeral TLS servers).
func (d *AccountDialer) SetRootCAs(roots *x509.CertPool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.rootCAs = roots
	d.invalidateAllTransportsLocked()
}

// ValidateProfile validates wire-level ClientHello invariants on spec.
func (d *AccountDialer) ValidateProfile(spec ProfileSpec) error {
	return ValidateProfile(spec)
}

// RegisterProfile adds or updates a profile in the dialer registry and invalidates stale cached transports.
func (d *AccountDialer) RegisterProfile(spec ProfileSpec) {
	if strings.TrimSpace(spec.ID) == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.profiles[spec.ID] = spec.Clone()
	d.invalidateAllTransportsLocked()
}

// UpdateProfile validates and updates an existing mutable profile, rejecting immutable built-ins or missing profiles.
func (d *AccountDialer) UpdateProfile(spec ProfileSpec) error {
	if err := ValidateProfile(spec); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	existing, ok := d.profiles[spec.ID]
	if !ok {
		return ErrUnknownProfile
	}
	if existing.BuiltIn {
		return ErrBuiltInProfileLock
	}
	cp := spec.Clone()
	cp.BuiltIn = false
	d.profiles[spec.ID] = cp
	d.invalidateAllTransportsLocked()
	return nil
}

// GetProfile returns a cloned ProfileSpec by ID.
func (d *AccountDialer) GetProfile(profileID string) (ProfileSpec, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	p, ok := d.profiles[profileID]
	if !ok {
		return ProfileSpec{}, false
	}
	return p.Clone(), true
}

// ListProfiles returns sorted built-in and custom uTLS profiles.
func (d *AccountDialer) ListProfiles() []ProfileSpec {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]ProfileSpec, 0, len(d.profiles))
	for _, p := range d.profiles {
		out = append(out, p.Clone())
	}
	slices.SortFunc(out, func(a, b ProfileSpec) int {
		if a.BuiltIn != b.BuiltIn {
			if a.BuiltIn {
				return -1
			}
			return 1
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// DeleteProfile removes a non-built-in profile from the registry and invalidates cached transports.
func (d *AccountDialer) DeleteProfile(profileID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.profiles[profileID]
	if !ok {
		return ErrUnknownProfile
	}
	if p.BuiltIn {
		return ErrBuiltInProfileLock
	}
	delete(d.profiles, profileID)
	d.invalidateAllTransportsLocked()
	return nil
}

// ResolveEffectiveProfile resolves requested/bound profile ID (including "auto" / "random" Rendezvous sticky selection).
func (d *AccountDialer) ResolveEffectiveProfile(accountID, requestedProfileID, osHint string) (ProfileSpec, error) {
	id := strings.TrimSpace(requestedProfileID)
	if id == "" && d.pool != nil {
		if binding, ok := d.pool.GetBinding(accountID); ok && binding.UTLSProfileID != "" {
			id = strings.TrimSpace(binding.UTLSProfileID)
		}
	}
	if id == "" {
		id = DefaultProfileID
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	if strings.EqualFold(id, AutoProfileID) || strings.EqualFold(id, "random") {
		candidates := make([]ProfileSpec, 0, len(d.profiles))
		for _, p := range d.profiles {
			candidates = append(candidates, p)
		}
		if chosen, ok := StickyProfileForAccount(accountID, candidates, osHint); ok {
			return chosen.Clone(), nil
		}
		if fallback, ok := d.profiles[DefaultProfileID]; ok {
			return fallback.Clone(), nil
		}
		return ProfileSpec{}, ErrUnknownProfile
	}

	spec, ok := d.profiles[id]
	if !ok {
		return ProfileSpec{}, ErrUnknownProfile
	}
	return spec.Clone(), nil
}

// DialAccountTLS establishes an authenticated SOCKS5 -> uTLS connection strictly bound to accountID's Clash node.
func (d *AccountDialer) DialAccountTLS(ctx context.Context, accountID, utlsProfileID, targetHostPort string) (*utls.UConn, clashpool.DialTarget, ProfileSpec, error) {
	target, err := d.pool.ResolveDialTarget(accountID)
	if err != nil {
		return nil, clashpool.DialTarget{}, ProfileSpec{}, err
	}
	spec, err := d.ResolveEffectiveProfile(accountID, utlsProfileID, "")
	if err != nil {
		return nil, clashpool.DialTarget{}, ProfileSpec{}, err
	}
	rawConn, err := dialThroughSOCKS5(ctx, target.SOCKSAddr, target.SocksUsername, target.SocksPassword, targetHostPort)
	if err != nil {
		return nil, target, spec, err
	}
	serverName := hostOnly(targetHostPort)
	d.mu.RLock()
	roots := d.rootCAs
	d.mu.RUnlock()
	uConn, err := BuildUConn(rawConn, serverName, spec, d.accountSessionCache(accountID), &utls.Config{
		RootCAs:    roots,
		MinVersion: tls.VersionTLS12,
	})
	if err != nil {
		_ = rawConn.Close()
		return nil, target, spec, err
	}
	if err := uConn.HandshakeContext(ctx); err != nil {
		_ = uConn.Close()
		return nil, target, spec, fmt.Errorf("stealth: uTLS handshake via %s (%s): %w", target.NodeID, spec.ID, err)
	}
	return uConn, target, spec, nil
}

// DoAccountRequest routes req fail-closed through accountID's Clash exit using a pooled adaptive H2/H1 uTLS transport.
func (d *AccountDialer) DoAccountRequest(ctx context.Context, accountID, utlsProfileID string, req *http.Request) (*OutboundResult, error) {
	if req == nil || req.URL == nil {
		return nil, errors.New("stealth: HTTP request URL is required")
	}
	target, err := d.pool.ResolveDialTarget(accountID)
	if err != nil {
		return nil, err
	}
	baseDial := func(dCtx context.Context, _ string, addr string) (net.Conn, error) {
		return dialThroughSOCKS5(dCtx, target.SOCKSAddr, target.SocksUsername, target.SocksPassword, addr)
	}
	return d.executeTransportRequest(ctx, accountID, target.SOCKSAddr, target, utlsProfileID, req, baseDial)
}

// DoDirectRequest routes req directly over an SSRF-validated TCP connection with uTLS ClientHello
// mimicry and adaptive H2/H1 pooling (so direct_api accounts match CLI TLS & wire headers without Clash).
func (d *AccountDialer) DoDirectRequest(ctx context.Context, accountID, utlsProfileID string, req *http.Request, allowPrivate bool) (*OutboundResult, error) {
	if req == nil || req.URL == nil {
		return nil, errors.New("stealth: HTTP request URL is required")
	}
	if err := netguard.ValidateOutboundURL(req.URL.String(), allowPrivate); err != nil {
		return nil, err
	}
	scope := "direct:public"
	if allowPrivate {
		scope = "direct:private"
	}
	target := clashpool.DialTarget{NodeID: "direct", ProxySlotID: "direct"}
	baseDial := netguard.NewSafeDialContext(defaultDialTimeout, allowPrivate)
	return d.executeTransportRequest(ctx, accountID, scope, target, utlsProfileID, req, baseDial)
}

func (d *AccountDialer) executeTransportRequest(
	ctx context.Context,
	accountID string,
	transportScope string,
	target clashpool.DialTarget,
	utlsProfileID string,
	req *http.Request,
	baseDial func(ctx context.Context, network, addr string) (net.Conn, error),
) (*OutboundResult, error) {
	spec, err := d.ResolveEffectiveProfile(accountID, utlsProfileID, "")
	if err != nil {
		return nil, err
	}
	start := time.Now()
	rt := d.getOrCreateTransport(accountID, transportScope, target.NodeID, spec, baseDial)

	outReq := req.Clone(ctx)
	if spec.UserAgentTemplate != "" && outReq.Header.Get("User-Agent") == "" {
		outReq.Header.Set("User-Agent", spec.UserAgentTemplate)
	}
	normalizeWireHeaderCasing(outReq.Header)

	resp, err := rt.RoundTrip(outReq)
	if err != nil {
		return nil, err
	}
	latency := uint32(max(1, int(time.Since(start).Milliseconds())))

	var tlsVer, negotiatedALPN string
	if resp.TLS != nil {
		tlsVer = formatTLSVersion(resp.TLS.Version)
		negotiatedALPN = resp.TLS.NegotiatedProtocol
	} else {
		tlsVer, negotiatedALPN = rt.lastHandshakeMeta()
	}

	return &OutboundResult{
		Response:       resp,
		Target:         target,
		TLSVersion:     tlsVer,
		NegotiatedALPN: negotiatedALPN,
		LatencyMS:      latency,
		ProfileIDUsed:  spec.ID,
	}, nil
}

func (d *AccountDialer) getOrCreateTransport(
	accountID string,
	transportScope string,
	nodeLabel string,
	spec ProfileSpec,
	baseDial func(ctx context.Context, network, addr string) (net.Conn, error),
) *http2AdaptiveTransport {
	key := transportCacheKey{
		AccountID:   accountID,
		SocksAddr:   transportScope,
		ProfileHash: ProfileCacheKey(spec),
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if existing, ok := d.transports[key]; ok {
		return existing
	}
	rt := newHTTP2AdaptiveTransport(
		spec,
		d.accountSessionCacheLocked(accountID),
		d.rootCAs,
		nodeLabel,
		baseDial,
	)
	d.transports[key] = rt
	return rt
}

// wireHeaderCasing restores exact CLI wire header casing right before RoundTrip, avoiding Go's
// canonical Title-Case keys for CLI-sensitive headers while leaving framing/encoding headers canonical.
var wireHeaderCasing = map[string]string{
	"x-stainless-retry-count":                   "X-Stainless-Retry-Count",
	"x-stainless-timeout":                       "X-Stainless-Timeout",
	"x-stainless-lang":                          "X-Stainless-Lang",
	"x-stainless-package-version":               "X-Stainless-Package-Version",
	"x-stainless-os":                            "X-Stainless-OS",
	"x-stainless-arch":                          "X-Stainless-Arch",
	"x-stainless-runtime":                       "X-Stainless-Runtime",
	"x-stainless-runtime-version":               "X-Stainless-Runtime-Version",
	"x-stainless-helper-method":                 "x-stainless-helper-method",
	"anthropic-dangerous-direct-browser-access": "anthropic-dangerous-direct-browser-access",
	"anthropic-version":                         "anthropic-version",
	"anthropic-beta":                            "anthropic-beta",
	"x-app":                                     "x-app",
	"x-api-key":                                 "x-api-key",
	"x-client-request-id":                       "x-client-request-id",
	"x-claude-code-session-id":                  "X-Claude-Code-Session-Id",
	"originator":                                "originator",
	"version":                                   "version",
	"session_id":                                "session_id",
	"session-id":                                "session-id",
	"conversation_id":                           "Conversation_id",
	"chatgpt-account-id":                        "chatgpt-account-id",
	"x-codex-window-id":                         "x-codex-window-id",
	"x-codex-installation-id":                   "x-codex-installation-id",
	"x-goog-api-client":                         "x-goog-api-client",
	"x-goog-api-key":                            "x-goog-api-key",
	"x-goog-device-id":                          "X-Goog-Device-Id",
	"client-metadata":                           "Client-Metadata",
	"x-dashscope-useragent":                     "X-DashScope-UserAgent",
	"x-dashscope-cachecontrol":                  "X-DashScope-CacheControl",
	"x-dashscope-authtype":                      "X-DashScope-AuthType",
	"x-grok-client-version":                     "x-grok-client-version",
	"x-grok-client-identifier":                  "x-grok-client-identifier",
	"x-grok-client-mode":                        "x-grok-client-mode",
	"x-authenticateresponse":                    "x-authenticateresponse",
	"x-xai-token-auth":                          "X-XAI-Token-Auth",
	"x-opencode-session":                        "X-OpenCode-Session",
}

func normalizeWireHeaderCasing(h http.Header) {
	if len(h) == 0 {
		return
	}
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	for _, k := range keys {
		wireKey, ok := wireHeaderCasing[strings.ToLower(k)]
		if !ok || wireKey == k {
			continue
		}
		vals := h[k]
		delete(h, k)
		h[wireKey] = append(h[wireKey], vals...)
	}
}

func (d *AccountDialer) invalidateAllTransportsLocked() {
	for k, rt := range d.transports {
		rt.CloseIdleConnections()
		delete(d.transports, k)
	}
}

func (d *AccountDialer) accountSessionCache(accountID string) utls.ClientSessionCache {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.accountSessionCacheLocked(accountID)
}

func (d *AccountDialer) accountSessionCacheLocked(accountID string) utls.ClientSessionCache {
	if c, ok := d.sessCaches[accountID]; ok {
		return c
	}
	c := utls.NewLRUClientSessionCache(64)
	d.sessCaches[accountID] = c
	return c
}

// http2AdaptiveTransport mirrors linksyncx's pooled H2/H1 RoundTripper sharing per-account ClientSessionCache.
type http2AdaptiveTransport struct {
	spec       ProfileSpec
	nodeLabel  string
	baseDial   func(ctx context.Context, network, addr string) (net.Conn, error)
	supportsH2 bool

	h1Hosts sync.Map // host[:port] -> struct{}
	metaMu  sync.RWMutex
	lastVer string
	lastALN string

	h2Transport *http2.Transport
	h1Transport *http.Transport
}

func newHTTP2AdaptiveTransport(
	spec ProfileSpec,
	sessCache utls.ClientSessionCache,
	roots *x509.CertPool,
	nodeLabel string,
	baseDial func(ctx context.Context, network, addr string) (net.Conn, error),
) *http2AdaptiveTransport {
	t := &http2AdaptiveTransport{
		spec:       spec.Clone(),
		nodeLabel:  nodeLabel,
		baseDial:   baseDial,
		supportsH2: spec.SupportsHTTP2(),
	}

	dialTLS := func(ctx context.Context, _ string, addr string, forceHTTP1 bool) (net.Conn, error) {
		rawConn, err := t.baseDial(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		profileForDial := t.spec
		if forceHTTP1 {
			profileForDial = t.spec.Clone()
			profileForDial.ALPNProtocols = []string{"http/1.1"}
		}
		uConn, err := BuildUConn(rawConn, hostOnly(addr), profileForDial, sessCache, &utls.Config{
			RootCAs:    roots,
			MinVersion: tls.VersionTLS12,
		})
		if err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		if err := uConn.HandshakeContext(ctx); err != nil {
			_ = uConn.Close()
			return nil, fmt.Errorf("stealth: uTLS handshake via %s (%s): %w", t.nodeLabel, profileForDial.ID, err)
		}
		st := uConn.ConnectionState()
		t.recordHandshakeMeta(formatTLSVersion(st.Version), st.NegotiatedProtocol)
		if !forceHTTP1 && t.supportsH2 && st.NegotiatedProtocol != "h2" {
			_ = uConn.Close()
			t.h1Hosts.Store(addr, struct{}{})
			return nil, errFallbackHTTP1
		}
		return &utlsStateConn{UConn: uConn}, nil
	}

	t.h2Transport = &http2.Transport{
		AllowHTTP: false,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return dialTLS(ctx, network, addr, false)
		},
		// Ping a connection that has been silent for ReadIdleTimeout and drop it when the ping goes
		// unanswered, so a dead exit node fails the streams on it instead of hanging them.
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	t.h1Transport = &http.Transport{
		Proxy:               nil,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return t.baseDial(ctx, network, addr)
		},
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialTLS(ctx, network, addr, true)
		},
	}
	return t
}

func (t *http2AdaptiveTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.EqualFold(req.URL.Scheme, "http") || !t.supportsH2 {
		return t.h1Transport.RoundTrip(req)
	}
	targetAddr := hostPortForURL(req.URL)
	if _, forcedH1 := t.h1Hosts.Load(targetAddr); forcedH1 {
		return t.h1Transport.RoundTrip(req)
	}

	resp, err := t.h2Transport.RoundTrip(req)
	if err == nil {
		return resp, nil
	}
	if !errors.Is(err, errFallbackHTTP1) {
		return nil, err
	}

	retryReq := req.Clone(req.Context())
	if req.GetBody != nil {
		body, bodyErr := req.GetBody()
		if bodyErr != nil {
			return nil, bodyErr
		}
		retryReq.Body = body
	} else if req.Body != nil && req.Body != http.NoBody {
		return nil, fmt.Errorf("stealth: cannot replay streaming request body after HTTP/1.1 ALPN downgrade: %w", err)
	}
	return t.h1Transport.RoundTrip(retryReq)
}

func (t *http2AdaptiveTransport) CloseIdleConnections() {
	t.h2Transport.CloseIdleConnections()
	t.h1Transport.CloseIdleConnections()
}

func (t *http2AdaptiveTransport) recordHandshakeMeta(ver, alpn string) {
	t.metaMu.Lock()
	t.lastVer = ver
	t.lastALN = alpn
	t.metaMu.Unlock()
}

func (t *http2AdaptiveTransport) lastHandshakeMeta() (string, string) {
	t.metaMu.RLock()
	defer t.metaMu.RUnlock()
	return t.lastVer, t.lastALN
}

// utlsStateConn adapts *utls.UConn to expose crypto/tls.ConnectionState for net/http and x/net/http2.
type utlsStateConn struct {
	*utls.UConn
}

func (c *utlsStateConn) ConnectionState() tls.ConnectionState {
	st := c.UConn.ConnectionState()
	return tls.ConnectionState{
		Version:            st.Version,
		HandshakeComplete:  st.HandshakeComplete,
		CipherSuite:        st.CipherSuite,
		NegotiatedProtocol: st.NegotiatedProtocol,
		ServerName:         st.ServerName,
		PeerCertificates:   st.PeerCertificates,
		VerifiedChains:     st.VerifiedChains,
	}
}

// ProbeExitIP connects directly through a SOCKS5 listener to verify external IP & latency.
func ProbeExitIP(ctx context.Context, socksAddr, username, password, ipEchoURL string, timeout time.Duration) (string, uint32, error) {
	if strings.TrimSpace(ipEchoURL) == "" {
		ipEchoURL = "https://api.ipify.org"
	}
	if timeout <= 0 {
		timeout = defaultDialTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	start := time.Now()
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(dCtx context.Context, _ string, addr string) (net.Conn, error) {
				return dialThroughSOCKS5(dCtx, socksAddr, username, password, addr)
			},
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, ipEchoURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "slipgate-probe/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", 0, err
	}
	if resp.StatusCode >= 400 {
		return "", 0, fmt.Errorf("ip echo returned status %d", resp.StatusCode)
	}
	ip := extractIPFromPayload(body)
	if ip == "" {
		return "", 0, fmt.Errorf("ip echo payload did not contain valid IP: %q", strings.TrimSpace(string(body)))
	}
	return ip, uint32(max(1, int(time.Since(start).Milliseconds()))), nil
}

func extractIPFromPayload(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if parsed := net.ParseIP(trimmed); parsed != nil {
		return parsed.String()
	}
	if match := ipPattern.FindString(trimmed); match != "" {
		if parsed := net.ParseIP(match); parsed != nil {
			return parsed.String()
		}
	}
	return ""
}

func dialThroughSOCKS5(ctx context.Context, socksAddr, username, password, targetAddr string) (net.Conn, error) {
	var auth *proxy.Auth
	if username != "" || password != "" {
		auth = &proxy.Auth{User: username, Password: password}
	}
	baseDialer := &net.Dialer{Timeout: defaultDialTimeout, KeepAlive: 30 * time.Second}
	socksDialer, err := proxy.SOCKS5("tcp", socksAddr, auth, baseDialer)
	if err != nil {
		return nil, fmt.Errorf("stealth: create SOCKS5 dialer (%s): %w", socksAddr, err)
	}
	if ctxDialer, ok := socksDialer.(proxy.ContextDialer); ok {
		return ctxDialer.DialContext(ctx, "tcp", targetAddr)
	}
	return socksDialer.Dial("tcp", targetAddr)
}

func hostOnly(hostPort string) string {
	host, _, err := net.SplitHostPort(hostPort)
	if err == nil {
		return host
	}
	return hostPort
}

func hostPortForURL(u *url.URL) string {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if strings.EqualFold(u.Scheme, "https") {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}

func formatTLSVersion(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "TLSv1.3"
	case tls.VersionTLS12:
		return "TLSv1.2"
	case tls.VersionTLS11:
		return "TLSv1.1"
	case tls.VersionTLS10:
		return "TLSv1.0"
	default:
		return "unknown"
	}
}

// Re-export buffer helper check so callers can inspect small snippets safely.
func readSnippet(r io.Reader) string {
	raw, _ := io.ReadAll(io.LimitReader(r, maxSnippetBytes))
	return string(bytes.TrimSpace(raw))
}
