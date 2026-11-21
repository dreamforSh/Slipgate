package stealth

import (
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"net"
	"slices"
	"strings"

	utls "github.com/refraction-networking/utls"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

// ProfileSpec aliases clashpool.TLSProfile to keep a cycle-free package DAG (clashpool <- stealth).
type ProfileSpec = clashpool.TLSProfile

const (
	DefaultProfileID   = "chrome-131"
	ClaudeBunProfileID = "claude-bun-21"
	AutoProfileID      = "auto"
)

var (
	ErrUnknownProfile                = errors.New("stealth: unknown TLS profile")
	ErrBuiltInProfileLock            = clashpool.ErrBuiltInProfileLock
	ErrKeyShareWithoutSupportedGroups = clashpool.ErrKeyShareWithoutSupportedGroups
)

type KeyShareNotInSupportedGroupsError = clashpool.KeyShareNotInSupportedGroupsError

// Default BoringSSL / Claude Code 2.1.280 Bun wire parameters (mirrors linksyncx defaults).
var (
	defaultWireCipherSuites = []uint16{
		utls.TLS_AES_128_GCM_SHA256,
		utls.TLS_AES_256_GCM_SHA384,
		utls.TLS_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_RSA_WITH_AES_128_CBC_SHA,
		utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		utls.TLS_RSA_WITH_3DES_EDE_CBC_SHA,
		utls.FAKE_TLS_EMPTY_RENEGOTIATION_INFO_SCSV,
	}

	defaultWireCurves = []uint16{
		uint16(utls.X25519MLKEM768),
		uint16(utls.X25519),
		uint16(utls.CurveP256),
		uint16(utls.CurveP384),
	}

	defaultWirePointFormats = []uint16{0}

	defaultWireSignatureAlgorithms = []uint16{
		uint16(utls.ECDSAWithP256AndSHA256),
		uint16(utls.PSSWithSHA256),
		uint16(utls.PKCS1WithSHA256),
		uint16(utls.ECDSAWithP384AndSHA384),
		uint16(utls.PSSWithSHA384),
		uint16(utls.PKCS1WithSHA384),
		uint16(utls.PSSWithSHA512),
		uint16(utls.PKCS1WithSHA512),
		uint16(utls.PKCS1WithSHA1),
	}

	defaultWireSupportedVersions = []uint16{
		tls.VersionTLS13,
		tls.VersionTLS12,
	}

	defaultWireKeyShareGroups = []uint16{
		uint16(utls.X25519MLKEM768),
		uint16(utls.X25519),
	}

	defaultWirePSKModes = []uint16{1}

	defaultWireExtensions = []uint16{
		0,     // server_name
		23,    // extended_master_secret
		65281, // renegotiation_info
		10,    // supported_groups
		11,    // ec_point_formats
		35,    // session_ticket
		16,    // application_layer_protocol_negotiation
		5,     // status_request
		13,    // signature_algorithms
		18,    // signed_certificate_timestamp
		51,    // key_share
		45,    // psk_key_exchange_modes
		43,    // supported_versions
	}
)

var allowedPresets = map[string]struct{}{
	"":              {},
	"auto":          {},
	"custom_wire":   {},
	"claude_bun_21": {},
	"bun_default":   {},
	"chrome_auto":   {},
	"chrome_131":    {},
	"firefox_auto":  {},
	"safari_auto":   {},
	"ios_auto":      {},
	"edge_auto":     {},
	"randomized":    {},
}

// DefaultProfiles returns built-in uTLS profiles including selector "auto", Claude Bun 2.1.280 PQ wire defaults, and desktop browsers.
func DefaultProfiles() []ProfileSpec {
	return []ProfileSpec{
		{
			ID:                AutoProfileID,
			Name:              "Auto Sticky (Rendezvous OS-Aware)",
			Description:       "Deterministically assigns a concrete browser or Bun profile per account ID via Rendezvous hashing",
			ClientHelloPreset: "auto",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			BuiltIn:           true,
		},
		{
			ID:                  ClaudeBunProfileID,
			Name:                "Claude Code 2.1.280 (Bun uTLS + PQ X25519MLKEM768)",
			Description:         "Wire-exact BoringSSL/Bun ClientHello with X25519MLKEM768 hybrid key share",
			ClientHelloPreset:   "custom_wire",
			ALPNProtocols:       []string{"h2", "http/1.1"},
			UserAgentTemplate:   "claude-cli/2.1.280 (external, cli)",
			EnableGREASE:        false,
			CipherSuites:        append([]uint16(nil), defaultWireCipherSuites...),
			Curves:              append([]uint16(nil), defaultWireCurves...),
			PointFormats:        append([]uint16(nil), defaultWirePointFormats...),
			SignatureAlgorithms: append([]uint16(nil), defaultWireSignatureAlgorithms...),
			SupportedVersions:   append([]uint16(nil), defaultWireSupportedVersions...),
			KeyShareGroups:      append([]uint16(nil), defaultWireKeyShareGroups...),
			PSKModes:            append([]uint16(nil), defaultWirePSKModes...),
			Extensions:          append([]uint16(nil), defaultWireExtensions...),
			OSHint:              "linux",
			BuiltIn:             true,
		},
		{
			ID:                "chrome-131",
			Name:              "Chrome 131 (Desktop)",
			Description:       "Google Chrome desktop TLS + HTTP/2 ClientHello",
			ClientHelloPreset: "chrome_auto",
			JA3Fingerprint:    "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0",
			JA4Fingerprint:    "t13d1516h2_8daaf6152771_b186095e22b6",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			UserAgentTemplate: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			OSHint:            "windows",
			BuiltIn:           true,
		},
		{
			ID:                "firefox-133",
			Name:              "Firefox 133 (Desktop)",
			Description:       "Mozilla Firefox desktop TLS + HTTP/2 ClientHello",
			ClientHelloPreset: "firefox_auto",
			JA3Fingerprint:    "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-34-51-43-13-45-28-21,29-23-24-25-256-257,0",
			JA4Fingerprint:    "t13d1715h2_5b57614c22b0_7121fd43201b",
			ALPNProtocols:     []string{"h2", "http/1.1"},
			UserAgentTemplate: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
			OSHint:            "windows",
			BuiltIn:           true,
		},
		{
			ID:                "claude-cli-mac",
			Name:              "Claude Code CLI (macOS)",
			Description:       "HTTP/1.1 pinned CLI profile for macOS hosts",
			ClientHelloPreset: "chrome_auto",
			JA3Fingerprint:    "771,4865-4866-4867-49195-49199-49196-49200-52393-52392,0-23-65281-10-11-35-16-5-13-51-45-43-27,29-23-24,0",
			JA4Fingerprint:    "t13d1514h1_8daaf6152771_e5627efa2ab1",
			ALPNProtocols:     []string{"http/1.1"},
			UserAgentTemplate: "claude-cli/2.1.280 (external, cli)",
			OSHint:            "darwin",
			BuiltIn:           true,
		},
	}
}

// isGREASEValue reports whether v matches RFC 8701 GREASE codepoint syntax (0x?a?a with identical bytes).
func isGREASEValue(v uint16) bool {
	return (v&0x0f0f) == 0x0a0a && (v>>8) == (v&0xff)
}

// ValidateProfile checks linksyncx wire-level invariants and preset validity before persistence or dialing.
func ValidateProfile(spec ProfileSpec) error {
	preset := strings.ToLower(strings.TrimSpace(spec.ClientHelloPreset))
	if _, ok := allowedPresets[preset]; !ok {
		return &clashpool.TLSProfileValidationError{
			Reason: clashpool.TLSProfileReasonInvalid,
			Field:  "clientHelloPreset",
			Err:    fmt.Errorf("unknown clientHelloPreset %q", spec.ClientHelloPreset),
		}
	}
	if len(spec.CipherSuites) > 256 || len(spec.Curves) > 256 || len(spec.Extensions) > 256 ||
		len(spec.SignatureAlgorithms) > 256 || len(spec.SupportedVersions) > 256 || len(spec.KeyShareGroups) > 256 {
		return &clashpool.TLSProfileValidationError{
			Reason: clashpool.TLSProfileReasonInvalid,
			Field:  "extensions",
			Err:    errors.New("TLS fingerprint wire list exceeds 256 entries"),
		}
	}
	for _, pf := range spec.PointFormats {
		if pf > 255 {
			return &clashpool.TLSProfileValidationError{
				Reason: clashpool.TLSProfileReasonInvalid,
				Field:  "pointFormats",
				Err:    fmt.Errorf("point format %d exceeds uint8 range", pf),
			}
		}
	}
	for _, m := range spec.PSKModes {
		if m > 255 {
			return &clashpool.TLSProfileValidationError{
				Reason: clashpool.TLSProfileReasonInvalid,
				Field:  "pskModes",
				Err:    fmt.Errorf("psk mode %d exceeds uint8 range", m),
			}
		}
	}

	if len(spec.Extensions) > 0 {
		hasKeyShareExt := slices.Contains(spec.Extensions, 51) || len(spec.KeyShareGroups) > 0
		if hasKeyShareExt && !slices.Contains(spec.Extensions, 10) {
			return &clashpool.TLSProfileValidationError{
				Reason: clashpool.TLSProfileReasonKeyShareWithoutSupportedGroups,
				Field:  "extensions",
				Err:    ErrKeyShareWithoutSupportedGroups,
			}
		}
	}

	if len(spec.KeyShareGroups) > 0 {
		effectiveCurves := spec.Curves
		if len(effectiveCurves) == 0 {
			effectiveCurves = defaultWireCurves
		}
		for _, g := range spec.KeyShareGroups {
			if isGREASEValue(g) || g == utls.GREASE_PLACEHOLDER {
				continue
			}
			if !slices.Contains(effectiveCurves, g) {
				return &clashpool.TLSProfileValidationError{
					Reason: clashpool.TLSProfileReasonKeyShareNotInCurves,
					Field:  "keyShareGroups",
					Group:  g,
					Err:    &KeyShareNotInSupportedGroupsError{Group: g},
				}
			}
		}
	}
	return nil
}

// ProfileCacheKey returns a zero-collision FNV-1a 64-bit hash over all wire-affecting ClientHello parameters.
func ProfileCacheKey(spec ProfileSpec) uint64 {
	h := fnv.New64a()
	var buf [8]byte
	writeStr := func(s string) {
		binary.LittleEndian.PutUint32(buf[:4], uint32(len(s)))
		_, _ = h.Write(buf[:4])
		_, _ = h.Write([]byte(s))
	}
	writeU16Slice := func(tag byte, vals []uint16) {
		_, _ = h.Write([]byte{tag})
		binary.LittleEndian.PutUint32(buf[:4], uint32(len(vals)))
		_, _ = h.Write(buf[:4])
		for _, v := range vals {
			binary.LittleEndian.PutUint16(buf[:2], v)
			_, _ = h.Write(buf[:2])
		}
	}

	writeStr(strings.ToLower(strings.TrimSpace(spec.ID)))
	writeStr(strings.ToLower(strings.TrimSpace(spec.ClientHelloPreset)))
	if spec.EnableGREASE {
		_, _ = h.Write([]byte{1})
	} else {
		_, _ = h.Write([]byte{0})
	}
	binary.LittleEndian.PutUint32(buf[:4], uint32(len(spec.ALPNProtocols)))
	_, _ = h.Write(buf[:4])
	for _, p := range spec.ALPNProtocols {
		writeStr(p)
	}
	writeU16Slice(1, spec.CipherSuites)
	writeU16Slice(2, spec.Curves)
	writeU16Slice(3, spec.PointFormats)
	writeU16Slice(4, spec.SignatureAlgorithms)
	writeU16Slice(5, spec.SupportedVersions)
	writeU16Slice(6, spec.KeyShareGroups)
	writeU16Slice(7, spec.PSKModes)
	writeU16Slice(8, spec.Extensions)
	return h.Sum64()
}

// CanonicalTLSOS normalizes platform/OS hints into "linux", "darwin", "windows", "ios", or "".
func CanonicalTLSOS(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "darwin", "mac", "macos", "osx":
		return "darwin"
	case "windows", "win", "win32", "win64":
		return "windows"
	case "linux", "ubuntu", "debian", "alpine", "centos", "rhel":
		return "linux"
	case "ios", "iphone", "ipad":
		return "ios"
	default:
		return ""
	}
}

