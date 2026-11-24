package dataplane

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"unicode/utf16"

	"golang.org/x/mod/semver"
)

const (
	defaultClaudeCLIVersion     = "2.1.321"
	defaultCodexCLIVersion      = "0.146.0"
	minCodexCLIVersion          = "0.144.0"
	defaultAntigravityVersion   = "2.23.0"
	defaultGeminiCLIVersion     = "0.73.0"
	defaultQwenCLIVersion       = "0.28.3"
	defaultGrokCLIVersion       = "1.0.46"
	minGrokCLIVersion           = "1.0.13"
	defaultOpenCodeCLIVersion   = "1.0.0"
	defaultClineCLIVersion      = "3.17.0"
	claudeBillingSalt           = "59cf53e54c78"
	claudeStainlessPkgVersion   = "0.94.0"
	openaiJSUserAgent           = "OpenAI/JS 4.104.0"
	anthropicJSUserAgent        = "Anthropic/JS 0.94.0"
	typeSafeJSUserAgent         = "typesafe-js/1.0.0"
	bedrockJSUserAgent          = "aws-sdk-js/3.700.0"
	vertexJSUserAgent           = "google-api-nodejs-client/9.15.1"
	geminiGoogAPIClientHeader   = "gl-node/24.3.0"
	geminiCLIClientMetaHeader   = `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}`
	xaiCLIProxyHost             = "cli-chat-proxy.grok.com"
	xaiCLITokenAuth             = "xai-grok-cli"
	xaiCLIClientIdentifier      = "grok-pager"
	xaiCLIClientMode            = "interactive"
)

func resolveSemverMin(minVer, defaultVer string, envKeys ...string) string {
	for _, k := range envKeys {
		raw := strings.TrimSpace(os.Getenv(k))
		if raw == "" {
			continue
		}
		canon := "v" + raw
		if !semver.IsValid(canon) || semver.Canonical(canon) != canon ||
			semver.Prerelease(canon) != "" || semver.Build(canon) != "" {
			continue
		}
		if minVer != "" && semver.Compare(canon, "v"+minVer) < 0 {
			continue
		}
		return raw
	}
	return defaultVer
}

// CLIClaudeVersion returns the active official Claude Code CLI version (minimum 2.1.321).
func CLIClaudeVersion() string {
	return resolveSemverMin(defaultClaudeCLIVersion, defaultClaudeCLIVersion, "SLIPGATE_CLAUDE_CLI_VERSION", "SUB2API_CLAUDE_CLI_VERSION")
}

// CLICodexVersion returns the active official OpenAI Codex CLI version (minimum 0.144.0).
func CLICodexVersion() string {
	return resolveSemverMin(minCodexCLIVersion, defaultCodexCLIVersion, "SLIPGATE_CODEX_CLI_VERSION")
}

// CLIAntigravityVersion returns the active Antigravity IDE version.
func CLIAntigravityVersion() string {
	return resolveSemverMin("", defaultAntigravityVersion, "SLIPGATE_ANTIGRAVITY_VERSION", "ANTIGRAVITY_USER_AGENT_VERSION")
}

// CLIGeminiVersion returns the active official Gemini CLI version.
func CLIGeminiVersion() string {
	return resolveSemverMin("", defaultGeminiCLIVersion, "SLIPGATE_GEMINI_CLI_VERSION")
}

// CLIQwenVersion returns the active official Qwen Code CLI version.
func CLIQwenVersion() string {
	return resolveSemverMin("", defaultQwenCLIVersion, "SLIPGATE_QWEN_CLI_VERSION")
}

// CLIGrokVersion returns the active official xAI Grok CLI version (minimum 1.0.13).
func CLIGrokVersion() string {
	return resolveSemverMin(minGrokCLIVersion, defaultGrokCLIVersion, "SLIPGATE_GROK_CLI_VERSION", "XAI_GROK_CLI_VERSION")
}

// CLIOpenCodeVersion returns the active official OpenCode CLI version.
func CLIOpenCodeVersion() string {
	return resolveSemverMin("", defaultOpenCodeCLIVersion, "SLIPGATE_OPENCODE_CLI_VERSION")
}

// CLIClineVersion returns the active official Cline client version.
func CLIClineVersion() string {
	return resolveSemverMin("", defaultClineCLIVersion, "SLIPGATE_CLINE_CLI_VERSION")
}

// ClaudeCLIUserAgent formats the official Claude Code CLI User-Agent header.
func ClaudeCLIUserAgent(ver string) string {
	return "claude-cli/" + firstNonEmpty(ver, CLIClaudeVersion()) + " (external, cli)"
}

