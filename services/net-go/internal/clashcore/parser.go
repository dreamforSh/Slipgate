package clashcore

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/metacubex/mihomo/common/convert"
	"gopkg.in/yaml.v3"
)

const (
	DefaultMaxNodes = 2000
	maxNameRunes    = 128
)

var (
	ErrEmpty         = errors.New("clashcore: subscription payload is empty")
	ErrHTMLPage      = errors.New("clashcore: subscription returned HTML instead of proxy list")
	ErrNoProxies     = errors.New("clashcore: subscription contains no usable proxies")
	ErrProvidersOnly = errors.New("clashcore: proxy-providers-only subscriptions are unsupported")
	ErrTooManyNodes  = errors.New("clashcore: subscription exceeds node cap")
)

var allowedProxyTypes = map[string]struct{}{
	"ss": {}, "ssr": {}, "vmess": {}, "vless": {}, "trojan": {},
	"hysteria": {}, "hysteria2": {}, "tuic": {}, "anytls": {}, "snell": {},
	"mieru": {}, "wireguard": {}, "ssh": {}, "socks5": {}, "http": {},
}

var strippedLocalKeys = []string{"interface-name", "routing-mark"}

var cgnatRange = netip.MustParsePrefix("100.64.0.0/10")

// SubscriptionFormat identifies how the subscription content was encoded.
type SubscriptionFormat string

const (
	FormatClashYAML  SubscriptionFormat = "clash_yaml"
	FormatBase64YAML SubscriptionFormat = "base64_yaml"
	FormatURIList    SubscriptionFormat = "uri_list"
)

// ParsedNode holds one sanitized proxy definition ready for materialization into a Clash listener.
type ParsedNode struct {
	Name   string
	Type   string
	Server string
	Port   int
	Hash   string
	Config map[string]any
}

// SkippedNode records an entry rejected during parsing or filtering.
type SkippedNode struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ParseOptions controls subscription decoding and safety filters.
type ParseOptions struct {
	MaxNodes             int
	ExcludeRegex         string
	AllowLoopbackServers bool
}

// ParseResult contains accepted and skipped nodes from ParseSubscription.
type ParseResult struct {
	Format  SubscriptionFormat
	Nodes   []ParsedNode
	Skipped []SkippedNode
}

