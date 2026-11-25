package dataplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"
)

// CLI fingerprint version following (like sub2api's Claude Code version sync): every hour the
// data plane reads the latest stable release of each impersonated client from its public registry
// and, when it is a newer patch/minor of the built-in pin, sends that version from then on. An env
// override still wins; the built-in pin is the floor. Set SLIPGATE_CLI_VERSION_SYNC=off to keep the pins.

const (
	cliVersionSyncInterval = time.Hour
	cliVersionSyncTimeout  = 20 * time.Second
	defaultNPMRegistryURL  = "https://registry.npmjs.org"
	defaultOpenVSXURL      = "https://open-vsx.org"
)

// cliTool is one impersonated client whose version can follow upstream releases.
type cliTool struct {
	Key     string
	Name    string
	NPM     string // npm package (dist-tags "latest")
	OpenVSX string // Open VSX extension "publisher/name"
	Pin     string // built-in version (and floor for synced values)
	EnvKeys []string
}

var cliTools = []cliTool{
	{Key: "claude", Name: "Claude Code", NPM: "@anthropic-ai/claude-code", Pin: defaultClaudeCLIVersion, EnvKeys: []string{"SLIPGATE_CLAUDE_CLI_VERSION", "SUB2API_CLAUDE_CLI_VERSION"}},
	{Key: "codex", Name: "Codex CLI", NPM: "@openai/codex", Pin: defaultCodexCLIVersion, EnvKeys: []string{"SLIPGATE_CODEX_CLI_VERSION"}},
	{Key: "gemini", Name: "Gemini CLI", NPM: "@google/gemini-cli", Pin: defaultGeminiCLIVersion, EnvKeys: []string{"SLIPGATE_GEMINI_CLI_VERSION"}},
	{Key: "qwen", Name: "Qwen Code", NPM: "@qwen-code/qwen-code", Pin: defaultQwenCLIVersion, EnvKeys: []string{"SLIPGATE_QWEN_CLI_VERSION"}},
	{Key: "grok", Name: "Grok CLI", NPM: "@xai-official/grok", Pin: defaultGrokCLIVersion, EnvKeys: []string{"SLIPGATE_GROK_CLI_VERSION", "XAI_GROK_CLI_VERSION"}},
	{Key: "opencode", Name: "OpenCode", NPM: "opencode-ai", Pin: defaultOpenCodeCLIVersion, EnvKeys: []string{"SLIPGATE_OPENCODE_CLI_VERSION"}},
	{Key: "cline", Name: "Cline", OpenVSX: "saoudrizwan/claude-dev", Pin: defaultClineCLIVersion, EnvKeys: []string{"SLIPGATE_CLINE_CLI_VERSION"}},
	{Key: "antigravity", Name: "Antigravity", Pin: defaultAntigravityVersion, EnvKeys: []string{"SLIPGATE_ANTIGRAVITY_VERSION", "ANTIGRAVITY_USER_AGENT_VERSION"}},
}

// syncedCLIVersions holds accepted upstream versions by tool key.
var syncedCLIVersions sync.Map

// syncedCLIVersion returns the synced version for a tool when it is still acceptable for `pin`.
func syncedCLIVersion(key, pin string) string {
	v, ok := syncedCLIVersions.Load(key)
	if !ok {
		return ""
	}
	s, _ := v.(string)
	if !acceptableSyncedVersion(s, pin) {
		return ""
	}
	return s
}

// acceptableSyncedVersion: strict release semver, not older than the pin, same major (a major bump
// may change the client's wire format, so it waits for a reviewed pin update).
func acceptableSyncedVersion(v, pin string) bool {
	canon := "v" + strings.TrimSpace(v)
	if !semver.IsValid(canon) || semver.Canonical(canon) != canon || semver.Prerelease(canon) != "" || semver.Build(canon) != "" {
		return false
	}
	pinCanon := "v" + pin
	return semver.Compare(canon, pinCanon) >= 0 && semver.Major(canon) == semver.Major(pinCanon)
}

// CLIVersionSyncEnabled reports whether automatic version following is on (default on).
func CLIVersionSyncEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SLIPGATE_CLI_VERSION_SYNC"))) {
	case "0", "false", "off", "no", "disabled":
		return false
	}
	return true
}

// CLIFingerprintTool is one row of the admin "CLI fingerprint" report.
type CLIFingerprintTool struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	Effective string `json:"effective"`
	Builtin   string `json:"builtin"`
	Synced    string `json:"synced,omitempty"`
	Latest    string `json:"latest,omitempty"`
	// Source of the effective version: env, synced or builtin.
	Source    string `json:"source"`
	UserAgent string `json:"userAgent"`
	Syncable  bool   `json:"syncable"`
	Error     string `json:"error,omitempty"`
}

// CLIFingerprintReport is what /internal/net/cli-fingerprint answers.
type CLIFingerprintReport struct {
	SyncEnabled  bool                 `json:"syncEnabled"`
	LastSyncAtMs int64                `json:"lastSyncAtUnixMs"`
	Tools        []CLIFingerprintTool `json:"tools"`
}

// CLIVersionSyncer polls the public registries. One process-wide instance is enough.
type CLIVersionSyncer struct {
	client      *http.Client
	npmBase     string
	openVSXBase string

	mu         sync.Mutex
	lastSyncAt time.Time
	latest     map[string]string
	errs       map[string]string
	started    bool
}

