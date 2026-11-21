package clashcore

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/proxy"
)

func TestParseSubscriptionFormatsAndSafety(t *testing.T) {
	t.Parallel()

	yamlSub := `
proxies:
  - name: "Tokyo-01"
    type: socks5
    server: 203.0.113.10
    port: 1080
    interface-name: eth0
  - name: "剩余流量：100GB"
    type: http
    server: 203.0.113.11
    port: 8080
  - name: "Unsafe-Direct"
    type: direct
    server: 1.1.1.1
    port: 80
  - name: "Loopback-Rejected"
    type: socks5
    server: 127.0.0.1
    port: 1080
`
	res, err := ParseSubscription([]byte(yamlSub), ParseOptions{
		ExcludeRegex: "剩余流量|到期时间|官网",
	})
	if err != nil {
		t.Fatalf("ParseSubscription failed: %v", err)
	}
	if res.Format != FormatClashYAML {
		t.Fatalf("expected %s, got %s", FormatClashYAML, res.Format)
	}
	if len(res.Nodes) != 1 || res.Nodes[0].Name != "Tokyo-01" {
		t.Fatalf("expected 1 sanitized node Tokyo-01, got %+v (skipped=%+v)", res.Nodes, res.Skipped)
	}
	if _, leaked := res.Nodes[0].Config["interface-name"]; leaked {
		t.Fatalf("expected interface-name stripped")
	}

	b64Sub := base64.StdEncoding.EncodeToString([]byte(yamlSub))
	resB64, err := ParseSubscription([]byte(b64Sub), ParseOptions{
		ExcludeRegex: "剩余流量|到期时间|官网",
	})
	if err != nil {
		t.Fatalf("Base64 YAML ParseSubscription failed: %v", err)
	}
	if resB64.Format != FormatBase64YAML || len(resB64.Nodes) != 1 {
		t.Fatalf("unexpected base64 parse result: %+v", resB64)
	}

	if _, err := ParseSubscription([]byte("<!doctype html><html>login</html>"), ParseOptions{}); !errors.Is(err, ErrHTMLPage) {
		t.Fatalf("expected ErrHTMLPage, got %v", err)
	}
}

func TestRenderConfigDeterministicAndFailClosed(t *testing.T) {
	t.Parallel()

	nodes := []RenderNode{
		{
			NodeID:     "node-b",
			ListenPort: 20002,
			Username:   "u2",
			Password:   "p2",
			Active:     false,
			Config:     map[string]any{"type": "socks5", "server": "203.0.113.2", "port": 1080},
		},
		{
			NodeID:     "node-a",
			ListenPort: 20001,
			Username:   "u1",
			Password:   "p1",
			Active:     true,
			Config:     map[string]any{"type": "socks5", "server": "203.0.113.1", "port": 1080},
		},
	}

	r1, err := RenderConfig(nodes, RenderOptions{})
	if err != nil {
		t.Fatalf("RenderConfig failed: %v", err)
	}
	r2, err := RenderConfig([]RenderNode{nodes[1], nodes[0]}, RenderOptions{})
	if err != nil {
		t.Fatalf("RenderConfig reorder failed: %v", err)
	}
	if r1.Hash != r2.Hash {
		t.Fatalf("expected deterministic config hash across order")
	}
	if r1.ActiveProxies != 1 || r1.Listeners != 2 {
		t.Fatalf("unexpected rendered counts: %+v", r1)
	}

	yamlText := string(r1.Payload)
	if strings.Contains(yamlText, "DIRECT") {
		t.Fatalf("fail-closed config must never contain DIRECT rule:\n%s", yamlText)
	}
	if !strings.Contains(yamlText, "MATCH,REJECT") || !strings.Contains(yamlText, "proxy: REJECT") {
		t.Fatalf("expected inactive listener routed to REJECT and MATCH,REJECT fallback:\n%s", yamlText)
	}
}

// startMinimalSOCKS5Upstream spins up a minimal SOCKS5 CONNECT server (no-auth / user-pass) for testing embedded mihomo.
func startMinimalSOCKS5Upstream(t *testing.T, expectedUser, expectedPass string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream socks5: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handleMinimalSocks5Conn(c, expectedUser, expectedPass)
		}
	}()
	return ln.Addr().String()
}

