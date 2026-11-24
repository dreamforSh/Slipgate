package dataplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	APIProtocolAdaptive        = "adaptive"
	APIProtocolChatCompletions = "chat_completions"
	APIProtocolAnthropic       = "anthropic"
	APIProtocolResponses       = "responses"

	AccountModePayG   = "payg"
	AccountModeCoding = "coding"
	AccountModeGo     = "go"
	AccountModeZen    = "zen"

	openCodeSessionHeader     = "X-OpenCode-Session"
	openCodeUpstreamUserAgent = "opencode/1.0.0"

	DefaultOpenCodeGoTestModel  = "glm-5.3"
	DefaultCommandCodeTestModel = "deepseek/deepseek-v4-flash"
	DefaultClineTestModel       = "deepseek/deepseek-v4-flash"
	DefaultClinePassTestModel   = "cline-pass/glm-5.3-flash"
)

// ErrOpenCodeUnsupportedModel is returned synchronously when an OpenCode gateway request addresses
// gemini-* or jev-* models that require dedicated Google SDK or System One endpoints.
type ErrOpenCodeUnsupportedModel struct {
	Model string
}

func (e ErrOpenCodeUnsupportedModel) Error() string {
	return fmt.Sprintf("Model '%s' is not supported on OpenCode standard gateway (gemini models require Google SDK endpoint, jev models require System One endpoint)", e.Model)
}

// ProtocolRule maps a model name or suffix glob to one or more supported upstream native protocols.
type ProtocolRule struct {
	Pattern   string   `json:"pattern"`
	Protocol  string   `json:"protocol"`
	Protocols []string `json:"protocols,omitempty"`
}

// ProviderRouting selects whether an adaptive multi-protocol provider routes by inbound wire
// protocol (`by_inbound`) or by target model name (`by_model`).
type ProviderRouting string

const (
	ProviderRoutingByInbound ProviderRouting = "by_inbound"
	ProviderRoutingByModel   ProviderRouting = "by_model"
)

// ProviderEndpoints defines the default base URLs and optional built-in protocol rules for one mode.
type ProviderEndpoints struct {
	BaseURLs      map[string]string
	ProtocolRules []ProtocolRule
}

// ProviderProfile holds static routing configuration for a multi-protocol API-key provider.
type ProviderProfile struct {
	Platform      string
	DefaultMode   string
	Modes         map[string]ProviderEndpoints
	Routing       ProviderRouting
	ResponsesPath string
	ModelCatalog  bool
}

func (p *ProviderProfile) Endpoints(mode string) ProviderEndpoints {
	if p == nil {
		return ProviderEndpoints{}
	}
	if endpoints, ok := p.Modes[strings.ToLower(strings.TrimSpace(mode))]; ok {
		return endpoints
	}
	return p.Modes[p.DefaultMode]
}

func (p *ProviderProfile) DefaultBaseURL(mode, protocol string) string {
	return p.Endpoints(mode).BaseURLs[protocol]
}

func (p *ProviderProfile) SupportsProtocol(mode, protocol string) bool {
	return p.DefaultBaseURL(mode, protocol) != ""
}

// DefaultOpenCodeGoProtocolRules returns OpenCode Go's built-in model-to-protocol routing table.
func DefaultOpenCodeGoProtocolRules() []ProtocolRule {
	return []ProtocolRule{
		{Pattern: "grok-*", Protocol: APIProtocolResponses},
		{Pattern: "gpt-*", Protocol: APIProtocolResponses},
		{Pattern: "muse-spark-*", Protocol: APIProtocolResponses},
		{Pattern: "minimax-*", Protocol: APIProtocolAnthropic},
		{Pattern: "qwen*", Protocol: APIProtocolAnthropic},
	}
}

// DefaultOpenCodeZenProtocolRules returns OpenCode Zen's built-in model-to-protocol routing table.
func DefaultOpenCodeZenProtocolRules() []ProtocolRule {
	return []ProtocolRule{
		{Pattern: "grok-*", Protocol: APIProtocolResponses},
		{Pattern: "gpt-*", Protocol: APIProtocolResponses},
		{Pattern: "muse-spark-*", Protocol: APIProtocolResponses},
		{Pattern: "claude-*", Protocol: APIProtocolAnthropic},
		{Pattern: "qwen3.8-max", Protocol: APIProtocolChatCompletions},
		{Pattern: "qwen*", Protocol: APIProtocolAnthropic},
	}
}