// StickyProfileForAccount performs deterministic splitmix64 Rendezvous selection constrained by optional OS hint.
func StickyProfileForAccount(accountID string, candidates []ProfileSpec, osHint string) (ProfileSpec, bool) {
	concrete := make([]ProfileSpec, 0, len(candidates))
	for _, c := range candidates {
		id := strings.ToLower(strings.TrimSpace(c.ID))
		preset := strings.ToLower(strings.TrimSpace(c.ClientHelloPreset))
		if id == "" || id == "auto" || id == "random" || preset == "auto" {
			continue
		}
		concrete = append(concrete, c)
	}
	if len(concrete) == 0 {
		return ProfileSpec{}, false
	}

	canonicalOS := CanonicalTLSOS(osHint)
	pool := concrete
	if canonicalOS != "" {
		matched := make([]ProfileSpec, 0, len(concrete))
		for _, c := range concrete {
			if CanonicalTLSOS(c.OSHint) == canonicalOS {
				matched = append(matched, c)
			}
		}
		if len(matched) > 0 {
			pool = matched
		}
	}

	var best ProfileSpec
	var bestScore uint64
	hasBest := false
	for _, c := range pool {
		score := rendezvousScore(accountID, c.ID)
		if !hasBest || score > bestScore || (score == bestScore && c.ID < best.ID) {
			best = c
			bestScore = score
			hasBest = true
		}
	}
	return best, hasBest
}

