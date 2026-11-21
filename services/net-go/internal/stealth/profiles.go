package stealth

import (
	"crypto/x509"
	"fmt"
	"net"
	"slices"
	"strings"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	utls "github.com/refraction-networking/utls"
)

// ProfileSpec aliases clashpool.TLSProfile so pool storage and uTLS dialing share one canonical struct.
type ProfileSpec = clashpool.TLSProfile

// DefaultProfileID is used when an account does not explicitly select a custom TLS profile.
const DefaultProfileID = "chrome-131"

// DefaultProfiles returns built-in browser and CLI ClientHello fingerprint templates.
func DefaultProfiles() []ProfileSpec {
	return []ProfileSpec{
		{
			ID:                "chrome-131",
			Name:              "Chrome 131 (Windows Desktop)",
			ClientHelloPreset: "chrome_auto",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			UserAgentTemplate: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			BuiltIn:           true,
		},
		{
			ID:                "firefox-133",
			Name:              "Firefox 133 (Desktop)",
			ClientHelloPreset: "firefox_auto",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			UserAgentTemplate: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
			BuiltIn:           true,
		},
		{
			ID:                "safari-18",
			Name:              "Safari 18 (macOS)",
			ClientHelloPreset: "safari_auto",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			UserAgentTemplate: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
			BuiltIn:           true,
		},
		{
			ID:                "claude-cli-mac",
			Name:              "Official CLI Runtime (Bun/macOS)",
			ClientHelloPreset: "chrome_auto",
			ALPNProtocols:     []string{"http/1.1"},
			UserAgentTemplate: "claude-cli/2.1.280 (external, cli)",
			BuiltIn:           true,
		},
	}
}

// ResolveClientHelloID maps a declarative preset key to a uTLS ClientHelloID.
func ResolveClientHelloID(preset string) (utls.ClientHelloID, error) {
	switch strings.ToLower(strings.TrimSpace(preset)) {
	case "", "chrome_auto", "claude_cli":
		return utls.HelloChrome_Auto, nil
	case "firefox_auto":
		return utls.HelloFirefox_Auto, nil
	case "safari_auto":
		return utls.HelloSafari_Auto, nil
	case "ios_auto":
		return utls.HelloIOS_Auto, nil
	case "edge_auto":
		return utls.HelloEdge_Auto, nil
	default:
		return utls.ClientHelloID{}, fmt.Errorf("stealth: unsupported clientHelloPreset %q", preset)
	}
}

// BuildUConn wraps rawConn in a uTLS client configured to match spec with explicit ALPN safety.
func BuildUConn(
	rawConn net.Conn,
	serverName string,
	spec ProfileSpec,
	cache utls.ClientSessionCache,
	rootCAs *x509.CertPool,
	allowH2 bool,
) (*utls.UConn, error) {
	helloID, err := ResolveClientHelloID(spec.ClientHelloPreset)
	if err != nil {
		return nil, err
	}

	helloSpec, err := utls.UTLSIdToSpec(helloID)
	if err != nil {
		return nil, fmt.Errorf("stealth: resolve uTLS spec %q: %w", spec.ClientHelloPreset, err)
	}

	alpns := effectiveALPNs(spec.ALPNProtocols, allowH2)
	applyALPNToSpec(&helloSpec, alpns, allowH2)

	uconn := utls.UClient(rawConn, &utls.Config{
		ServerName:                         serverName,
		RootCAs:                            rootCAs,
		ClientSessionCache:                 cache,
		OmitEmptyPsk:                       true,
		PreferSkipResumptionOnNilExtension: true,
	}, utls.HelloCustom)

	if err := uconn.ApplyPreset(&helloSpec); err != nil {
		return nil, fmt.Errorf("stealth: apply uTLS preset %q: %w", spec.ID, err)
	}
	return uconn, nil
}

func effectiveALPNs(configured []string, allowH2 bool) []string {
	out := make([]string, 0, len(configured))
	for _, proto := range configured {
		p := strings.TrimSpace(proto)
		if p == "" {
			continue
		}
		if !allowH2 && strings.EqualFold(p, "h2") {
			continue
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{"http/1.1"}
	}
	return out
}

func applyALPNToSpec(spec *utls.ClientHelloSpec, alpns []string, allowH2 bool) {
	filtered := make([]utls.TLSExtension, 0, len(spec.Extensions)+1)
	replacedALPN := false
	for _, ext := range spec.Extensions {
		if _, ok := ext.(*utls.ALPNExtension); ok {
			filtered = append(filtered, &utls.ALPNExtension{AlpnProtocols: alpns})
			replacedALPN = true
			continue
		}
		if !allowH2 {
			switch ext.(type) {
			case *utls.ApplicationSettingsExtension, *utls.ApplicationSettingsExtensionNew:
				continue
			}
		}
		filtered = append(filtered, ext)
	}
	if !replacedALPN {
		filtered = append(filtered, &utls.ALPNExtension{AlpnProtocols: alpns})
	}
	spec.Extensions = filtered
}