// DefaultCommandCodeProtocolRules returns Command Code's built-in model-to-protocol routing table.
func DefaultCommandCodeProtocolRules() []ProtocolRule {
	return []ProtocolRule{
		{Pattern: "claude-*", Protocol: APIProtocolAnthropic},
		{Pattern: "gpt-*", Protocol: APIProtocolResponses, Protocols: []string{APIProtocolResponses, APIProtocolChatCompletions}},
	}
}

var providerProfiles = map[string]*ProviderProfile{
	"kimi": {
		Platform:    "kimi",
		DefaultMode: AccountModePayG,
		Routing:     ProviderRoutingByInbound,
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.moonshot.cn/v1",
					APIProtocolResponses:       "https://api.moonshot.cn/v1",
					APIProtocolAnthropic:       "https://api.moonshot.cn/anthropic",
				},
			},
			AccountModeCoding: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.kimi.com/coding/v1",
					APIProtocolResponses:       "https://api.kimi.com/coding/v1",
					APIProtocolAnthropic:       "https://api.kimi.com/coding",
				},
			},
		},
	},
	"glm": {
		Platform:    "glm",
		DefaultMode: AccountModePayG,
		Routing:     ProviderRoutingByInbound,
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://open.bigmodel.cn/api/paas/v4",
					APIProtocolAnthropic:       "https://open.bigmodel.cn/api/anthropic",
				},
			},
			AccountModeCoding: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://open.bigmodel.cn/api/coding/paas/v4",
					APIProtocolAnthropic:       "https://open.bigmodel.cn/api/anthropic",
				},
			},
		},
	},
	"deepseek": {
		Platform:      "deepseek",
		DefaultMode:   AccountModePayG,
		Routing:       ProviderRoutingByInbound,
		ResponsesPath: "/responses",
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.deepseek.com",
					APIProtocolResponses:       "https://api.deepseek.com",
					APIProtocolAnthropic:       "https://api.deepseek.com/anthropic",
				},
			},
		},
	},
	"minimax": {
		Platform:    "minimax",
		DefaultMode: AccountModePayG,
		Routing:     ProviderRoutingByInbound,
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.minimaxi.com/v1",
					APIProtocolResponses:       "https://api.minimaxi.com/v1",
					APIProtocolAnthropic:       "https://api.minimaxi.com/anthropic",
				},
			},
			AccountModeCoding: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.minimaxi.com/v1",
					APIProtocolResponses:       "https://api.minimaxi.com/v1",
					APIProtocolAnthropic:       "https://api.minimaxi.com/anthropic",
				},
			},
		},
	},
	"opencode_go": {
		Platform:    "opencode_go",
		DefaultMode: AccountModeGo,
		Routing:     ProviderRoutingByModel,
		Modes: map[string]ProviderEndpoints{
			AccountModeGo: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://opencode.ai/zen/go/v1",
					APIProtocolResponses:       "https://opencode.ai/zen/go/v1",
					APIProtocolAnthropic:       "https://opencode.ai/zen/go",
				},
				ProtocolRules: DefaultOpenCodeGoProtocolRules(),
			},
			AccountModeZen: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://opencode.ai/zen/v1",
					APIProtocolResponses:       "https://opencode.ai/zen/v1",
					APIProtocolAnthropic:       "https://opencode.ai/zen",
				},
				ProtocolRules: DefaultOpenCodeZenProtocolRules(),
			},
		},
	},
	"command_code": {
		Platform:     "command_code",
		DefaultMode:  AccountModePayG,
		Routing:      ProviderRoutingByModel,
		ModelCatalog: true,
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.commandcode.ai/provider/v1",
					APIProtocolResponses:       "https://api.commandcode.ai/provider/v1",
					APIProtocolAnthropic:       "https://api.commandcode.ai/provider",
				},
				ProtocolRules: DefaultCommandCodeProtocolRules(),
			},
		},
	},
	"cline": {
		Platform:    "cline",
		DefaultMode: AccountModePayG,
		Routing:     ProviderRoutingByInbound,
		Modes: map[string]ProviderEndpoints{
			AccountModePayG: {
				BaseURLs: map[string]string{
					APIProtocolChatCompletions: "https://api.cline.bot/api/v1",
				},
			},
		},
	},
}

