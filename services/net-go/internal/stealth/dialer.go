package stealth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

const (
	defaultDialTimeout      = 10 * time.Second
	defaultHandshakeTimeout = 10 * time.Second
	defaultSessionCacheSize = 32
)

var (
	ErrUnknownProfile     = errors.New("stealth: unknown uTLS profile")
	ErrBuiltInProfileLock = errors.New("stealth: built-in uTLS profile cannot be deleted")
	errNeedHTTP1Fallback  = errors.New("stealth: peer negotiated http/1.1 instead of h2")
)

// OutboundResult captures the HTTP response alongside the exact Clash exit & uTLS negotiation traits.
type OutboundResult struct {
	Response       *http.Response
	DialTarget     clashpool.DialTarget
	TLSVersion     string
	NegotiatedALPN string
	LatencyMS      uint32
}

// AccountDialer establishes outbound connections strictly through an account's bound Clash exit
// with per-account isolated uTLS ClientHello fingerprints and TLS session ticket caches.
type AccountDialer struct {
	pool             *clashpool.Manager
	baseDial         net.Dialer
	handshakeTimeout time.Duration
	rootCAs          *x509.CertPool

	mu            sync.RWMutex
	profiles      map[string]ProfileSpec
	sessionCaches map[string]utls.ClientSessionCache
}

// NewAccountDialer constructs an AccountDialer backed by a Clash exit pool and seeded with built-in uTLS presets.
func NewAccountDialer(pool *clashpool.Manager) *AccountDialer {
	d := &AccountDialer{
		pool: pool,
		baseDial: net.Dialer{
			Timeout:   defaultDialTimeout,
			KeepAlive: 30 * time.Second,
		},
		handshakeTimeout: defaultHandshakeTimeout,
		profiles:         make(map[string]ProfileSpec),
		sessionCaches:    make(map[string]utls.ClientSessionCache),
	}
	for _, spec := range DefaultProfiles() {
		d.RegisterProfile(spec)
	}
	return d
}

// SetRootCAs overrides the X.509 trust roots used during uTLS verification (primarily for tests).
func (d *AccountDialer) SetRootCAs(pool *x509.CertPool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.rootCAs = pool
}

// RegisterProfile stores or updates a TLS fingerprint profile template.
func (d *AccountDialer) RegisterProfile(spec ProfileSpec) {
	d.mu.Lock()
	defer d.mu.Unlock()
	clone := spec
	clone.ALPNProtocols = slices.Clone(spec.ALPNProtocols)
	d.profiles[spec.ID] = clone
}

// GetProfile looks up a registered profile by ID.
func (d *AccountDialer) GetProfile(profileID string) (ProfileSpec, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	p, ok := d.profiles[profileID]
	if !ok {
		return ProfileSpec{}, false
	}
	p.ALPNProtocols = slices.Clone(p.ALPNProtocols)
	return p, true
}

// ListProfiles returns a stable snapshot of registered uTLS profiles (built-ins first, then sorted by ID).
func (d *AccountDialer) ListProfiles() []ProfileSpec {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]ProfileSpec, 0, len(d.profiles))
	for _, p := range d.profiles {
		clone := p
		clone.ALPNProtocols = slices.Clone(p.ALPNProtocols)
		out = append(out, clone)
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

// DeleteProfile deletes a non-built-in TLS fingerprint profile.
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
	return nil
}

// DialAccountExit resolves the account's Clash SOCKS5 listener (fail-closed), validates the profile,
// and opens a TCP connection to the local mihomo listener.
func (d *AccountDialer) DialAccountExit(ctx context.Context, accountID, utlsProfileID string) (net.Conn, clashpool.DialTarget, error) {
	target, _, err := d.resolveAccountAndProfile(accountID, utlsProfileID)
	if err != nil {
		return nil, clashpool.DialTarget{}, err
	}
	conn, err := d.baseDial.DialContext(ctx, "tcp", target.SOCKSAddr)
	if err != nil {
		return nil, clashpool.DialTarget{}, fmt.Errorf("stealth: failed dialing Clash listener %s: %w", target.SOCKSAddr, err)
	}
	return conn, target, nil
}