func rendezvousScore(accountID, profileID string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(accountID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(profileID))
	z := h.Sum64() + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// ResolveClientHelloID maps Slipgate profile presets onto utls.ClientHelloID templates.
func ResolveClientHelloID(preset string) utls.ClientHelloID {
	switch strings.ToLower(strings.TrimSpace(preset)) {
	case "firefox_auto", "firefox", "firefox_133":
		return utls.HelloFirefox_Auto
	case "safari_auto", "safari":
		return utls.HelloSafari_Auto
	case "ios_auto", "ios":
		return utls.HelloIOS_Auto
	case "edge_auto", "edge":
		return utls.HelloEdge_Auto
	case "randomized", "random":
		return utls.HelloRandomizedALPN
	case "custom_wire", "claude_bun_21", "bun_default":
		return utls.HelloCustom
	case "chrome_auto", "chrome_131", "":
		return utls.HelloChrome_Auto
	default:
		return utls.HelloChrome_Auto
	}
}

// BuildClientHelloSpec constructs a custom wire-level utls.ClientHelloSpec when wire parameters or custom preset are present.
func BuildClientHelloSpec(spec ProfileSpec) (*utls.ClientHelloSpec, error) {
	if err := ValidateProfile(spec); err != nil {
		return nil, err
	}
	preset := strings.ToLower(strings.TrimSpace(spec.ClientHelloPreset))
	useWire := spec.HasCustomWireSpec() || preset == "custom_wire" || preset == "claude_bun_21" || preset == "bun_default"
	if !useWire {
		return nil, nil
	}

	ciphers := append([]uint16(nil), spec.CipherSuites...)
	if len(ciphers) == 0 {
		ciphers = append([]uint16(nil), defaultWireCipherSuites...)
	}
	if spec.EnableGREASE && (len(ciphers) == 0 || (ciphers[0] != utls.GREASE_PLACEHOLDER && !isGREASEValue(ciphers[0]))) {
		ciphers = append([]uint16{utls.GREASE_PLACEHOLDER}, ciphers...)
	}

	rawCurves := spec.Curves
	if len(rawCurves) == 0 {
		rawCurves = defaultWireCurves
	}
	curves := make([]utls.CurveID, 0, len(rawCurves)+1)
	if spec.EnableGREASE {
		curves = append(curves, utls.GREASE_PLACEHOLDER)
	}
	for _, c := range rawCurves {
		if isGREASEValue(c) {
			curves = append(curves, utls.GREASE_PLACEHOLDER)
			continue
		}
		curves = append(curves, utls.CurveID(c))
	}

	rawPoints := spec.PointFormats
	if len(rawPoints) == 0 {
		rawPoints = defaultWirePointFormats
	}
	points := make([]uint8, 0, len(rawPoints))
	for _, p := range rawPoints {
		points = append(points, uint8(p))
	}

	rawSigAlgs := spec.SignatureAlgorithms
	if len(rawSigAlgs) == 0 {
		rawSigAlgs = defaultWireSignatureAlgorithms
	}
	sigAlgs := make([]utls.SignatureScheme, 0, len(rawSigAlgs))
	for _, s := range rawSigAlgs {
		sigAlgs = append(sigAlgs, utls.SignatureScheme(s))
	}

	rawVersions := spec.SupportedVersions
	if len(rawVersions) == 0 {
		rawVersions = defaultWireSupportedVersions
	}
	versions := make([]uint16, 0, len(rawVersions)+1)
	if spec.EnableGREASE {
		versions = append(versions, utls.GREASE_PLACEHOLDER)
	}
	var minVer, maxVer uint16
	for _, v := range rawVersions {
		if isGREASEValue(v) {
			versions = append(versions, utls.GREASE_PLACEHOLDER)
			continue
		}
		versions = append(versions, v)
		if minVer == 0 || v < minVer {
			minVer = v
		}
		if v > maxVer {
			maxVer = v
		}
	}
	if minVer == 0 {
		minVer = utls.VersionTLS12
	}
	if maxVer == 0 {
		maxVer = utls.VersionTLS13
	}

	rawKeyShares := spec.KeyShareGroups
	if len(rawKeyShares) == 0 {
		rawKeyShares = defaultWireKeyShareGroups
	}
	keyShares := make([]utls.KeyShare, 0, len(rawKeyShares)+1)
	if spec.EnableGREASE {
		keyShares = append(keyShares, utls.KeyShare{Group: utls.GREASE_PLACEHOLDER, Data: []byte{0}})
	}
	for _, g := range rawKeyShares {
		if isGREASEValue(g) || g == utls.GREASE_PLACEHOLDER {
			keyShares = append(keyShares, utls.KeyShare{Group: utls.GREASE_PLACEHOLDER, Data: []byte{0}})
			continue
		}
		keyShares = append(keyShares, utls.KeyShare{Group: utls.CurveID(g)})
	}

	rawPSK := spec.PSKModes
	if len(rawPSK) == 0 {
		rawPSK = defaultWirePSKModes
	}
	pskModes := make([]uint8, 0, len(rawPSK))
	for _, m := range rawPSK {
		pskModes = append(pskModes, uint8(m))
	}

	extIDs := spec.Extensions
	if len(extIDs) == 0 {
		extIDs = defaultWireExtensions
	}
	alpns := effectiveALPNs(spec.ALPNProtocols)
	exts := make([]utls.TLSExtension, 0, len(extIDs)+2)
	if spec.EnableGREASE {
		exts = append(exts, &utls.UtlsGREASEExtension{})
	}
	for _, id := range extIDs {
		if isGREASEValue(id) || id == utls.GREASE_PLACEHOLDER {
			exts = append(exts, &utls.UtlsGREASEExtension{})
			continue
		}
		switch id {
		case 0:
			exts = append(exts, &utls.SNIExtension{})
		case 5:
			exts = append(exts, &utls.StatusRequestExtension{})
		case 10:
			exts = append(exts, &utls.SupportedCurvesExtension{Curves: curves})
		case 11:
			exts = append(exts, &utls.SupportedPointsExtension{SupportedPoints: points})
		case 13:
			exts = append(exts, &utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: sigAlgs})
		case 16:
			exts = append(exts, &utls.ALPNExtension{AlpnProtocols: alpns})
		case 18:
			exts = append(exts, &utls.SCTExtension{})
		case 21:
			exts = append(exts, &utls.UtlsPaddingExtension{GetPaddingLen: utls.BoringPaddingStyle})
		case 23:
			exts = append(exts, &utls.ExtendedMasterSecretExtension{})
		case 27:
			exts = append(exts, &utls.UtlsCompressCertExtension{Algorithms: []utls.CertCompressionAlgo{utls.CertCompressionBrotli}})
		case 35:
			exts = append(exts, &utls.SessionTicketExtension{})
		case 41:
			exts = append(exts, &utls.UtlsPreSharedKeyExtension{})
		case 43:
			exts = append(exts, &utls.SupportedVersionsExtension{Versions: versions})
		case 45:
			exts = append(exts, &utls.PSKKeyExchangeModesExtension{Modes: pskModes})
		case 51:
			exts = append(exts, &utls.KeyShareExtension{KeyShares: keyShares})
		case 17513:
			exts = append(exts, &utls.ApplicationSettingsExtensionNew{SupportedProtocols: []string{"h2"}})
		case 0xfe0d:
			exts = append(exts, &utls.GREASEEncryptedClientHelloExtension{})
		case 65281:
			exts = append(exts, &utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient})
		default:
			exts = append(exts, &utls.GenericExtension{Id: id})
		}
	}
	if spec.EnableGREASE {
		exts = append(exts, &utls.UtlsGREASEExtension{})
	}

	return &utls.ClientHelloSpec{
		CipherSuites:       ciphers,
		CompressionMethods: []byte{0},
		Extensions:         exts,
		TLSVersMin:         minVer,
		TLSVersMax:         maxVer,
	}, nil
}