// LookupProviderProfile returns the static multi-protocol profile for provider, or nil.
func LookupProviderProfile(provider string) *ProviderProfile {
	p := strings.ToLower(strings.TrimSpace(provider))
	if p == "zhipu" {
		p = "glm"
	}
	return providerProfiles[p]
}

// DefaultOpenCodeGoModelIDs lists OpenCode Go/Zen documented public catalog model IDs.
func DefaultOpenCodeGoModelIDs() []string {
	return []string{
		"grok-4.7",
		"grok-4.6",
		"gpt-5.6-luna",
		"glm-5.3-flash",
		"glm-5.3",
		"glm-5.2",
		"glm-5.1",
		"kimi-k3",
		"kimi-k2.7-code",
		"kimi-k2.6",
		"longcat-2.0",
		"deepseek-v4-pro",
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp",
		"mimo-v2.5",
		"mimo-v2.5-pro",
		"minimax-m3",
		"minimax-m2.7",
		"minimax-m2.5",
		"muse-spark-1.3-contributor",
		"muse-spark-1.2-contributor",
		"qwen3.8-max",
		"qwen3.8-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.6-plus",
		"hy4-preview",
		"hy3",
		"omen-alpha",
	}
}

func cloneProtocolRules(in []ProtocolRule) []ProtocolRule {
	if len(in) == 0 {
		return nil
	}
	out := make([]ProtocolRule, len(in))
	for i, r := range in {
		out[i] = ProtocolRule{
			Pattern:   r.Pattern,
			Protocol:  r.Protocol,
			Protocols: append([]string(nil), r.Protocols...),
		}
	}
	return out
}

func isNativeAPIProtocol(protocol string) bool {
	switch protocol {
	case APIProtocolChatCompletions, APIProtocolAnthropic, APIProtocolResponses:
		return true
	default:
		return false
	}
}

func inboundProtocolName(ingress CodecKind) string {
	switch ingress {
	case CodecAnthropicMessages, CodecAnthropicCountTokens:
		return APIProtocolAnthropic
	case CodecOpenAIResponses:
		return APIProtocolResponses
	default:
		return APIProtocolChatCompletions
	}
}

func codecForNativeProtocol(protocol string, ingress CodecKind) CodecKind {
	switch protocol {
	case APIProtocolAnthropic:
		if ingress == CodecAnthropicCountTokens {
			return CodecAnthropicCountTokens
		}
		return CodecAnthropicMessages
	case APIProtocolResponses:
		return CodecOpenAIResponses
	default:
		return CodecOpenAIChat
	}
}

// stripPlatformWrapperPrefix strips Slipgate's own disambiguation prefixes while preserving
// real upstream vendor prefixes (such as `anthropic/...`, `deepseek/...`, `cline-pass/...`).
func stripPlatformWrapperPrefix(provider, model string) string {
	trimmed := strings.TrimSpace(model)
	lower := strings.ToLower(trimmed)
	var prefixes []string
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "opencode_go":
		prefixes = []string{"opencode_go/", "opencode-go/", "opencode/"}
	case "command_code":
		prefixes = []string{"command_code/", "command-code/"}
	case "cline":
		prefixes = []string{"cline/"}
	case "typesafe":
		prefixes = []string{"typesafe/"}
	default:
		return trimmed
	}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) && len(trimmed) > len(p) {
			return strings.TrimSpace(trimmed[len(p):])
		}
	}
	return trimmed
}

// IsOpenCodeUnsupportedModel reports whether model uses dedicated non-gateway OpenCode endpoints
// (`gemini-*` -> Google SDK endpoint, `jev-*` -> System One endpoint).
func IsOpenCodeUnsupportedModel(model string) bool {
	normalized := strings.ToLower(stripPlatformWrapperPrefix("opencode_go", model))
	return strings.HasPrefix(normalized, "gemini-") || strings.HasPrefix(normalized, "jev-")
}

func normalizeProtocolSet(preferred string, protocols []string) []string {
	set := []string{preferred}
	for _, p := range protocols {
		p = strings.ToLower(strings.TrimSpace(p))
		if isNativeAPIProtocol(p) && !slices.Contains(set, p) {
			set = append(set, p)
		}
	}
	return set
}

func protocolRuleMatches(pattern, model string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	model = strings.ToLower(stripPlatformWrapperPrefix("opencode_go", model))
	if pattern == "" || model == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(model, strings.TrimSuffix(pattern, "*"))
	}
	return model == pattern
}

