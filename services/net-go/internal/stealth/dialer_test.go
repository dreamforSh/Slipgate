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

	// 4. Built-in chrome-131 profile negotiates HTTP/2 over authenticated Clash SOCKS5 tunnel
	reqH2, _ := http.NewRequest(http.MethodGet, tlsSrv.URL+"/v1/test", nil)
	resH2, err := dialer.DoAccountRequest(context.Background(), "acc-1", "chrome-131", reqH2)
	if err != nil {
		t.Fatalf("DoAccountRequest (chrome-131) failed: %v", err)
	}
	bodyH2, _ := io.ReadAll(resH2.Response.Body)
	_ = resH2.Response.Body.Close()
	if string(bodyH2) != "hello-utls-clash" || resH2.NegotiatedALPN != "h2" {
		t.Fatalf("unexpected H2 uTLS result: body=%q alpn=%q tls=%q", string(bodyH2), resH2.NegotiatedALPN, resH2.TLSVersion)
	}
	if socksHits.Load() < 1 || seenUA == "" {
		t.Fatalf("expected request to traverse SOCKS5 with template UA, hits=%d ua=%q", socksHits.Load(), seenUA)
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