// DialAccountTarget tunnels via the account's Clash SOCKS5h listener to targetAddr and optionally performs a uTLS handshake.
func (d *AccountDialer) DialAccountTarget(
	ctx context.Context,
	accountID, utlsProfileID, targetAddr string,
	useTLS, allowH2 bool,
) (net.Conn, clashpool.DialTarget, error) {
	target, profile, err := d.resolveAccountAndProfile(accountID, utlsProfileID)
	if err != nil {
		return nil, clashpool.DialTarget{}, err
	}

	rawConn, err := dialThroughSOCKS5(ctx, target, targetAddr, d.baseDial.Timeout+d.handshakeTimeout, d.baseDial.DialContext)
	if err != nil {
		return nil, clashpool.DialTarget{}, err
	}
	if !useTLS {
		return rawConn, target, nil
	}

	host, _, splitErr := net.SplitHostPort(targetAddr)
	if splitErr != nil {
		host = targetAddr
	}
	cache, roots := d.accountTLSContext(accountID)
	uconn, err := BuildUConn(rawConn, host, profile, cache, roots, allowH2)
	if err != nil {
		_ = rawConn.Close()
		return nil, clashpool.DialTarget{}, err
	}

	hctx, cancel := context.WithTimeout(ctx, d.handshakeTimeout)
	defer cancel()
	if err := uconn.HandshakeContext(hctx); err != nil {
		_ = uconn.Close()
		return nil, clashpool.DialTarget{}, fmt.Errorf("stealth: uTLS handshake via %s (%s): %w", target.SOCKSAddr, profile.ID, err)
	}

	state := uconn.ConnectionState()
	if proto := state.NegotiatedProtocol; proto != "" && proto != "http/1.1" && (!allowH2 || proto != "h2") {
		_ = uconn.Close()
		return nil, clashpool.DialTarget{}, fmt.Errorf("stealth: unexpected negotiated ALPN %q (allowH2=%v)", proto, allowH2)
	}
	return uconn, target, nil
}

// DoAccountRequest executes an HTTP/HTTPS request strictly through the account's Clash exit with uTLS impersonation.
// HTTP/2 is attempted when the chosen profile declares h2 ALPN, falling back safely through the same proxy to HTTP/1.1.
func (d *AccountDialer) DoAccountRequest(ctx context.Context, accountID, utlsProfileID string, req *http.Request) (*OutboundResult, error) {
	if req == nil || req.URL == nil {
		return nil, errors.New("stealth: request and target URL are required")
	}
	target, profile, err := d.resolveAccountAndProfile(accountID, utlsProfileID)
	if err != nil {
		return nil, err
	}

	clone := req.Clone(ctx)
	if clone.Header.Get("User-Agent") == "" && profile.UserAgentTemplate != "" {
		clone.Header.Set("User-Agent", profile.UserAgentTemplate)
	}

	start := time.Now()
	var (
		tlsVersion     = "plain"
		negotiatedALPN = ""
	)

	h1Transport := &http.Transport{
		DialContext: func(dialCtx context.Context, _ string, addr string) (net.Conn, error) {
			c, _, dialErr := d.DialAccountTarget(dialCtx, accountID, profile.ID, addr, false, false)
			return c, dialErr
		},
		DialTLSContext: func(dialCtx context.Context, _ string, addr string) (net.Conn, error) {
			c, _, dialErr := d.DialAccountTarget(dialCtx, accountID, profile.ID, addr, true, false)
			if dialErr != nil {
				return nil, dialErr
			}
			if uc, ok := c.(*utls.UConn); ok {
				st := uc.ConnectionState()
				tlsVersion = formatTLSVersion(st.Version)
				negotiatedALPN = st.NegotiatedProtocol
			}
			return c, nil
		},
		ForceAttemptHTTP2:     false,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	defer h1Transport.CloseIdleConnections()

	isHTTPS := strings.EqualFold(clone.URL.Scheme, "https")
	var resp *http.Response

	if isHTTPS && profile.SupportsHTTP2() {
		h2Transport := &http2.Transport{
			DialTLSContext: func(dialCtx context.Context, _ string, addr string, _ *tls.Config) (net.Conn, error) {
				c, _, dialErr := d.DialAccountTarget(dialCtx, accountID, profile.ID, addr, true, true)
				if dialErr != nil {
					return nil, dialErr
				}
				if uc, ok := c.(*utls.UConn); ok {
					st := uc.ConnectionState()
					tlsVersion = formatTLSVersion(st.Version)
					negotiatedALPN = st.NegotiatedProtocol
					if st.NegotiatedProtocol != "h2" {
						_ = c.Close()
						return nil, errNeedHTTP1Fallback
					}
				}
				return c, nil
			},
		}
		defer h2Transport.CloseIdleConnections()

		resp, err = h2Transport.RoundTrip(clone)
		if errors.Is(err, errNeedHTTP1Fallback) {
			retryReq, rErr := resetRequestForRetry(req.WithContext(ctx), clone.Header.Get("User-Agent"))
			if rErr != nil {
				return nil, rErr
			}
			resp, err = h1Transport.RoundTrip(retryReq)
		}
	} else {
		resp, err = h1Transport.RoundTrip(clone)
	}

	if err != nil {
		return nil, err
	}

	return &OutboundResult{
		Response:       resp,
		DialTarget:     target,
		TLSVersion:     tlsVersion,
		NegotiatedALPN: negotiatedALPN,
		LatencyMS:      uint32(time.Since(start).Milliseconds()),
	}, nil
}

// ProbeExitIP queries ipEchoURL directly through a Clash node's SOCKS5h listener (without binding an account)
// so background probes can detect unexpected residential/ISP exit IP drift.
func ProbeExitIP(ctx context.Context, socksAddr, username, password, ipEchoURL string, timeout time.Duration) (string, uint32, error) {
	if _, err := url.Parse(ipEchoURL); err != nil {
		return "", 0, fmt.Errorf("invalid IP echo URL: %w", err)
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	target := clashpool.DialTarget{
		SOCKSAddr:     socksAddr,
		SocksUsername: username,
		SocksPassword: password,
	}
	baseDial := (&net.Dialer{Timeout: timeout}).DialContext
	tr := &http.Transport{
		DialContext: func(dctx context.Context, _ string, addr string) (net.Conn, error) {
			return dialThroughSOCKS5(dctx, target, addr, timeout, baseDial)
		},
		ResponseHeaderTimeout: timeout,
	}
	defer tr.CloseIdleConnections()

	client := &http.Client{Transport: tr, Timeout: timeout}
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, ipEchoURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Accept", "application/json, text/plain")
	req.Header.Set("User-Agent", "slipgate-probe/1.0")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", 0, fmt.Errorf("IP echo probe returned HTTP %d", resp.StatusCode)
	}
	var buf [4096]byte
	n, _ := resp.Body.Read(buf[:])
	ipStr := extractIPFromPayload(buf[:n])
	if ipStr == "" {
		return "", 0, errors.New("IP echo probe returned unparseable IP response")
	}
	return ipStr, uint32(time.Since(start).Milliseconds()), nil
}

func extractIPFromPayload(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "{") {
		idx := strings.Index(trimmed, `"ip"`)
		if idx >= 0 {
			rest := trimmed[idx+4:]
			if q1 := strings.IndexByte(rest, '"'); q1 >= 0 {
				rest = rest[q1+1:]
				if q2 := strings.IndexByte(rest, '"'); q2 >= 0 {
					cand := strings.TrimSpace(rest[:q2])
					if net.ParseIP(cand) != nil {
						return cand
					}
				}
			}
		}
	}
	line := strings.Fields(trimmed)[0]
	if net.ParseIP(line) != nil {
		return line
	}
	return ""
}

