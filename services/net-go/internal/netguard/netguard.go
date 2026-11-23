package netguard

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"
)

var (
	// ErrSSRFBlocked is returned when an outbound connection resolves to a loopback, private, link-local, or metadata IP.
	ErrSSRFBlocked = errors.New("netguard: outbound target address is restricted")

	cgnatPrefix = netip.MustParsePrefix("100.64.0.0/10")
	benchmarkV4 = netip.MustParsePrefix("198.18.0.0/15")
	docNet1     = netip.MustParsePrefix("192.0.2.0/24")
	docNet2     = netip.MustParsePrefix("198.51.100.0/24")
	docNet3     = netip.MustParsePrefix("203.0.113.0/24")
	docNetV6    = netip.MustParsePrefix("2001:db8::/32")
)

// AllowPrivateUpstreamsFromEnv reports whether SLIPGATE_ALLOW_PRIVATE_UPSTREAMS explicitly permits loopback/RFC1918 upstreams.
func AllowPrivateUpstreamsFromEnv() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("SLIPGATE_ALLOW_PRIVATE_UPSTREAMS")))
	return v == "true" || v == "1" || v == "yes"
}

// TrustedProxies evaluates SLIPGATE_TRUSTED_PROXIES CIDRs/IPs (defaults to loopback 127.0.0.0/8, ::1/128).
type TrustedProxies struct {
	prefixes []netip.Prefix
}

// ParseTrustedProxiesFromEnv loads SLIPGATE_TRUSTED_PROXIES (comma-separated IPs or CIDRs; "none"/"off" trusts nothing).
func ParseTrustedProxiesFromEnv() *TrustedProxies {
	return ParseTrustedProxies(os.Getenv("SLIPGATE_TRUSTED_PROXIES"))
}

// ParseTrustedProxies parses a comma-separated list of IPs/CIDRs. Empty defaults to loopback only.
func ParseTrustedProxies(raw string) *TrustedProxies {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return &TrustedProxies{
			prefixes: []netip.Prefix{
				netip.MustParsePrefix("127.0.0.0/8"),
				netip.MustParsePrefix("::1/128"),
			},
		}
	}
	lower := strings.ToLower(trimmed)
	if lower == "none" || lower == "off" || lower == "false" {
		return &TrustedProxies{}
	}
	var prefixes []netip.Prefix
	for _, token := range strings.Split(trimmed, ",") {
		entry := strings.TrimSpace(token)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			if p, err := netip.ParsePrefix(entry); err == nil {
				prefixes = append(prefixes, p.Masked())
			}
			continue
		}
		if addr, err := netip.ParseAddr(strings.Trim(entry, "[]")); err == nil {
			addr = addr.Unmap()
			prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
		}
	}
	return &TrustedProxies{prefixes: prefixes}
}

// IsTrustedAddr reports whether addr belongs to a configured trusted reverse proxy.
func (tp *TrustedProxies) IsTrustedAddr(addr netip.Addr) bool {
	if tp == nil || !addr.IsValid() {
		return false
	}
	unmapped := addr.Unmap()
	for _, p := range tp.prefixes {
		if p.Contains(unmapped) {
			return true
		}
	}
	return false
}

// RemoteAddrIP extracts the peer IP from http.Request.RemoteAddr.
func RemoteAddrIP(remoteAddr string) (netip.Addr, bool) {
	trimmed := strings.TrimSpace(remoteAddr)
	if trimmed == "" {
		return netip.Addr{}, false
	}
	host := trimmed
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if idx := strings.IndexByte(host, '%'); idx >= 0 {
		host = host[:idx]
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

// ClientIP resolves the real client IP using right-to-left trusted-hop walking across X-Forwarded-For.
// Untrusted direct peers cannot spoof X-Forwarded-For or X-Real-IP.
func (tp *TrustedProxies) ClientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	peerAddr, ok := RemoteAddrIP(r.RemoteAddr)
	if !ok {
		return strings.TrimSpace(r.RemoteAddr)
	}
	if tp == nil || !tp.IsTrustedAddr(peerAddr) {
		return peerAddr.String()
	}

	if xff := strings.Join(r.Header.Values("X-Forwarded-For"), ","); strings.TrimSpace(xff) != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidateStr := strings.Trim(strings.TrimSpace(parts[i]), "[]")
			if candidateStr == "" {
				continue
			}
			candAddr, err := netip.ParseAddr(candidateStr)
			if err != nil {
				// Stop at malformed hop rather than trusting spoofed left-side entries.
				return peerAddr.String()
			}
			candAddr = candAddr.Unmap()
			if !tp.IsTrustedAddr(candAddr) {
				return candAddr.String()
			}
		}
	}

	if xrip := strings.Trim(strings.TrimSpace(r.Header.Get("X-Real-IP")), "[]"); xrip != "" {
		if candAddr, err := netip.ParseAddr(xrip); err == nil {
			return candAddr.Unmap().String()
		}
	}
	return peerAddr.String()
}

