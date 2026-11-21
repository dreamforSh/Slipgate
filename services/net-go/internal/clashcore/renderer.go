package clashcore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	proxyNamePrefix    = "sg-p-"
	listenerNamePrefix = "sg-l-"
	rejectTarget       = "REJECT"
)

// ProxyName returns the deterministic mihomo outbound name for nodeID.
func ProxyName(nodeID string) string {
	return proxyNamePrefix + nodeID
}

// ListenerName returns the deterministic mihomo mixed listener name for nodeID.
func ListenerName(nodeID string) string {
	return listenerNamePrefix + nodeID
}

// RenderNode describes one exit node slot to materialize inside mihomo.
type RenderNode struct {
	NodeID     string
	ListenPort int
	Username   string
	Password   string
	Active     bool
	Config     map[string]any
}

// RenderOptions tunes listener binding for RenderConfig.
type RenderOptions struct {
	ListenAddress string
}

// RenderedConfig holds the deterministic YAML bytes and SHA-256 hash applied to mihomo.
type RenderedConfig struct {
	Payload       []byte
	Hash          string
	Listeners     int
	ActiveProxies int
}

type mihomoUser struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

type mihomoListener struct {
	Name   string       `yaml:"name"`
	Type   string       `yaml:"type"`
	Listen string       `yaml:"listen"`
	Port   int          `yaml:"port"`
	Proxy  string       `yaml:"proxy"`
	UDP    bool         `yaml:"udp"`
	Users  []mihomoUser `yaml:"users,omitempty"`
}

type mihomoProfile struct {
	StoreSelected bool `yaml:"store-selected"`
	StoreFakeIP   bool `yaml:"store-fake-ip"`
}

type mihomoConfigDoc struct {
	Mode            string               `yaml:"mode"`
	LogLevel        string               `yaml:"log-level"`
	AllowLan        bool                 `yaml:"allow-lan"`
	IPv6            bool                 `yaml:"ipv6"`
	UnifiedDelay    bool                 `yaml:"unified-delay"`
	TCPConcurrent   bool                 `yaml:"tcp-concurrent"`
	GeoAutoUpdate   bool                 `yaml:"geo-auto-update"`
	FindProcessMode string               `yaml:"find-process-mode"`
	Profile         mihomoProfile        `yaml:"profile"`
	Proxies         []map[string]any     `yaml:"proxies"`
	ProxyGroups     []map[string]any     `yaml:"proxy-groups"`
	Listeners       []mihomoListener     `yaml:"listeners"`
	Rules           []string             `yaml:"rules"`
}

// RenderConfig produces a deterministic, fail-closed mihomo YAML configuration.
// Inactive/circuit-open nodes remain bound to REJECT and rules always end in MATCH,REJECT (zero DIRECT).
func RenderConfig(nodes []RenderNode, opts RenderOptions) (*RenderedConfig, error) {
	sorted := append([]RenderNode(nil), nodes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].NodeID < sorted[j].NodeID })

	listen := strings.TrimSpace(opts.ListenAddress)
	if listen == "" {
		listen = "127.0.0.1"
	}

	doc := mihomoConfigDoc{
		Mode:            "rule",
		LogLevel:        "silent",
		AllowLan:        false,
		IPv6:            true,
		UnifiedDelay:    true,
		TCPConcurrent:   true,
		GeoAutoUpdate:   false,
		FindProcessMode: "off",
		Proxies:         make([]map[string]any, 0, len(sorted)),
		ProxyGroups:     make([]map[string]any, 0),
		Listeners:       make([]mihomoListener, 0, len(sorted)),
		Rules:           []string{"MATCH," + rejectTarget},
	}

	seenPorts := make(map[int]string, len(sorted))
	activeCount := 0
	for _, n := range sorted {
		if n.ListenPort <= 0 || n.ListenPort > 65535 {
			return nil, fmt.Errorf("clashcore: node %s has invalid listener port %d", n.NodeID, n.ListenPort)
		}
		if other, dup := seenPorts[n.ListenPort]; dup {
			return nil, fmt.Errorf("clashcore: nodes %s and %s collide on port %d", other, n.NodeID, n.ListenPort)
		}
		seenPorts[n.ListenPort] = n.NodeID

		target := rejectTarget
		if len(n.Config) > 0 {
			cloned := cloneConfigMap(n.Config)
			cloned["name"] = ProxyName(n.NodeID)
			doc.Proxies = append(doc.Proxies, cloned)
			if n.Active {
				target = ProxyName(n.NodeID)
				activeCount++
			}
		}

		var users []mihomoUser
		if n.Username != "" {
			users = append(users, mihomoUser{Username: n.Username, Password: n.Password})
		}

		doc.Listeners = append(doc.Listeners, mihomoListener{
			Name:   ListenerName(n.NodeID),
			Type:   "mixed",
			Listen: listen,
			Port:   n.ListenPort,
			Proxy:  target,
			UDP:    false,
			Users:  users,
		})
	}

	payload, err := yaml.Marshal(&doc)
	if err != nil {
		return nil, fmt.Errorf("clashcore: marshal mihomo YAML: %w", err)
	}
	sum := sha256.Sum256(payload)
	return &RenderedConfig{
		Payload:       payload,
		Hash:          hex.EncodeToString(sum[:]),
		Listeners:     len(doc.Listeners),
		ActiveProxies: activeCount,
	}, nil
}

func cloneConfigMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	maps.Copy(out, in)
	return out
}