func handleMinimalSocks5Conn(c net.Conn, expectedUser, expectedPass string) {
	defer c.Close()

	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil || hdr[0] != 0x05 {
		return
	}
	methods := make([]byte, int(hdr[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}

	if expectedUser != "" {
		_, _ = c.Write([]byte{0x05, 0x02})
		var authVer [2]byte
		if _, err := io.ReadFull(c, authVer[:]); err != nil {
			return
		}
		u := make([]byte, int(authVer[1]))
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
		if string(u) != expectedUser || string(p) != expectedPass {
			_, _ = c.Write([]byte{0x01, 0x01})
			return
		}
		_, _ = c.Write([]byte{0x01, 0x00})
	} else {
		_, _ = c.Write([]byte{0x05, 0x00})
	}

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
	case 0x04:
		var ip [16]byte
		if _, err := io.ReadFull(c, ip[:]); err != nil {
			return
		}
		host = net.IP(ip[:]).String()
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
	_, _ = c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})

	errCh := make(chan error, 2)
	go func() { _, e := io.Copy(remote, c); errCh <- e }()
	go func() { _, e := io.Copy(c, remote); errCh <- e }()
	<-errCh
}

func reserveFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve free port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func TestEmbeddedEngineApplyDelayTestAndListener(t *testing.T) {
	// Embedded mihomo uses process-wide singleton state; do not call t.Parallel().
	upstreamAddr := startMinimalSOCKS5Upstream(t, "up-user", "up-pass")
	upHost, upPortStr, _ := net.SplitHostPort(upstreamAddr)
	var upPort int
	_, _ = fmt.Sscanf(upPortStr, "%d", &upPort)

	targetSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("through-mihomo-ok"))
	}))
	defer targetSrv.Close()

	yamlSub := fmt.Sprintf(`
proxies:
  - name: "Local-Upstream-Test"
    type: socks5
    server: %s
    port: %d
    username: up-user
    password: up-pass
`, upHost, upPort)

	parsed, err := ParseSubscription([]byte(yamlSub), ParseOptions{AllowLoopbackServers: true})
	if err != nil {
		t.Fatalf("ParseSubscription loopback failed: %v", err)
	}

	listenerPort := reserveFreePort(t)
	rendered, err := RenderConfig([]RenderNode{
		{
			NodeID:     "n1",
			ListenPort: listenerPort,
			Username:   "slot-u1",
			Password:   "slot-p1",
			Active:     true,
			Config:     parsed.Nodes[0].Config,
		},
	}, RenderOptions{})
	if err != nil {
		t.Fatalf("RenderConfig failed: %v", err)
	}

	engine, err := Open(Options{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Open embedded mihomo engine failed: %v", err)
	}
	defer func() { _ = engine.Close() }()

	if !engine.Ready() || engine.Mode() != "embedded" {
		t.Fatalf("expected embedded runtime ready")
	}
	if err := engine.Apply(context.Background(), rendered.Payload); err != nil {
		t.Fatalf("Engine.Apply failed: %v\n%s", err, string(rendered.Payload))
	}
	if !engine.HasProxy(ProxyName("n1")) {
		t.Fatalf("expected proxy %s present in mihomo runtime", ProxyName("n1"))
	}

	// 1. Verify internal mihomo DelayTest through upstream proxy
	delayCtx, delayCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer delayCancel()
	if _, err := engine.DelayTest(delayCtx, ProxyName("n1"), targetSrv.URL); err != nil {
		t.Fatalf("Engine.DelayTest failed: %v", err)
	}

	// 2. Verify real HTTP request through mihomo's authenticated mixed SOCKS5 listener
	dialer, err := proxy.SOCKS5(
		"tcp",
		fmt.Sprintf("127.0.0.1:%d", listenerPort),
		&proxy.Auth{User: "slot-u1", Password: "slot-p1"},
		proxy.Direct,
	)
	if err != nil {
		t.Fatalf("proxy.SOCKS5 failed: %v", err)
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(_ context.Context, network, addr string) (net.Conn, error) {
				return dialer.Dial(network, addr)
			},
		},
	}
	resp, err := client.Get(targetSrv.URL)
	if err != nil {
		t.Fatalf("HTTP GET via mihomo listener failed: %v", err)
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)
	if string(bodyBytes) != "through-mihomo-ok" {
		t.Fatalf("unexpected body through mihomo: %q", string(bodyBytes))
	}
}
