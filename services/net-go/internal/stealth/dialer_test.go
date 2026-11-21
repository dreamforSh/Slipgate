package stealth

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

func startTestSocks5Server(t *testing.T, wantUser, wantPass string, hitCount *atomic.Int32) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen test socks5: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serveSocks5(c, wantUser, wantPass, hitCount)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func serveSocks5(c net.Conn, wantUser, wantPass string, hitCount *atomic.Int32) {
	defer c.Close()
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil || hdr[0] != 0x05 {
		return
	}
	methods := make([]byte, int(hdr[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	if _, err := c.Write([]byte{0x05, 0x02}); err != nil {
		return
	}

	var authHdr [2]byte
	if _, err := io.ReadFull(c, authHdr[:]); err != nil {
		return
	}
	u := make([]byte, int(authHdr[1]))
	if _, err := io.ReadFull(c, u); err != nil {
		return
	}
	var pLen [1]byte
	if _, err := io.ReadFull(c, pLen[:]); err != nil {
		return
	}
	p := make([]byte, int(pLen[0]))
	if _, err := io.ReadFull(c, p); err != nil {
		return
	}
	if string(u) != wantUser || string(p) != wantPass {
		_, _ = c.Write([]byte{0x01, 0x01})
		return
	}
	_, _ = c.Write([]byte{0x01, 0x00})

	var req [4]byte
	if _, err := io.ReadFull(c, req[:]); err != nil || req[0] != 0x05 || req[1] != 0x01 {
		return
	}
	var host string
	switch req[3] {
	case 0x01:
		var ip [4]byte
		if _, err := io.ReadFull(c, ip[:]); err != nil {
			return
		}
		host = net.IP(ip[:]).String()
	case 0x03:
		var l [1]byte
		if _, err := io.ReadFull(c, l[:]); err != nil {
			return
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = string(b)
	default:
		return
	}
	var portBuf [2]byte
	if _, err := io.ReadFull(c, portBuf[:]); err != nil {
		return
	}
	port := int(portBuf[0])<<8 | int(portBuf[1])

	remote, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)), 3*time.Second)
	if err != nil {
		_, _ = c.Write([]byte{0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer remote.Close()
	hitCount.Add(1)
	_, _ = c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, c); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, remote); done <- struct{}{} }()
	<-done
}

func TestDoAccountRequestFailClosedAndUTLSHandshake(t *testing.T) {
	t.Parallel()

	var socksHits atomic.Int32
	socksPort := startTestSocks5Server(t, "sg-u", "sg-p", &socksHits)

	var seenUA string
	tlsSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUA = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello-utls-clash"))
	}))
	tlsSrv.EnableHTTP2 = true
	tlsSrv.StartTLS()
	defer tlsSrv.Close()

	pool := clashpool.NewManager(1, 65535, 1)
	dialer := NewAccountDialer(pool)

	roots := x509.NewCertPool()
	roots.AddCert(tlsSrv.Certificate())
	dialer.SetRootCAs(roots)

	// 1. Unbound account must fail closed (never leak host IP)
	reqFail, _ := http.NewRequest(http.MethodGet, tlsSrv.URL, nil)
	if _, err := dialer.DoAccountRequest(context.Background(), "acc-unbound", "chrome-131", reqFail); !errors.Is(err, clashpool.ErrExitCircuitOpen) {
		t.Fatalf("expected ErrExitCircuitOpen for unbound account, got %v", err)
	}

	// 2. Register healthy Clash node and bind account
	_, err := pool.SyncNodes("sub-1", []clashpool.Node{
		{
			ID:            "node-1",
			Name:          "Tokyo-1",
			ProxySlotID:   "slot-1",
			ListenerPort:  socksPort,
			SocksUsername: "sg-u",
			SocksPassword: "sg-p",
			ExitIP:        "203.0.113.50",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
	}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	if err := pool.BindAccount("acc-1", "node-1", false); err != nil {
		t.Fatalf("BindAccount failed: %v", err)
	}

	// 3. Unknown profile rejected
	if _, err := dialer.DoAccountRequest(context.Background(), "acc-1", "no-such-profile", reqFail); !errors.Is(err, ErrUnknownProfile) {
		t.Fatalf("expected ErrUnknownProfile, got %v", err)
	}

	// 4. Built-in chrome-131, codex-rustls-01, and antigravity-electron-15 negotiate HTTP/2 over authenticated Clash SOCKS5 tunnel
	for _, profID := range []string{"chrome-131", CodexRustlsProfileID, AntigravityElectronProfileID} {
		reqH2, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/test-"+profID, nil)
		resH2, reqErr := dialer.DoAccountRequest(context.Background(), "acc-1", profID, reqH2)
		if reqErr != nil {
			t.Fatalf("DoAccountRequest (%s) failed: %v", profID, reqErr)
		}
		bodyH2, _ := io.ReadAll(resH2.Response.Body)
		_ = resH2.Response.Body.Close()
		if string(bodyH2) != "hello-utls-clash" || resH2.NegotiatedALPN != "h2" {
			t.Fatalf("unexpected H2 uTLS result for %s: body=%q alpn=%q tls=%q", profID, string(bodyH2), resH2.NegotiatedALPN, resH2.TLSVersion)
		}
	}
	if socksHits.Load() < 1 || seenUA == "" {
		t.Fatalf("expected request to traverse SOCKS5 with template UA, hits=%d ua=%q", socksHits.Load(), seenUA)
	}
	if DefaultProfileForProvider("codex", "oauth") != CodexRustlsProfileID ||
		DefaultProfileForProvider("antigravity", "vm_cli_seed") != AntigravityElectronProfileID ||
		DefaultProfileForProvider("anthropic", "oauth") != ClaudeBunProfileID {
		t.Fatalf("unexpected DefaultProfileForProvider mapping")
	}

	// 5. Built-in claude-cli-mac profile forces http/1.1 without h2 (check http/1.1 or empty ALPN on HTTP/1.1-selected TLS)
	reqCli, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/cli", nil)
	resCli, err := dialer.DoAccountRequest(context.Background(), "acc-1", "claude-cli-mac", reqCli)
	if err != nil {
		t.Fatalf("DoAccountRequest (claude-cli-mac) failed: %v", err)
	}
	_ = resCli.Response.Body.Close()
	if resCli.NegotiatedALPN == "h2" {
		t.Fatalf("expected non-h2 ALPN for claude-cli-mac, got %q", resCli.NegotiatedALPN)
	}
	if err := dialer.DeleteProfile("chrome-131"); !errors.Is(err, ErrBuiltInProfileLock) {
		t.Fatalf("expected built-in profile delete lock, got %v", err)
	}
}

func TestValidateProfileAndWireClientHelloParity(t *testing.T) {
	t.Parallel()

	// 1. key_share without supported_groups extension 10 fails closed.
	invalidMissingExt10 := ProfileSpec{
		ID:             "bad-ext10",
		Name:           "Bad Missing Ext10",
		KeyShareGroups: []uint16{29},
		Extensions:     []uint16{0, 16, 43, 51},
	}
	if err := ValidateProfile(invalidMissingExt10); !errors.Is(err, ErrKeyShareWithoutSupportedGroups) {
		t.Fatalf("expected ErrKeyShareWithoutSupportedGroups, got %v", err)
	}

	// 2. key_share group absent from curves fails closed with KeyShareNotInSupportedGroupsError.
	invalidGroup := ProfileSpec{
		ID:             "bad-group",
		Name:           "Bad Curve Subset",
		Curves:         []uint16{23}, // P256 only
		KeyShareGroups: []uint16{29}, // X25519 not in curves
		Extensions:     []uint16{0, 10, 16, 43, 51},
	}
	err := ValidateProfile(invalidGroup)
	var groupErr *KeyShareNotInSupportedGroupsError
	if !errors.As(err, &groupErr) || groupErr.Group != 29 {
		t.Fatalf("expected KeyShareNotInSupportedGroupsError{29}, got %v", err)
	}

	// 3. Claude Code 2.1.280 Bun wire profile builds valid ClientHelloSpec with PQ X25519MLKEM768 + GREASE ECH option.
	dialer := NewAccountDialer(clashpool.NewManager(1, 65535, 1))
	bunSpec, ok := dialer.GetProfile(ClaudeBunProfileID)
	if !ok {
		t.Fatalf("expected built-in %q profile", ClaudeBunProfileID)
	}
	if err := ValidateProfile(bunSpec); err != nil {
		t.Fatalf("expected valid claude-bun-21 profile, got %v", err)
	}
	helloSpec, err := BuildClientHelloSpec(bunSpec)
	if err != nil || helloSpec == nil {
		t.Fatalf("expected non-nil custom ClientHelloSpec, err=%v", err)
	}

	customECH := bunSpec.Clone()
	customECH.ID = "custom-grease-ech"
	customECH.BuiltIn = false
	customECH.EnableGREASE = true
	customECH.Extensions = append(append([]uint16(nil), customECH.Extensions...), 0xfe0d)
	if _, err := BuildClientHelloSpec(customECH); err != nil {
		t.Fatalf("BuildClientHelloSpec with EnableGREASE+0xfe0d failed: %v", err)
	}

	// 4. ProfileCacheKey sensitive to curve & GREASE mutations.
	h1 := ProfileCacheKey(bunSpec)
	h2 := ProfileCacheKey(customECH)
	if h1 == h2 || h1 == 0 {
		t.Fatalf("expected distinct non-zero cache keys, got %x vs %x", h1, h2)
	}

	// 5. Sticky Rendezvous selection deterministically picks concrete profile with OS hint & excludes "auto".
	chosenA, okA := StickyProfileForAccount("acct-sticky-42", dialer.ListProfiles(), "darwin")
	chosenB, okB := StickyProfileForAccount("acct-sticky-42", dialer.ListProfiles(), "macos")
	if !okA || !okB || chosenA.ID != chosenB.ID || chosenA.ID == AutoProfileID {
		t.Fatalf("expected deterministic OS-hinted sticky profile, got A=%v B=%v", chosenA.ID, chosenB.ID)
	}
}

func TestAutoStickyProfileEndToEndAndUpdateInvalidation(t *testing.T) {
	t.Parallel()

	var socksHits atomic.Int32
	socksPort := startTestSocks5Server(t, "sg-u", "sg-p", &socksHits)

	tlsSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok-" + r.Proto))
	}))
	tlsSrv.EnableHTTP2 = true
	tlsSrv.StartTLS()
	defer tlsSrv.Close()

	pool := clashpool.NewManager(1, 65535, 1)
	dialer := NewAccountDialer(pool)
	roots := x509.NewCertPool()
	roots.AddCert(tlsSrv.Certificate())
	dialer.SetRootCAs(roots)

	_, err := pool.SyncNodes("sub-1", []clashpool.Node{{
		ID:            "node-1",
		Name:          "Osaka-1",
		ProxySlotID:   "slot-1",
		ListenerPort:  socksPort,
		SocksUsername: "sg-u",
		SocksPassword: "sg-p",
		ExitIP:        "203.0.113.88",
		Health:        clashpool.HealthHealthy,
		Enabled:       true,
	}}, true)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}
	if err := pool.BindAccountWithProfile("acc-auto", "node-1", false, AutoProfileID); err != nil {
		t.Fatalf("BindAccountWithProfile failed: %v", err)
	}

	req1, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/messages", nil)
	res1, err := dialer.DoAccountRequest(context.Background(), "acc-auto", "", req1)
	if err != nil {
		t.Fatalf("DoAccountRequest auto failed: %v", err)
	}
	_ = res1.Response.Body.Close()
	if res1.ProfileIDUsed == "" || res1.ProfileIDUsed == AutoProfileID {
		t.Fatalf("expected concrete resolved profile for auto binding, got %q", res1.ProfileIDUsed)
	}

	// Custom wire profile registration + UpdateProfile invalidates cached transport cleanly.
	custom := ProfileSpec{
		ID:                "custom-pq-1",
		Name:              "Custom PQ",
		ClientHelloPreset: "custom_wire",
		ALPNProtocols:     []string{"h2", "http/1.1"},
		Curves:            []uint16{uint16(utls.X25519MLKEM768), uint16(utls.X25519)},
		KeyShareGroups:    []uint16{uint16(utls.X25519MLKEM768), uint16(utls.X25519)},
		UserAgentTemplate: "custom-bun/1.0",
	}
	dialer.RegisterProfile(custom)
	req2, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/messages", nil)
	res2, err := dialer.DoAccountRequest(context.Background(), "acc-auto", custom.ID, req2)
	if err != nil {
		t.Fatalf("DoAccountRequest custom failed: %v", err)
	}
	_ = res2.Response.Body.Close()

	custom.UserAgentTemplate = "custom-bun/2.0"
	custom.EnableGREASE = true
	if err := dialer.UpdateProfile(custom); err != nil {
		t.Fatalf("UpdateProfile failed: %v", err)
	}
	req3, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/messages", nil)
	res3, err := dialer.DoAccountRequest(context.Background(), "acc-auto", custom.ID, req3)
	if err != nil {
		t.Fatalf("DoAccountRequest after UpdateProfile failed: %v", err)
	}
	_ = res3.Response.Body.Close()
	if socksHits.Load() < 2 {
		t.Fatalf("expected SOCKS5 tunnel usage across custom profile update, hits=%d", socksHits.Load())
	}
}