// CodexCLIUserAgent formats the official Rust Codex CLI User-Agent header.
func CodexCLIUserAgent(ver string) string {
	return "codex_cli_rs/" + firstNonEmpty(ver, CLICodexVersion()) + " (Ubuntu 22.4.0; x86_64) xterm-256color"
}

// AntigravityCLIUserAgent formats the official Antigravity IDE User-Agent header.
func AntigravityCLIUserAgent(ver string) string {
	return "antigravity/hub/" + firstNonEmpty(ver, CLIAntigravityVersion()) + " windows/amd64"
}

// GeminiCLIUserAgent formats the official @google/gemini-cli User-Agent header.
func GeminiCLIUserAgent(ver string) string {
	return "GeminiCLI/" + firstNonEmpty(ver, CLIGeminiVersion()) + " (linux; x64) google-api-nodejs-client/9.15.1"
}

// QwenCLIUserAgent formats the official Qwen Code CLI User-Agent / X-DashScope-UserAgent header.
func QwenCLIUserAgent(ver string) string {
	return "QwenCode/" + firstNonEmpty(ver, CLIQwenVersion()) + " (linux; x64)"
}

// GrokCLIUserAgent formats the official xAI Grok CLI User-Agent header.
func GrokCLIUserAgent(ver string) string {
	v := firstNonEmpty(ver, CLIGrokVersion())
	return "grok-pager/" + v + " grok-shell/" + v + " (linux; x86_64)"
}

// OpenCodeCLIUserAgent formats the official OpenCode CLI User-Agent header.
func OpenCodeCLIUserAgent(ver string) string {
	return "opencode/" + firstNonEmpty(ver, CLIOpenCodeVersion())
}

// ClineCLIUserAgent formats the official Cline client User-Agent header.
func ClineCLIUserAgent(ver string) string {
	return "Cline/" + firstNonEmpty(ver, CLIClineVersion())
}

// ComputeClaudeCodeFingerprint replicates Claude Code CLI's exact UTF-16 code-unit sampling at
// zero-based indices 4, 7, 20 (padded with '0') hashed with claudeBillingSalt and cliVersion.
func ComputeClaudeCodeFingerprint(firstUserText, cliVersion string) string {
	indices := [...]int{4, 7, 20}
	units := make([]uint16, 0, 22)
	for _, r := range firstUserText {
		units = utf16.AppendRune(units, r)
		if len(units) > indices[len(indices)-1] {
			break
		}
	}
	sampled := make([]uint16, 0, len(indices))
	for _, idx := range indices {
		if idx < len(units) {
			sampled = append(sampled, units[idx])
		} else {
			sampled = append(sampled, '0')
		}
	}
	sampleStr := string(utf16.Decode(sampled))
	sum := sha256.Sum256([]byte(claudeBillingSalt + sampleStr + cliVersion))
	return hex.EncodeToString(sum[:])[:3]
}

// BuildClaudeBillingHeader formats Claude Code CLI's system[0] billing attribution block.
func BuildClaudeBillingHeader(firstUserText, cliVersion string) string {
	v := firstNonEmpty(cliVersion, CLIClaudeVersion())
	return fmt.Sprintf("x-anthropic-billing-header: cc_version=%s.%s; cc_entrypoint=cli;", v, ComputeClaudeCodeFingerprint(firstUserText, v))
}

func firstUserMessageText(turn *CanonicalTurn) string {
	if turn == nil {
		return ""
	}
	for _, m := range turn.Messages {
		if m.Role != "user" {
			continue
		}
		for _, p := range m.Parts {
			if p.Type == partText && p.Text != "" {
				return p.Text
			}
		}
		if m.Content != "" {
			return m.Content
		}
		return ""
	}
	return ""
}