// NewCLIVersionSyncer builds a syncer against the public npm registry and Open VSX.
func NewCLIVersionSyncer() *CLIVersionSyncer {
	return &CLIVersionSyncer{
		client:      &http.Client{Timeout: cliVersionSyncTimeout},
		npmBase:     defaultNPMRegistryURL,
		openVSXBase: defaultOpenVSXURL,
		latest:      map[string]string{},
		errs:        map[string]string{},
	}
}

// DefaultCLIVersionSyncer is the process-wide syncer used by the ingress routes.
var DefaultCLIVersionSyncer = NewCLIVersionSyncer()

// Start syncs now and then hourly until ctx ends (no-op when disabled or already started).
func (s *CLIVersionSyncer) Start(ctx context.Context, logger *log.Logger) {
	s.mu.Lock()
	if s.started || !CLIVersionSyncEnabled() {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.mu.Unlock()
	go func() {
		ticker := time.NewTicker(cliVersionSyncInterval)
		defer ticker.Stop()
		for {
			report := s.SyncOnce(ctx)
			if logger != nil {
				for _, t := range report.Tools {
					if t.Error != "" {
						logger.Printf("cli version sync %s: %s", t.Key, t.Error)
					}
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

// SyncOnce reads every syncable tool's latest release and stores the acceptable ones.
func (s *CLIVersionSyncer) SyncOnce(ctx context.Context) CLIFingerprintReport {
	for _, tool := range cliTools {
		if tool.NPM == "" && tool.OpenVSX == "" {
			continue
		}
		latest, err := s.fetchLatest(ctx, tool)
		s.mu.Lock()
		if err != nil {
			s.errs[tool.Key] = err.Error()
		} else {
			delete(s.errs, tool.Key)
			s.latest[tool.Key] = latest
			if acceptableSyncedVersion(latest, tool.Pin) {
				syncedCLIVersions.Store(tool.Key, latest)
			}
		}
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.lastSyncAt = time.Now()
	s.mu.Unlock()
	return s.Report()
}

func (s *CLIVersionSyncer) fetchLatest(ctx context.Context, tool cliTool) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, cliVersionSyncTimeout)
	defer cancel()
	var target string
	if tool.NPM != "" {
		// Scoped names keep their "/" (the registry routes /-/package/@scope/name/dist-tags).
		target = strings.TrimRight(s.npmBase, "/") + "/-/package/" + tool.NPM + "/dist-tags"
	} else {
		target = strings.TrimRight(s.openVSXBase, "/") + "/api/" + tool.OpenVSX
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry HTTP %d", resp.StatusCode)
	}
	var body struct {
		Latest  string `json:"latest"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", fmt.Errorf("decode registry answer: %w", err)
	}
	v := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(body.Latest, body.Version)), "v")
	if v == "" {
		return "", errors.New("registry answer has no version")
	}
	return v, nil
}

// Report lists the effective version of every impersonated client and where it comes from.
func (s *CLIVersionSyncer) Report() CLIFingerprintReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := CLIFingerprintReport{SyncEnabled: CLIVersionSyncEnabled(), Tools: make([]CLIFingerprintTool, 0, len(cliTools))}
	if !s.lastSyncAt.IsZero() {
		out.LastSyncAtMs = s.lastSyncAt.UnixMilli()
	}
	for _, tool := range cliTools {
		effective := cliToolVersion(tool.Key)
		source := "builtin"
		synced := syncedCLIVersion(tool.Key, tool.Pin)
		if envVersionFor(tool) == effective && envVersionFor(tool) != "" {
			source = "env"
		} else if synced != "" && synced == effective && synced != tool.Pin {
			// A synced release equal to the pin changes nothing: report it as built-in.
			source = "synced"
		}
		out.Tools = append(out.Tools, CLIFingerprintTool{
			Key:       tool.Key,
			Name:      tool.Name,
			Effective: effective,
			Builtin:   tool.Pin,
			Synced:    synced,
			Latest:    s.latest[tool.Key],
			Source:    source,
			UserAgent: cliToolUserAgent(tool.Key),
			Syncable:  tool.NPM != "" || tool.OpenVSX != "",
			Error:     s.errs[tool.Key],
		})
	}
	return out
}

// envVersionFor returns the first set env override of a tool (validity is checked by the resolver).
func envVersionFor(tool cliTool) string {
	for _, k := range tool.EnvKeys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

func cliToolVersion(key string) string {
	switch key {
	case "claude":
		return CLIClaudeVersion()
	case "codex":
		return CLICodexVersion()
	case "gemini":
		return CLIGeminiVersion()
	case "qwen":
		return CLIQwenVersion()
	case "grok":
		return CLIGrokVersion()
	case "opencode":
		return CLIOpenCodeVersion()
	case "cline":
		return CLIClineVersion()
	case "antigravity":
		return CLIAntigravityVersion()
	}
	return ""
}

func cliToolUserAgent(key string) string {
	switch key {
	case "claude":
		return ClaudeCLIUserAgent("")
	case "codex":
		return CodexCLIUserAgent("")
	case "gemini":
		return GeminiCLIUserAgent("")
	case "qwen":
		return QwenCLIUserAgent("")
	case "grok":
		return GrokCLIUserAgent("")
	case "opencode":
		return OpenCodeCLIUserAgent("")
	case "cline":
		return ClineCLIUserAgent("")
	case "antigravity":
		return AntigravityCLIUserAgent("")
	}
	return ""
}