func matchProtocolRuleSet(model string, rules []ProtocolRule) ([]string, bool) {
	for _, r := range rules {
		pref := strings.ToLower(strings.TrimSpace(r.Protocol))
		if !isNativeAPIProtocol(pref) {
			continue
		}
		if protocolRuleMatches(r.Pattern, model) {
			return normalizeProtocolSet(pref, r.Protocols), true
		}
	}
	return nil, false
}

func pickFromProtocolSet(set []string, inbound string) string {
	if len(set) == 0 {
		return APIProtocolChatCompletions
	}
	if isNativeAPIProtocol(inbound) && slices.Contains(set, inbound) {
		return inbound
	}
	return set[0]
}

func effectiveAPIProtocolPref(profile *ProviderProfile, secret AccountSecret) string {
	pref := strings.ToLower(strings.TrimSpace(secret.APIProtocol))
	if pref == APIProtocolAdaptive || isNativeAPIProtocol(pref) {
		return pref
	}
	if profile.Routing == ProviderRoutingByModel {
		return APIProtocolAdaptive
	}
	// Preserve backward compatibility for legacy single-custom-URL relays configured via `baseUrl|apiKey`
	// without explicit api_protocol / api_base_urls: default those to chat_completions.
	if strings.TrimSpace(secret.BaseURL) != "" && len(secret.APIBaseURLs) == 0 {
		return APIProtocolChatCompletions
	}
	return APIProtocolAdaptive
}