// SanitizeForwardedHeaders strips untrusted X-Forwarded-* / X-Real-IP headers before reverse-proxying to BFF
// and sets canonical X-Forwarded-For / X-Forwarded-Host / X-Forwarded-Proto values.
func (tp *TrustedProxies) SanitizeForwardedHeaders(in, out *http.Request) {
	peerAddr, peerOK := RemoteAddrIP(in.RemoteAddr)
	trustedPeer := peerOK && tp != nil && tp.IsTrustedAddr(peerAddr)

	if !trustedPeer {
		out.Header.Del("X-Forwarded-For")
		out.Header.Del("X-Real-IP")
		out.Header.Del("X-Forwarded-Host")
		out.Header.Del("X-Forwarded-Proto")
		out.Header.Del("Forwarded")
		if peerOK {
			out.Header.Set("X-Forwarded-For", peerAddr.String())
			out.Header.Set("X-Real-IP", peerAddr.String())
		}
		if host := SanitizeHostHeader(in.Host); host != "" {
			out.Header.Set("X-Forwarded-Host", host)
		}
		proto := "http"
		if in.TLS != nil {
			proto = "https"
		}
		out.Header.Set("X-Forwarded-Proto", proto)
		return
	}

	// Trusted upstream proxy: sanitize X-Forwarded-Host/Proto and append peerAddr to X-Forwarded-For.
	if rawFH := in.Header.Get("X-Forwarded-Host"); rawFH != "" {
		first := strings.TrimSpace(strings.Split(rawFH, ",")[0])
		if safe := SanitizeHostHeader(first); safe != "" {
			out.Header.Set("X-Forwarded-Host", safe)
		} else {
			out.Header.Del("X-Forwarded-Host")
		}
	} else if host := SanitizeHostHeader(in.Host); host != "" {
		out.Header.Set("X-Forwarded-Host", host)
	}

	if rawFP := strings.ToLower(strings.TrimSpace(strings.Split(in.Header.Get("X-Forwarded-Proto"), ",")[0])); rawFP == "https" || rawFP == "http" {
		out.Header.Set("X-Forwarded-Proto", rawFP)
	} else if in.TLS != nil {
		out.Header.Set("X-Forwarded-Proto", "https")
	} else {
		out.Header.Set("X-Forwarded-Proto", "http")
	}

	if peerOK {
		prior := strings.TrimSpace(strings.Join(in.Header.Values("X-Forwarded-For"), ", "))
		if prior != "" {
			out.Header.Set("X-Forwarded-For", prior+", "+peerAddr.String())
		} else {
			out.Header.Set("X-Forwarded-For", peerAddr.String())
		}
	}
}

// SanitizeHostHeader rejects authority/path/CRLF injection characters in Host / X-Forwarded-Host.
func SanitizeHostHeader(raw string) string {
	h := strings.TrimSpace(raw)
	if h == "" || len(h) > 255 {
		return ""
	}
	if strings.ContainsAny(h, "/\\?#@ \t\r\n") {
		return ""
	}
	return h
}

