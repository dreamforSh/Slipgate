package stealth

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
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
	for _, tc := range []struct {
		provider, authKind, want string
	}{
		{"codex", "oauth", CodexRustlsProfileID},
		{"antigravity", "vm_cli_seed", AntigravityElectronProfileID},
		{"anthropic", "oauth", ClaudeNodeProfileID},
		{"anthropic", "api_key", NodeSDKProfileID},
		{"gemini", "oauth", GeminiCLINodeProfileID},
		{"qwen", "oauth", QwenCLINodeProfileID},
		{"grok", "api_key", GrokRustlsProfileID},
		{"opencode_go", "api_key", OpenCodeBunProfileID},
		{"opencode", "api_key", OpenCodeBunProfileID},
		{"cline", "api_key", ClineNodeProfileID},
	} {
		if got := DefaultProfileForProvider(tc.provider, tc.authKind); got != tc.want {
			t.Fatalf("DefaultProfileForProvider(%q, %q) = %q, want %q", tc.provider, tc.authKind, got, tc.want)
		}
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

	// 3. Claude Code 2.1.321 Bun wire profile builds valid ClientHelloSpec with PQ X25519MLKEM768 + GREASE ECH option.
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

type parsedWireClientHello struct {
	extIDs         map[uint16]bool
	alpn           []string
	keyShareGroups []uint16
}

func readAndParseWireClientHello(t *testing.T, conn net.Conn) parsedWireClientHello {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var hdr [5]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		t.Fatalf("read TLS record header: %v", err)
	}
	if hdr[0] != 0x16 {
		t.Fatalf("expected TLS handshake record (0x16), got 0x%02x", hdr[0])
	}
	recLen := int(binary.BigEndian.Uint16(hdr[3:5]))
	rec := make([]byte, recLen)
	if _, err := io.ReadFull(conn, rec); err != nil {
		t.Fatalf("read TLS ClientHello record: %v", err)
	}
	if len(rec) < 42 || rec[0] != 0x01 {
		t.Fatalf("expected TLS ClientHello (0x01), len=%d type=0x%02x", len(rec), rec[0])
	}

	pos := 4 + 2 + 32 // handshake hdr (4) + legacy_version (2) + random (32)
	sidLen := int(rec[pos])
	pos += 1 + sidLen
	csLen := int(binary.BigEndian.Uint16(rec[pos : pos+2]))
	pos += 2 + csLen
	compLen := int(rec[pos])
	pos += 1 + compLen
	if pos+2 > len(rec) {
		t.Fatalf("ClientHello truncated before extensions")
	}
	extTotal := int(binary.BigEndian.Uint16(rec[pos : pos+2]))
	pos += 2
	end := pos + extTotal
	if end > len(rec) {
		t.Fatalf("ClientHello extensions exceed record: %d > %d", end, len(rec))
	}

	out := parsedWireClientHello{extIDs: make(map[uint16]bool)}
	for pos+4 <= end {
		extType := binary.BigEndian.Uint16(rec[pos : pos+2])
		extLen := int(binary.BigEndian.Uint16(rec[pos+2 : pos+4]))
		if pos+4+extLen > end {
			t.Fatalf("extension 0x%04x truncated", extType)
		}
		extData := rec[pos+4 : pos+4+extLen]
		pos += 4 + extLen
		out.extIDs[extType] = true

		switch extType {
		case 0x0010: // ALPN
			if len(extData) >= 2 {
				listLen := int(binary.BigEndian.Uint16(extData[0:2]))
				p := 2
				for p < 2+listLen && p < len(extData) {
					n := int(extData[p])
					p++
					if p+n <= len(extData) {
						out.alpn = append(out.alpn, string(extData[p:p+n]))
					}
					p += n
				}
			}
		case 0x0033: // key_share
			if len(extData) >= 2 {
				sharesLen := int(binary.BigEndian.Uint16(extData[0:2]))
				p := 2
				for p+4 <= 2+sharesLen && p+4 <= len(extData) {
					grp := binary.BigEndian.Uint16(extData[p : p+2])
					klen := int(binary.BigEndian.Uint16(extData[p+2 : p+4]))
					out.keyShareGroups = append(out.keyShareGroups, grp)
					p += 4 + klen
				}
			}
		}
	}
	return out
}

func makeSelfSignedLoopbackCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ecdsa keygen: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost", "api.anthropic.com"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create self-signed cert: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, roots
}