func resolveMultiProtocolBaseURL(profile *ProviderProfile, secret AccountSecret, protocol string) string {
	for k, v := range secret.APIBaseURLs {
		if strings.EqualFold(strings.TrimSpace(k), protocol) && strings.TrimSpace(v) != "" {
			return strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	if custom := strings.TrimRight(strings.TrimSpace(secret.BaseURL), "/"); custom != "" {
		return custom
	}
	return profile.DefaultBaseURL(secret.AccountMode, protocol)
}

func resolveMultiProtocolRoute(
	provider string,
	secret AccountSecret,
	ingress CodecKind,
	upstreamModel string,
	catalogProtocols []string,
) (egress CodecKind, baseURL string, responsesPath string, effectiveModel string, matched bool) {
	profile := LookupProviderProfile(provider)
	if profile == nil {
		return "", "", "", upstreamModel, false
	}
	effectiveModel = stripPlatformWrapperPrefix(provider, upstreamModel)
	if ingress == CodecAnthropicCountTokens {
		// Still determine upstream protocol URL in case native count_tokens applies.
	}
	mode := strings.ToLower(strings.TrimSpace(secret.AccountMode))
	if _, ok := profile.Modes[mode]; !ok {
		mode = profile.DefaultMode
	}
	inbound := inboundProtocolName(ingress)
	pref := effectiveAPIProtocolPref(profile, secret)

	var targetProto string
	switch {
	case isNativeAPIProtocol(pref):
		targetProto = pref
	case profile.Routing == ProviderRoutingByModel:
		switch {
		case len(secret.ProtocolRules) > 0:
			if set, ok := matchProtocolRuleSet(effectiveModel, secret.ProtocolRules); ok {
				targetProto = pickFromProtocolSet(set, inbound)
			} else {
				targetProto = APIProtocolChatCompletions
			}
		case len(catalogProtocols) > 0:
			targetProto = pickFromProtocolSet(normalizeProtocolSet(catalogProtocols[0], catalogProtocols), inbound)
		default:
			if set, ok := matchProtocolRuleSet(effectiveModel, profile.Endpoints(mode).ProtocolRules); ok {
				targetProto = pickFromProtocolSet(set, inbound)
			} else {
				targetProto = APIProtocolChatCompletions
			}
		}
	default:
		if profile.SupportsProtocol(mode, inbound) || resolveExplicitAPIBaseURL(secret, inbound) != "" {
			targetProto = inbound
		} else {
			targetProto = APIProtocolChatCompletions
		}
	}

	egress = codecForNativeProtocol(targetProto, ingress)
	baseURL = resolveMultiProtocolBaseURL(profile, secret, targetProto)
	responsesPath = profile.ResponsesPath
	return egress, baseURL, responsesPath, effectiveModel, true
}

func resolveExplicitAPIBaseURL(secret AccountSecret, protocol string) string {
	for k, v := range secret.APIBaseURLs {
		if strings.EqualFold(strings.TrimSpace(k), protocol) {
			return strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	return ""
}

// joinResponsesPath appends the responses endpoint path to baseURL, respecting versioned suffixes
// (e.g. `.../v1`) and custom paths such as DeepSeek's `/responses`.
func joinResponsesPath(baseURL, responsesPath string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	path := strings.TrimSpace(responsesPath)
	if path == "" {
		path = "/v1/responses"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if strings.HasSuffix(base, "/responses") {
		return base
	}
	if strings.HasSuffix(base, path) {
		return base
	}
	if path == "/v1/responses" {
		if strings.HasSuffix(base, "/v1") || strings.HasSuffix(base, "/codex") {
			return base + "/responses"
		}
		return base + "/v1/responses"
	}
	return base + path
}

func isOfficialOpenCodeHost(targetURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "https") && strings.EqualFold(parsed.Hostname(), "opencode.ai")
}

func isOfficialCommandCodeHost(targetURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "https") && strings.EqualFold(parsed.Hostname(), "api.commandcode.ai")
}

func applyOpenCodeAndCommandCodeHeaders(
	req *http.Request,
	pctx OutboundPersonaContext,
	secret AccountSecret,
	targetURL string,
	turn *CanonicalTurn,
) {
	if req == nil {
		return
	}
	prov := strings.ToLower(strings.TrimSpace(pctx.Provider))
	switch {
	case isOfficialCommandCodeHost(targetURL):
		req.Header.Set("User-Agent", codexCLIUserAgent)
	case prov == "opencode_go", isOfficialOpenCodeHost(targetURL):
		req.Header.Set("User-Agent", openCodeUpstreamUserAgent)
	}

	isOpenCodeGoPlan := prov == "opencode_go" && !strings.EqualFold(strings.TrimSpace(secret.AccountMode), AccountModeZen)
	parsed, _ := url.Parse(strings.TrimSpace(targetURL))
	isOfficialGoPath := parsed != nil && strings.EqualFold(parsed.Scheme, "https") &&
		strings.EqualFold(parsed.Hostname(), "opencode.ai") && strings.Contains(parsed.Path, "/zen/go")
	if isOpenCodeGoPlan || isOfficialGoPath {
		if strings.TrimSpace(req.Header.Get(openCodeSessionHeader)) == "" {
			seed := strings.TrimSpace(pctx.AccountID) + "|" + firstNonEmpty(turn.SessionHint, pctx.RequestID, "default")
			req.Header.Set(openCodeSessionHeader, DeterministicUUID("slipgate-opencode-session", seed))
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Command Code supported_endpoints protocol catalog (migrated from sub2api)   */
/* -------------------------------------------------------------------------- */

const (
	modelProtocolCatalogTTL           = 30 * time.Minute
	modelProtocolCatalogRetryBackoff  = 5 * time.Minute
	modelProtocolCatalogTimeout       = 15 * time.Second
	modelProtocolCatalogFirstLoadWait = 2 * time.Second
	modelProtocolCatalogMaxBodyBytes  = 2 << 20
)

type modelProtocolCatalogEntry struct {
	models            map[string][]string
	fetchedAt         time.Time
	retryAt           time.Time
	refreshing        bool
	done              chan struct{}
	firstLoadDeadline time.Time
}

type modelProtocolCatalog struct {
	mu      sync.Mutex
	entries map[string]*modelProtocolCatalogEntry
}

func (c *modelProtocolCatalog) lookup(ctx context.Context, key, model string, now time.Time, refresh func()) []string {
	if c == nil || ctx.Err() != nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*modelProtocolCatalogEntry)
	}
	entry := c.entries[key]
	if entry == nil {
		entry = &modelProtocolCatalogEntry{}
		c.entries[key] = entry
	}
	stale := entry.models == nil || now.Sub(entry.fetchedAt) >= modelProtocolCatalogTTL
	if stale && !entry.refreshing && !now.Before(entry.retryAt) && refresh != nil {
		entry.refreshing = true
		entry.done = make(chan struct{})
		if entry.models == nil {
			entry.firstLoadDeadline = now.Add(modelProtocolCatalogFirstLoadWait)
		}
		go refresh()
	}
	if entry.models == nil && entry.refreshing && now.Before(entry.firstLoadDeadline) {
		done := entry.done
		deadline := entry.firstLoadDeadline
		c.mu.Unlock()
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-done:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
		c.mu.Lock()
	}
	if entry.models == nil || ctx.Err() != nil {
		return nil
	}
	return entry.models[strings.ToLower(strings.TrimSpace(model))]
}

func (c *modelProtocolCatalog) store(key string, models map[string][]string, err error, now time.Time) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*modelProtocolCatalogEntry)
	}
	entry := c.entries[key]
	if entry == nil {
		entry = &modelProtocolCatalogEntry{}
		c.entries[key] = entry
	}
	entry.refreshing = false
	if entry.done != nil {
		close(entry.done)
		entry.done = nil
	}
	if err != nil {
		entry.retryAt = now.Add(modelProtocolCatalogRetryBackoff)
		return
	}
	entry.models = models
	entry.fetchedAt = now
	entry.retryAt = time.Time{}
}

func modelEndpointToProtocol(endpoint string) string {
	normalized := strings.ToLower(strings.TrimRight(strings.TrimSpace(endpoint), "/"))
	switch {
	case normalized == "/chat/completions", strings.HasSuffix(normalized, "/chat/completions"):
		return APIProtocolChatCompletions
	case normalized == "/responses", strings.HasSuffix(normalized, "/responses"):
		return APIProtocolResponses
	case normalized == "/messages", strings.HasSuffix(normalized, "/messages"):
		return APIProtocolAnthropic
	default:
		return ""
	}
}

func parseModelProtocolCatalog(body []byte) (map[string][]string, error) {
	var parsed struct {
		Data []struct {
			ID                 string   `json:"id"`
			SupportedEndpoints []string `json:"supported_endpoints"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	models := make(map[string][]string)
	for _, item := range parsed.Data {
		id := strings.ToLower(strings.TrimSpace(item.ID))
		if id == "" {
			continue
		}
		var protocols []string
		for _, ep := range item.SupportedEndpoints {
			if p := modelEndpointToProtocol(ep); p != "" && !slices.Contains(protocols, p) {
				protocols = append(protocols, p)
			}
		}
		if len(protocols) > 0 {
			models[id] = protocols
		}
	}
	if len(models) == 0 {
		return nil, errors.New("model list has no supported_endpoints")
	}
	return models, nil
}

func (c *Coordinator) lookupCommandCodeModelProtocols(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	model string,
) []string {
	if c == nil || secret.IsMock() || strings.TrimSpace(model) == "" {
		return nil
	}
	profile := LookupProviderProfile(meta.Platform)
	if profile == nil || !profile.ModelCatalog {
		return nil
	}
	if effectiveAPIProtocolPref(profile, secret) != APIProtocolAdaptive {
		return nil
	}
	base := resolveMultiProtocolBaseURL(profile, secret, APIProtocolChatCompletions)
	if base == "" {
		return nil
	}
	modelsURL := joinProviderPath(base, "/v1/models")
	key := modelsURL + "#account=" + accountID
	effModel := stripPlatformWrapperPrefix(meta.Platform, model)
	return c.protocolCatalog.lookup(ctx, key, effModel, time.Now(), func() {
		fetchCtx, cancel := context.WithTimeout(context.Background(), modelProtocolCatalogTimeout)
		defer cancel()
		models, err := c.fetchCommandCodeModelProtocols(fetchCtx, modelsURL, accountID, meta, secret)
		c.protocolCatalog.store(key, models, err, time.Now())
	})
}

func (c *Coordinator) fetchCommandCodeModelProtocols(
	ctx context.Context,
	modelsURL string,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
) (map[string][]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if strings.TrimSpace(secret.APIKey) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(secret.APIKey))
	}
	applyOpenCodeAndCommandCodeHeaders(req, OutboundPersonaContext{
		Provider:  meta.Platform,
		AuthKind:  meta.AuthKind,
		AccountID: accountID,
	}, secret, modelsURL, &CanonicalTurn{})
	for k, v := range secret.Headers {
		if strings.TrimSpace(k) != "" && !strings.EqualFold(k, "x-oauth-token-url") {
			req.Header.Set(k, v)
		}
	}
	resp, err := c.executeControlHTTPRequest(ctx, accountID, meta, secret, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("model list returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, modelProtocolCatalogMaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > modelProtocolCatalogMaxBodyBytes {
		return nil, fmt.Errorf("model list exceeds %d bytes", modelProtocolCatalogMaxBodyBytes)
	}
	return parseModelProtocolCatalog(raw)
}