func (d *AccountDialer) resolveAccountAndProfile(accountID, utlsProfileID string) (clashpool.DialTarget, ProfileSpec, error) {
	target, err := d.pool.ResolveDialTarget(accountID)
	if err != nil {
		return clashpool.DialTarget{}, ProfileSpec{}, err
	}
	profileID := strings.TrimSpace(utlsProfileID)
	if profileID == "" {
		profileID = DefaultProfileID
	}
	d.mu.RLock()
	profile, ok := d.profiles[profileID]
	d.mu.RUnlock()
	if !ok {
		return clashpool.DialTarget{}, ProfileSpec{}, fmt.Errorf("%w %q", ErrUnknownProfile, utlsProfileID)
	}
	return target, profile, nil
}

func (d *AccountDialer) accountTLSContext(accountID string) (utls.ClientSessionCache, *x509.CertPool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cache, ok := d.sessionCaches[accountID]
	if !ok {
		cache = utls.NewLRUClientSessionCache(defaultSessionCacheSize)
		d.sessionCaches[accountID] = cache
	}
	return cache, d.rootCAs
}

func dialThroughSOCKS5(
	ctx context.Context,
	target clashpool.DialTarget,
	addr string,
	timeout time.Duration,
	baseDial func(context.Context, string, string) (net.Conn, error),
) (net.Conn, error) {
	var auth *proxy.Auth
	if target.SocksUsername != "" || target.SocksPassword != "" {
		auth = &proxy.Auth{
			User:     target.SocksUsername,
			Password: target.SocksPassword,
		}
	}
	socksDialer, err := proxy.SOCKS5("tcp", target.SOCKSAddr, auth, contextForwardDialer(baseDial))
	if err != nil {
		return nil, fmt.Errorf("stealth: create SOCKS5 dialer: %w", err)
	}
	ctxDialer, ok := socksDialer.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("stealth: SOCKS5 dialer missing ContextDialer")
	}
	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := ctxDialer.DialContext(dctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("stealth: SOCKS5 tunnel via %s to %s failed: %w", target.SOCKSAddr, addr, err)
	}
	return conn, nil
}

type contextForwardDialer func(ctx context.Context, network, addr string) (net.Conn, error)

func (f contextForwardDialer) Dial(network, addr string) (net.Conn, error) {
	return f(context.Background(), network, addr)
}

func (f contextForwardDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return f(ctx, network, addr)
}

func resetRequestForRetry(req *http.Request, ua string) (*http.Request, error) {
	cloned := req.Clone(req.Context())
	if ua != "" && cloned.Header.Get("User-Agent") == "" {
		cloned.Header.Set("User-Agent", ua)
	}
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return nil, errNeedHTTP1Fallback
		}
		fresh, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		cloned.Body = fresh
	}
	return cloned, nil
}

func formatTLSVersion(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "TLS 1.3"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS10:
		return "TLS 1.0"
	default:
		return fmt.Sprintf("0x%04x", v)
	}
}