// IsRestrictedOutboundAddr reports whether addr is a loopback, private, unspecified, link-local/IMDS, CGNAT, or multicast IP.
func IsRestrictedOutboundAddr(addr netip.Addr, allowPrivate bool) bool {
	if !addr.IsValid() {
		return true
	}
	u := addr.Unmap()
	// Always block unspecified (0.0.0.0 / ::), link-local / cloud IMDS (169.254.0.0/16, fe80::/10), and multicast.
	if u.IsUnspecified() || u.IsLinkLocalUnicast() || u.IsLinkLocalMulticast() || u.IsMulticast() {
		return true
	}
	if allowPrivate {
		return false
	}
	if u.IsLoopback() || u.IsPrivate() {
		return true
	}
	if u.Is4() {
		if cgnatPrefix.Contains(u) || benchmarkV4.Contains(u) || docNet1.Contains(u) || docNet2.Contains(u) || docNet3.Contains(u) {
			return true
		}
	} else if docNetV6.Contains(u) {
		return true
	}
	return false
}

// IsRestrictedHostname blocks metadata and internal hostnames before DNS resolution.
func IsRestrictedHostname(host string, allowPrivate bool) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.Trim(strings.TrimSpace(host), "[]"), "."))
	if h == "" {
		return true
	}
	if h == "metadata.google.internal" || strings.HasSuffix(h, ".metadata.google.internal") || h == "metadata" || h == "instance-data" {
		return true
	}
	if !allowPrivate {
		if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".internal") || strings.HasSuffix(h, ".local") || h == "host.docker.internal" {
			return true
		}
	}
	if addr, err := netip.ParseAddr(h); err == nil {
		return IsRestrictedOutboundAddr(addr, allowPrivate)
	}
	return false
}

// ValidateOutboundURL checks scheme and hostname restrictions before dispatching an outbound HTTP request.
func ValidateOutboundURL(rawURL string, allowPrivate bool) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("%w: malformed URL", ErrSSRFBlocked)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("%w: unsupported scheme %q", ErrSSRFBlocked, u.Scheme)
	}
	host := u.Hostname()
	if IsRestrictedHostname(host, allowPrivate) {
		return fmt.Errorf("%w: host %q is disallowed", ErrSSRFBlocked, host)
	}
	return nil
}

// NewSafeDialContext builds a DialContext that resolves DNS once and verifies every candidate IP before connecting
// (eliminating DNS rebinding against 127.0.0.1, RFC1918, and 169.254.169.254).
func NewSafeDialContext(timeout time.Duration, allowPrivate bool) func(ctx context.Context, network, address string) (net.Conn, error) {
	baseDialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid address %q", ErrSSRFBlocked, address)
		}
		if IsRestrictedHostname(host, allowPrivate) {
			return nil, fmt.Errorf("%w: host %q is disallowed", ErrSSRFBlocked, host)
		}
		cleanHost := strings.Trim(host, "[]")
		if literal, parseErr := netip.ParseAddr(cleanHost); parseErr == nil {
			if IsRestrictedOutboundAddr(literal, allowPrivate) {
				return nil, fmt.Errorf("%w: IP %s is disallowed", ErrSSRFBlocked, literal.String())
			}
			return baseDialer.DialContext(ctx, network, net.JoinHostPort(literal.String(), port))
		}

		addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", cleanHost)
		if err != nil {
			return nil, err
		}
		if len(addrs) == 0 {
			return nil, fmt.Errorf("%w: %q resolved to no IP addresses", ErrSSRFBlocked, cleanHost)
		}
		for _, ip := range addrs {
			if IsRestrictedOutboundAddr(ip, allowPrivate) {
				return nil, fmt.Errorf("%w: %q resolved to restricted IP %s", ErrSSRFBlocked, cleanHost, ip.String())
			}
		}

		var lastErr error
		for _, ip := range addrs {
			conn, dialErr := baseDialer.DialContext(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
}

// NewSafeHTTPClient returns an *http.Client guarded against SSRF both on initial connect and across HTTP redirects.
func NewSafeHTTPClient(timeout time.Duration, allowPrivate bool) *http.Client {
	dialTimeout := min(timeout, 15*time.Second)
	if dialTimeout <= 0 {
		dialTimeout = 10 * time.Second
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         NewSafeDialContext(dialTimeout, allowPrivate),
			MaxIdleConns:        64,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     90 * time.Second,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("netguard: stopped after 5 redirects")
			}
			return ValidateOutboundURL(req.URL.String(), allowPrivate)
		},
	}
}