func TestWireClientHelloDirectAndSocksParity(t *testing.T) {
	t.Parallel()

	captureLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen raw capture: %v", err)
	}
	defer func() { _ = captureLn.Close() }()

	capturedCh := make(chan parsedWireClientHello, 4)
	go func() {
		for {
			c, err := captureLn.Accept()
			if err != nil {
				return
			}
			hello := readAndParseWireClientHello(t, c)
			_ = c.Close()
			capturedCh <- hello
		}
	}()

	var socksHits atomic.Int32
	socksPort := startTestSocks5Server(t, "u1", "p1", &socksHits)
	pool := clashpool.NewManager(1, 65535, 1)
	if _, err := pool.SyncNodes("sub-wire", []clashpool.Node{
		{
			ID:            "node-wire",
			Name:          "WireCapture",
			ProxySlotID:   "slot-wire",
			ListenerPort:  socksPort,
			SocksUsername: "u1",
			SocksPassword: "p1",
			ExitIP:        "198.51.100.10",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
	}, true); err != nil {
		t.Fatalf("SyncNodes: %v", err)
	}
	if err := pool.BindAccountWithProfile("acc-wire", "node-wire", false, ClaudeNodeProfileID); err != nil {
		t.Fatalf("BindAccountWithProfile: %v", err)
	}

	dialer := NewAccountDialer(pool)
	targetURL := "https://" + captureLn.Addr().String() + "/v1/messages"

	// 1. DoDirectRequest with allowPrivate=false must fail SSRF check before dialing TCP.
	reqSSRF, _ := http.NewRequest(http.MethodPost, targetURL, nil)
	if _, err := dialer.DoDirectRequest(context.Background(), "acc-ssrf", ClaudeNodeProfileID, reqSSRF, false); err == nil {
		t.Fatalf("expected DoDirectRequest with allowPrivate=false to reject loopback URL")
	}

	// 2. DoDirectRequest (direct_api) with claude-node-24 sends exact Node 24 ClientHello on raw TCP.
	reqDirect, _ := http.NewRequest(http.MethodPost, targetURL, nil)
	_, _ = dialer.DoDirectRequest(context.Background(), "acc-direct", ClaudeNodeProfileID, reqDirect, true)
	helloDirect := <-capturedCh

	// 3. DoAccountRequest (SOCKS5) with claude-node-24 matches Node 24 ClientHello wire bytes.
	reqSocksNode, _ := http.NewRequest(http.MethodPost, targetURL, nil)
	_, _ = dialer.DoAccountRequest(context.Background(), "acc-wire", ClaudeNodeProfileID, reqSocksNode)
	helloSocksNode := <-capturedCh

	for _, tc := range []struct {
		name  string
		hello parsedWireClientHello
	}{
		{"direct_api claude-node-24", helloDirect},
		{"socks5 claude-node-24", helloSocksNode},
	} {
		if strings.Join(tc.hello.alpn, ",") != "http/1.1" {
			t.Fatalf("%s expected ALPN=[http/1.1] without h2, got %v", tc.name, tc.hello.alpn)
		}
		if !tc.hello.extIDs[0xfe0d] {
			t.Fatalf("%s expected GREASE ECH extension 0xfe0d on wire", tc.name)
		}
		hasX25519 := false
		for _, g := range tc.hello.keyShareGroups {
			if g == uint16(utls.X25519) {
				hasX25519 = true
			}
			if g == uint16(utls.X25519MLKEM768) {
				t.Fatalf("%s must not advertise X25519MLKEM768 key share on wire: %v", tc.name, tc.hello.keyShareGroups)
			}
		}
		if !hasX25519 {
			t.Fatalf("%s expected X25519 key share on wire, got %v", tc.name, tc.hello.keyShareGroups)
		}
	}

	// 4. codex-rustls-01 over SOCKS5 offers h2+http/1.1 ALPN and no ECH 0xfe0d extension.
	reqCodex, _ := http.NewRequest(http.MethodPost, targetURL, nil)
	_, _ = dialer.DoAccountRequest(context.Background(), "acc-wire", CodexRustlsProfileID, reqCodex)
	helloCodex := <-capturedCh
	if strings.Join(helloCodex.alpn, ",") != "h2,http/1.1" {
		t.Fatalf("codex-rustls-01 expected ALPN=[h2,http/1.1], got %v", helloCodex.alpn)
	}
	if helloCodex.extIDs[0xfe0d] {
		t.Fatalf("codex-rustls-01 must not send GREASE ECH 0xfe0d")
	}
	if socksHits.Load() < 2 {
		t.Fatalf("expected SOCKS5 proxy hits >= 2, got %d", socksHits.Load())
	}
}