// BuildUConn creates a *utls.UConn over rawConn using custom wire parameters when present, or a preset ClientHelloID.
func BuildUConn(rawConn net.Conn, serverName string, spec ProfileSpec, sessCache utls.ClientSessionCache, tlsConfig *utls.Config) (*utls.UConn, error) {
	cfg := tlsConfig
	if cfg == nil {
		cfg = &utls.Config{}
	} else {
		cfg = cfg.Clone()
	}
	cfg.ServerName = serverName
	if sessCache != nil && cfg.ClientSessionCache == nil {
		cfg.ClientSessionCache = sessCache
	}
	cfg.PreferSkipResumptionOnNilExtension = true

	customSpec, err := BuildClientHelloSpec(spec)
	if err != nil {
		return nil, err
	}
	if customSpec != nil {
		uConn := utls.UClient(rawConn, cfg, utls.HelloCustom)
		if err := uConn.ApplyPreset(customSpec); err != nil {
			return nil, fmt.Errorf("stealth: apply custom ClientHelloSpec: %w", err)
		}
		return uConn, nil
	}

	helloID := ResolveClientHelloID(spec.ClientHelloPreset)
	if len(spec.ALPNProtocols) > 0 {
		alpns := effectiveALPNs(spec.ALPNProtocols)
		cfg.NextProtos = alpns
		if presetSpec, specErr := utls.UTLSIdToSpec(helloID); specErr == nil {
			patchALPNInSpec(&presetSpec, alpns)
			uConn := utls.UClient(rawConn, cfg, utls.HelloCustom)
			if err := uConn.ApplyPreset(&presetSpec); err != nil {
				return nil, fmt.Errorf("stealth: apply patched preset spec: %w", err)
			}
			return uConn, nil
		}
		uConn := utls.UClient(rawConn, cfg, helloID)
		if err := uConn.BuildHandshakeState(); err == nil {
			applyALPNInExtensions(uConn, alpns)
		}
		return uConn, nil
	}

	return utls.UClient(rawConn, cfg, helloID), nil
}

func effectiveALPNs(configured []string) []string {
	if len(configured) == 0 {
		return []string{"h2", "http/1.1"}
	}
	out := make([]string, 0, len(configured))
	for _, proto := range configured {
		p := strings.TrimSpace(proto)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{"h2", "http/1.1"}
	}
	return out
}

func patchALPNInSpec(spec *utls.ClientHelloSpec, alpns []string) {
	for _, ext := range spec.Extensions {
		if alpnExt, ok := ext.(*utls.ALPNExtension); ok {
			alpnExt.AlpnProtocols = alpns
			return
		}
	}
	spec.Extensions = append(spec.Extensions, &utls.ALPNExtension{AlpnProtocols: alpns})
}

func applyALPNInExtensions(uConn *utls.UConn, alpns []string) {
	replaced := false
	for _, ext := range uConn.Extensions {
		if alpnExt, ok := ext.(*utls.ALPNExtension); ok {
			alpnExt.AlpnProtocols = alpns
			replaced = true
			break
		}
	}
	if !replaced {
		uConn.Extensions = append(uConn.Extensions, &utls.ALPNExtension{AlpnProtocols: alpns})
	}
	_ = uConn.ApplyConfig()
	_ = uConn.MarshalClientHello()
}