// ApplyCLIProviderHeaders stamps the canonical CLI or official JS SDK User-Agent and companion
// headers for every non-subscription / multi-protocol provider so upstream never sees Go-http-client.
func ApplyCLIProviderHeaders(
	req *http.Request,
	pctx OutboundPersonaContext,
	secret AccountSecret,
	targetURL string,
	egress CodecKind,
) {
	if req == nil {
		return
	}

	prov := strings.ToLower(strings.TrimSpace(pctx.Provider))
	ak := strings.ToLower(strings.TrimSpace(pctx.AuthKind))

	switch prov {
	case "gemini":
		req.Header.Set("User-Agent", GeminiCLIUserAgent(""))
		if req.Header.Get("X-Goog-Api-Client") == "" {
			req.Header.Set("X-Goog-Api-Client", geminiGoogAPIClientHeader)
		}
		if ak == "oauth" && req.Header.Get("Client-Metadata") == "" {
			req.Header.Set("Client-Metadata", geminiCLIClientMetaHeader)
		}

	case "qwen":
		ua := QwenCLIUserAgent("")
		req.Header.Set("User-Agent", ua)
		req.Header.Set("X-DashScope-UserAgent", ua)
		req.Header.Set("X-DashScope-CacheControl", "enable")
		if ak == "oauth" {
			req.Header.Set("X-DashScope-AuthType", "qwen-oauth")
		} else {
			req.Header.Set("X-DashScope-AuthType", "openai")
		}

	case "grok":
		ver := CLIGrokVersion()
		req.Header.Set("User-Agent", GrokCLIUserAgent(ver))
		req.Header.Set("x-grok-client-version", ver)
		req.Header.Set("x-grok-client-identifier", xaiCLIClientIdentifier)
		if isHostEqual(targetURL, xaiCLIProxyHost) {
			req.Header.Set("X-XAI-Token-Auth", xaiCLITokenAuth)
			req.Header.Set("x-grok-client-mode", xaiCLIClientMode)
			req.Header.Set("x-authenticateresponse", "authenticate-response")
		}

	case "cline":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", ClineCLIUserAgent(""))
		}
		if req.Header.Get("HTTP-Referer") == "" {
			req.Header.Set("HTTP-Referer", "https://cline.bot")
		}
		if req.Header.Get("X-Title") == "" {
			req.Header.Set("X-Title", "Cline")
		}

	case "command_code":
		req.Header.Set("User-Agent", CodexCLIUserAgent(""))

	case "opencode_go":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", OpenCodeCLIUserAgent(""))
		}

	case "anthropic":
		if !IsClaudeSubscription(pctx, secret) {
			if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
				req.Header.Set("User-Agent", anthropicJSUserAgent)
			}
			applyNodeAnthropicSDKHeaders(req)
		}

	case "bedrock":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", bedrockJSUserAgent)
		}

	case "vertex":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", vertexJSUserAgent)
		}
		if req.Header.Get("X-Goog-Api-Client") == "" {
			req.Header.Set("X-Goog-Api-Client", geminiGoogAPIClientHeader)
		}

	case "typesafe":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", typeSafeJSUserAgent)
		}

	case "codex":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", CodexCLIUserAgent(""))
		}

	case "antigravity":
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			req.Header.Set("User-Agent", AntigravityCLIUserAgent(""))
		}

	default:
		if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
			if egress == CodecAnthropicMessages || egress == CodecAnthropicCountTokens {
				req.Header.Set("User-Agent", anthropicJSUserAgent)
			} else {
				req.Header.Set("User-Agent", openaiJSUserAgent)
			}
		}
	}
}

func applyNodeAnthropicSDKHeaders(req *http.Request) {
	if req.Header.Get("X-Stainless-Lang") == "" {
		req.Header.Set("X-Stainless-Lang", "js")
	}
	if req.Header.Get("X-Stainless-Package-Version") == "" {
		req.Header.Set("X-Stainless-Package-Version", claudeStainlessPkgVersion)
	}
	if req.Header.Get("X-Stainless-OS") == "" {
		req.Header.Set("X-Stainless-OS", "Linux")
	}
	if req.Header.Get("X-Stainless-Arch") == "" {
		req.Header.Set("X-Stainless-Arch", "arm64")
	}
	if req.Header.Get("X-Stainless-Runtime") == "" {
		req.Header.Set("X-Stainless-Runtime", "node")
	}
	if req.Header.Get("X-Stainless-Runtime-Version") == "" {
		req.Header.Set("X-Stainless-Runtime-Version", "v24.3.0")
	}
	if req.Header.Get("X-Stainless-Retry-Count") == "" {
		req.Header.Set("X-Stainless-Retry-Count", "0")
	}
}

// ApplyOAuthRefreshCLIHeaders stamps the official CLI identity on OAuth token refresh calls.
// Note: Codex auth.openai.com requests carry User-Agent + originator without version (matches sub2api).
func ApplyOAuthRefreshCLIHeaders(req *http.Request, platform string) {
	if req == nil {
		return
	}
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "anthropic":
		req.Header.Set("User-Agent", ClaudeCLIUserAgent(""))
	case "codex", "openai":
		req.Header.Set("User-Agent", CodexCLIUserAgent(""))
		req.Header.Set("originator", "codex_cli_rs")
	case "antigravity":
		req.Header.Set("User-Agent", AntigravityCLIUserAgent(""))
	case "gemini":
		req.Header.Set("User-Agent", GeminiCLIUserAgent(""))
	case "qwen":
		ua := QwenCLIUserAgent("")
		req.Header.Set("User-Agent", ua)
		req.Header.Set("X-DashScope-UserAgent", ua)
	}
}

func isHostEqual(targetURL, wantHost string) bool {
	if targetURL == "" {
		return false
	}
	u, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), wantHost)
}
