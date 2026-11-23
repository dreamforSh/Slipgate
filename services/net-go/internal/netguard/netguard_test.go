package netguard

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTrustedProxiesClientIPAndAntiSpoofing(t *testing.T) {
	t.Parallel()

	tp := ParseTrustedProxies("")

	// 1. External untrusted peer trying to spoof X-Forwarded-For and X-Real-IP -> must use RemoteAddr.
	reqExternal := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	reqExternal.RemoteAddr = "198.51.100.42:54321"
	reqExternal.Header.Set("X-Forwarded-For", "10.0.0.1, 127.0.0.1")
	reqExternal.Header.Set("X-Real-IP", "10.0.0.1")
	if got := tp.ClientIP(reqExternal); got != "198.51.100.42" {
		t.Fatalf("expected untrusted peer IP 198.51.100.42, got %q", got)
	}

	// 2. Docker bridge peer (172.17.0.2) when SLIPGATE_TRUSTED_PROXIES is unset -> NOT trusted by default!
	reqBridge := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	reqBridge.RemoteAddr = "172.17.0.2:41111"
	reqBridge.Header.Set("X-Forwarded-For", "10.0.0.9")
	if got := tp.ClientIP(reqBridge); got != "172.17.0.2" {
		t.Fatalf("expected untrusted docker bridge IP 172.17.0.2, got %q", got)
	}

	// 3. Configured reverse proxy CIDR walks right-to-left and ignores spoofed left-side entries.
	tpIngress := ParseTrustedProxies("127.0.0.0/8, 172.18.0.10")
	reqProxied := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	reqProxied.RemoteAddr = "172.18.0.10:33221"
	reqProxied.Header.Set("X-Forwarded-For", "10.9.9.9, 203.0.113.77, 127.0.0.1")
	if got := tpIngress.ClientIP(reqProxied); got != "203.0.113.77" {
		t.Fatalf("expected right-most non-trusted IP 203.0.113.77, got %q", got)
	}
}

func TestSanitizeForwardedHeadersStripsUntrustedHostInjection(t *testing.T) {
	t.Parallel()

	tp := ParseTrustedProxies("127.0.0.1")

	in := httptest.NewRequest(http.MethodGet, "http://console.example.com/api/v1/auth/oauth/github/start", nil)
	in.Host = "console.example.com"
	in.RemoteAddr = "198.51.100.99:40000"
	in.Header.Set("X-Forwarded-Host", "evil.attacker.example")
	in.Header.Set("X-Forwarded-Proto", "https")
	in.Header.Set("X-Forwarded-For", "127.0.0.1")

	out := in.Clone(in.Context())
	tp.SanitizeForwardedHeaders(in, out)

	if got := out.Header.Get("X-Forwarded-Host"); got != "console.example.com" {
		t.Fatalf("expected sanitized X-Forwarded-Host console.example.com, got %q", got)
	}
	if got := out.Header.Get("X-Forwarded-Proto"); got != "http" {
		t.Fatalf("expected X-Forwarded-Proto http, got %q", got)
	}
	if got := out.Header.Get("X-Forwarded-For"); got != "198.51.100.99" {
		t.Fatalf("expected X-Forwarded-For 198.51.100.99, got %q", got)
	}

	if safe := SanitizeHostHeader("evil.com/path#frag"); safe != "" {
		t.Fatalf("expected path-injected host to be rejected, got %q", safe)
	}
}

func TestSSRFOutboundGuardBlocksInternalAndRedirectTargets(t *testing.T) {
	t.Parallel()

	blockedURLs := []string{
		"http://127.0.0.1:8080/internal",
		"http://[::1]:19081/",
		"http://0.0.0.0:80/",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.100.100.200/latest/meta-data/",
		"http://10.0.0.5:6379/",
		"http://172.16.0.10:5432/",
		"http://192.168.1.1/admin",
		"http://[fc00::1]:8080/",
		"http://[fe80::1]:80/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://postgres.internal:5432/",
		"http://localhost:19082/api/v1/health",
		"file:///etc/passwd",
	}
	for _, raw := range blockedURLs {
		if err := ValidateOutboundURL(raw, false); err == nil {
			t.Errorf("expected ValidateOutboundURL(%q, false) to block, got nil", raw)
		}
	}

	// IMDS (169.254.169.254) and metadata.google.internal stay blocked even when allowPrivate=true.
	if err := ValidateOutboundURL("http://169.254.169.254/latest/meta-data/", true); err == nil {
		t.Fatalf("expected cloud IMDS to remain blocked even when allowPrivate=true")
	}
	if err := ValidateOutboundURL("http://metadata.google.internal/computeMetadata/v1/", true); err == nil {
		t.Fatalf("expected metadata.google.internal to remain blocked even when allowPrivate=true")
	}

	// Safe HTTP client must also block dial-time connections to loopback.
	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer localSrv.Close()

	client := NewSafeHTTPClient(2*time.Second, false)
	if _, err := client.Get(localSrv.URL); !errors.Is(err, ErrSSRFBlocked) {
		t.Fatalf("expected NewSafeHTTPClient to block loopback server with ErrSSRFBlocked, got %v", err)
	}
}