func TestWireHTTP11HeaderCasingDirectAndSocks(t *testing.T) {
	t.Parallel()

	cert, roots := makeSelfSignedLoopbackCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tls wire: %v", err)
	}
	defer func() { _ = ln.Close() }()

	type wireResult struct {
		alpn    string
		rawWire string
	}
	resCh := make(chan wireResult, 4)
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h2", "http/1.1"},
	}

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(rawConn net.Conn) {
				defer func() { _ = rawConn.Close() }()
				tlsConn := tls.Server(rawConn, tlsCfg)
				_ = tlsConn.SetDeadline(time.Now().Add(3 * time.Second))
				if err := tlsConn.Handshake(); err != nil {
					return
				}
				alpn := tlsConn.ConnectionState().NegotiatedProtocol
				br := bufio.NewReader(tlsConn)
				var sb strings.Builder
				for {
					line, err := br.ReadString('\n')
					sb.WriteString(line)
					if err != nil || line == "\r\n" || line == "\n" {
						break
					}
				}
				resCh <- wireResult{alpn: alpn, rawWire: sb.String()}
				_, _ = io.WriteString(tlsConn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			}(c)
		}
	}()

	var socksHits atomic.Int32
	socksPort := startTestSocks5Server(t, "u2", "p2", &socksHits)
	pool := clashpool.NewManager(1, 65535, 1)
	if _, err := pool.SyncNodes("sub-http", []clashpool.Node{
		{
			ID:            "node-http",
			Name:          "HTTPWire",
			ProxySlotID:   "slot-http",
			ListenerPort:  socksPort,
			SocksUsername: "u2",
			SocksPassword: "p2",
			ExitIP:        "198.51.100.11",
			Health:        clashpool.HealthHealthy,
			Enabled:       true,
		},
	}, true); err != nil {
		t.Fatalf("SyncNodes: %v", err)
	}
	if err := pool.BindAccountWithProfile("acc-http-socks", "node-http", false, ClaudeNodeProfileID); err != nil {
		t.Fatalf("BindAccountWithProfile: %v", err)
	}

	dialer := NewAccountDialer(pool)
	dialer.SetRootCAs(roots)
	targetURL := "https://" + ln.Addr().String() + "/v1/messages"

	makeReq := func() *http.Request {
		r, _ := http.NewRequest(http.MethodPost, targetURL, strings.NewReader(`{}`))
		// Use canonical Header.Set to simulate Go callers; Dialer must emit exact CLI wire casing.
		r.Header.Set("User-Agent", "claude-cli/2.1.321 (external, cli)")
		r.Header.Set("X-Stainless-OS", "Linux")
		r.Header.Set("X-App", "cli")
		r.Header.Set("Anthropic-Beta", "oauth-2025-04-20")
		r.Header.Set("Anthropic-Version", "2023-06-01")
		r.Header.Set("X-Claude-Code-Session-Id", "sess-123")
		return r
	}

	resDirect, err := dialer.DoDirectRequest(context.Background(), "acc-http-direct", ClaudeNodeProfileID, makeReq(), true)
	if err != nil {
		t.Fatalf("DoDirectRequest failed: %v", err)
	}
	_ = resDirect.Response.Body.Close()
	wireDirect := <-resCh

	resSocks, err := dialer.DoAccountRequest(context.Background(), "acc-http-socks", ClaudeNodeProfileID, makeReq())
	if err != nil {
		t.Fatalf("DoAccountRequest failed: %v", err)
	}
	_ = resSocks.Response.Body.Close()
	wireSocks := <-resCh

	for _, tc := range []struct {
		name string
		got  wireResult
	}{
		{"direct_api", wireDirect},
		{"socks5", wireSocks},
	} {
		if tc.got.alpn != "http/1.1" {
			t.Fatalf("%s negotiated ALPN=%q, want http/1.1", tc.name, tc.got.alpn)
		}
		for _, wantLine := range []string{
			"X-Stainless-OS: Linux\r\n",
			"x-app: cli\r\n",
			"anthropic-beta: oauth-2025-04-20\r\n",
			"anthropic-version: 2023-06-01\r\n",
			"X-Claude-Code-Session-Id: sess-123\r\n",
			"User-Agent: claude-cli/2.1.321 (external, cli)\r\n",
		} {
			if !strings.Contains(tc.got.rawWire, wantLine) {
				t.Fatalf("%s missing exact wire header %q in:\n%s", tc.name, wantLine, tc.got.rawWire)
			}
		}
		for _, forbidden := range []string{"Go-http-client", "X-App:", "Anthropic-Beta:", "Anthropic-Version:"} {
			if strings.Contains(tc.got.rawWire, forbidden) {
				t.Fatalf("%s leaked forbidden wire string %q in:\n%s", tc.name, forbidden, tc.got.rawWire)
			}
		}
	}
	if socksHits.Load() < 1 {
		t.Fatalf("expected SOCKS5 hit, got %d", socksHits.Load())
	}
}