// ParseSubscription parses Clash YAML, Base64 YAML, or V2Ray/proxy share links while enforcing
// strict type allowlists so no DIRECT / local-interface routing can enter the exit pool.
func ParseSubscription(body []byte, opts ParseOptions) (*ParseResult, error) {
	data := bytes.TrimSpace(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")))
	if len(data) == 0 {
		return nil, ErrEmpty
	}
	if looksLikeHTML(data) {
		return nil, ErrHTMLPage
	}

	var excludeRe *regexp.Regexp
	if strings.TrimSpace(opts.ExcludeRegex) != "" {
		compiled, err := regexp.Compile(opts.ExcludeRegex)
		if err != nil {
			return nil, fmt.Errorf("clashcore: invalid exclude regex %q: %w", opts.ExcludeRegex, err)
		}
		excludeRe = compiled
	}

	var (
		mappings []map[string]any
		format   SubscriptionFormat
	)
	if found, ok, err := parseClashYAML(data); ok {
		if err != nil {
			return nil, err
		}
		mappings, format = found, FormatClashYAML
	} else if decoded, decErr := decodeBase64(data); decErr == nil {
		if found, ok, err := parseClashYAML(decoded); ok {
			if err != nil {
				return nil, err
			}
			mappings, format = found, FormatBase64YAML
		}
	}

	if format == "" {
		converted, err := convert.ConvertsV2Ray(data)
		if err != nil || len(converted) == 0 {
			return nil, ErrNoProxies
		}
		mappings, format = converted, FormatURIList
	}

	maxNodes := opts.MaxNodes
	if maxNodes <= 0 {
		maxNodes = DefaultMaxNodes
	}

	result := &ParseResult{Format: format}
	for _, mapping := range mappings {
		node, reason := sanitizeNode(mapping, excludeRe, opts.AllowLoopbackServers)
		if reason != "" {
			result.Skipped = append(result.Skipped, SkippedNode{
				Name:   truncateRunes(asString(mapping["name"]), maxNameRunes),
				Reason: reason,
			})
			continue
		}
		result.Nodes = append(result.Nodes, node)
	}

	if len(result.Nodes) == 0 {
		return nil, ErrNoProxies
	}
	if len(result.Nodes) > maxNodes {
		return nil, fmt.Errorf("%w (%d > %d)", ErrTooManyNodes, len(result.Nodes), maxNodes)
	}
	return result, nil
}

// ConfigHash produces a deterministic SHA-256 fingerprint of a node's upstream proxy attributes.
func ConfigHash(cfg map[string]any) string {
	cloned := make(map[string]any, len(cfg))
	for k, v := range cfg {
		if k == "name" {
			continue
		}
		cloned[k] = v
	}
	raw, err := json.Marshal(cloned)
	if err != nil {
		raw = []byte(fmt.Sprint(cloned))
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// IsLoopbackOrUnspecified returns true for localhost, 127.0.0.0/8, ::1, and 0.0.0.0 / ::.
func IsLoopbackOrUnspecified(server string) bool {
	host := strings.Trim(strings.TrimSpace(server), "[]")
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		return true
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	return addr.IsLoopback() || addr.IsUnspecified() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || cgnatRange.Contains(addr)
}

func sanitizeNode(raw map[string]any, excludeRe *regexp.Regexp, allowLoopback bool) (ParsedNode, string) {
	mapping, _ := normalizeYAMLValue(raw).(map[string]any)
	if mapping == nil {
		return ParsedNode{}, "invalid node object"
	}

	typ := strings.ToLower(strings.TrimSpace(asString(mapping["type"])))
	if _, ok := allowedProxyTypes[typ]; !ok {
		return ParsedNode{}, fmt.Sprintf("unsupported proxy type %q", typ)
	}

	server := strings.TrimSpace(asString(mapping["server"]))
	if server == "" {
		return ParsedNode{}, "missing server host"
	}
	if !allowLoopback && IsLoopbackOrUnspecified(server) {
		return ParsedNode{}, fmt.Sprintf("loopback/local server %q disallowed", server)
	}

	port, ok := asInt(mapping["port"])
	if !ok || port < 0 || port > 65535 || (port == 0 && asString(mapping["ports"]) == "") {
		return ParsedNode{}, "invalid port"
	}
	if _, chained := mapping["dialer-proxy"]; chained {
		return ParsedNode{}, "dialer-proxy chaining disallowed"
	}
	for _, k := range strippedLocalKeys {
		delete(mapping, k)
	}

	name := truncateRunes(strings.TrimSpace(asString(mapping["name"])), maxNameRunes)
	if name == "" {
		name = fmt.Sprintf("%s-%s:%d", typ, server, port)
	}
	if excludeRe != nil && excludeRe.MatchString(name) {
		return ParsedNode{}, "matched exclude_regex"
	}

	mapping["name"] = name
	mapping["type"] = typ
	mapping["server"] = server

	return ParsedNode{
		Name:   name,
		Type:   typ,
		Server: server,
		Port:   port,
		Hash:   ConfigHash(mapping),
		Config: mapping,
	}, ""
}

func parseClashYAML(data []byte) ([]map[string]any, bool, error) {
	var doc any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, false, nil
	}

	var items []any
	switch typed := normalizeYAMLValue(doc).(type) {
	case map[string]any:
		rawProxies, hasProxies := typed["proxies"]
		if !hasProxies || rawProxies == nil {
			if _, hasProviders := typed["proxy-providers"]; hasProviders {
				return nil, true, ErrProvidersOnly
			}
			return nil, false, nil
		}
		list, ok := rawProxies.([]any)
		if !ok {
			return nil, true, ErrNoProxies
		}
		items = list
	case []any:
		if len(typed) == 0 {
			return nil, false, nil
		}
		if first, ok := typed[0].(map[string]any); !ok || first["type"] == nil {
			return nil, false, nil
		}
		items = typed
	default:
		return nil, false, nil
	}

	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, true, nil
}

func looksLikeHTML(data []byte) bool {
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	lower := strings.ToLower(string(head))
	return strings.HasPrefix(lower, "<!doctype html") ||
		strings.HasPrefix(lower, "<html") ||
		strings.Contains(lower, "<head>") ||
		strings.Contains(lower, "<body")
}

func decodeBase64(data []byte) ([]byte, error) {
	compact := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, string(data))
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err := enc.DecodeString(compact); err == nil && utf8.Valid(decoded) {
			return bytes.TrimSpace(decoded), nil
		}
	}
	return nil, errors.New("not valid base64")
}

func normalizeYAMLValue(v any) any {
	switch typed := v.(type) {
	case map[string]any:
		for k, item := range typed {
			typed[k] = normalizeYAMLValue(item)
		}
		return typed
	case map[any]any:
		out := make(map[string]any, len(typed))
		for k, item := range typed {
			out[fmt.Sprint(k)] = normalizeYAMLValue(item)
		}
		return out
	case []any:
		for i, item := range typed {
			typed[i] = normalizeYAMLValue(item)
		}
		return typed
	default:
		return v
	}
}

func asString(v any) string {
	switch typed := v.(type) {
	case nil:
		return ""
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func asInt(v any) (int, bool) {
	switch typed := v.(type) {
	case nil:
		return 0, true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case uint64:
		return int(typed), true
	case float64:
		return int(typed), typed == float64(int(typed))
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, true
		}
		n, err := strconv.Atoi(trimmed)
		return n, err == nil
	default:
		return 0, false
	}
}

func truncateRunes(s string, limit int) string {
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	runes := []rune(s)
	return string(runes[:limit])
}
