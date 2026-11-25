package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Privacy modes recorded on an upstream account after the admin "set privacy" action.
const (
	// ChatGPT / Codex OAuth: "Improve the model for everyone" (training_allowed) switched off.
	PrivacyModeTrainingOff       = "training_off"
	PrivacyModeTrainingFailed    = "training_set_failed"
	PrivacyModeTrainingCFBlocked = "training_set_cf_blocked"
	// Antigravity OAuth: user settings cleared (telemetry and marketing emails off) and verified.
	PrivacyModePrivacySet    = "privacy_set"
	PrivacyModePrivacyFailed = "privacy_set_failed"
)

const (
	chatGPTAccountUserSettingURL = "https://chatgpt.com/backend-api/settings/account_user_setting"
	// The privacy calls go to the daily Cloud Code endpoint, which is what the Antigravity app uses.
	antigravityPrivacyBaseURL = "https://daily-cloudcode-pa.googleapis.com"
	privacyRequestTimeout     = 20 * time.Second
	privacyMaxBodyBytes       = 64 * 1024
)

var (
	ErrPrivacyAccountNotSynced = errors.New("dataplane: account is not synchronized to the data plane yet")
	ErrPrivacyUnsupported      = errors.New("dataplane: privacy settings apply only to ChatGPT/Codex and Antigravity OAuth accounts outside VM slots")
)

// PrivacyResult is the outcome of one privacy action. Upstream refusals are a result (a *_failed /
// cf_blocked mode), not an error; errors mean the action could not be attempted.
type PrivacyResult struct {
	Mode    string `json:"mode"`
	Status  int    `json:"status,omitempty"`
	Message string `json:"message,omitempty"`
}

// PrivacyFlowFor names the privacy flow for a platform: "chatgpt", "antigravity", or "".
func PrivacyFlowFor(platform string) string {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "codex", "openai":
		return "chatgpt"
	case "antigravity":
		return "antigravity"
	}
	return ""
}

// SetAccountPrivacy turns off provider-side data sharing for one OAuth account, sending the
// requests over the account's own egress (bound Clash exit + uTLS profile for stealth_http, fail-closed;
// direct for direct_api):
//   - ChatGPT / Codex: PATCH account_user_setting feature=training_allowed value=false.
//   - Antigravity: setUserSettings with empty settings, then fetchUserInfo to verify that telemetry is gone.
func (c *Coordinator) SetAccountPrivacy(ctx context.Context, accountID string) (PrivacyResult, error) {
	meta, ok := c.accountMetaFor(accountID)
	if !ok {
		return PrivacyResult{}, ErrPrivacyAccountNotSynced
	}
	flow := PrivacyFlowFor(meta.Platform)
	if flow == "" || meta.ExecutionMode == "vm_slot" || meta.AuthKind != "oauth" {
		return PrivacyResult{}, ErrPrivacyUnsupported
	}
	secret, ok := c.vault.Get(accountID)
	if !ok {
		return PrivacyResult{}, ErrAccountSecretNotFound
	}
	if secret.IsMock() {
		if flow == "chatgpt" {
			return PrivacyResult{Mode: PrivacyModeTrainingOff, Status: http.StatusOK, Message: "mock account"}, nil
		}
		return PrivacyResult{Mode: PrivacyModePrivacySet, Status: http.StatusOK, Message: "mock account"}, nil
	}
	// A stale access token would only earn a 401; renew it first when it is about to expire.
	if strings.TrimSpace(secret.RefreshToken) != "" && secret.NeedsOAuthRefresh(time.Now()) {
		if renewed, err := c.RefreshAccountOAuth(ctx, accountID, false); err == nil {
			secret = renewed
		}
	}
	failed := PrivacyModeTrainingFailed
	if flow == "antigravity" {
		failed = PrivacyModePrivacyFailed
	}
	if strings.TrimSpace(secret.APIKey) == "" {
		return PrivacyResult{Mode: failed, Message: "account has no OAuth access token"}, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, privacyRequestTimeout)
	defer cancel()
	if flow == "chatgpt" {
		return c.disableChatGPTTraining(reqCtx, accountID, meta, secret), nil
	}
	return c.setAntigravityPrivacy(reqCtx, accountID, meta, secret), nil
}

// privacyBaseOverride points both privacy flows at a local server (package tests only; it is
// honoured only when private upstreams are allowed).
func (c *Coordinator) privacyBaseOverride() string {
	if !c.allowPrivateUpstreams {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(c.privacyBaseURLForTest), "/")
}

func (c *Coordinator) disableChatGPTTraining(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret) PrivacyResult {
	target := chatGPTAccountUserSettingURL
	if base := c.privacyBaseOverride(); base != "" {
		target = base + "/backend-api/settings/account_user_setting"
	}
	q := url.Values{}
	q.Set("feature", "training_allowed")
	q.Set("value", "false")
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, target+"?"+q.Encode(), nil)
	if err != nil {
		return PrivacyResult{Mode: PrivacyModeTrainingFailed, Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(sec.APIKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://chatgpt.com")
	req.Header.Set("Referer", "https://chatgpt.com/")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	if acc := strings.TrimSpace(sec.ChatGPTAccountID); acc != "" {
		req.Header.Set("ChatGPT-Account-Id", acc)
	}

	resp, err := c.executeControlHTTPRequest(ctx, accountID, meta, sec, req)
	if err != nil {
		return PrivacyResult{Mode: PrivacyModeTrainingFailed, Message: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, privacyMaxBodyBytes))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return PrivacyResult{Mode: PrivacyModeTrainingOff, Status: resp.StatusCode}
	}
	if (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusServiceUnavailable) &&
		isCloudflareChallenge(resp.Header.Get("cf-mitigated"), string(body)) {
		return PrivacyResult{Mode: PrivacyModeTrainingCFBlocked, Status: resp.StatusCode, Message: "blocked by a Cloudflare challenge"}
	}
	return PrivacyResult{Mode: PrivacyModeTrainingFailed, Status: resp.StatusCode, Message: privacyErrorSnippet(resp.StatusCode, body)}
}

// isCloudflareChallenge reports whether a chatgpt.com refusal is a Cloudflare interstitial rather
// than an API answer.
func isCloudflareChallenge(cfMitigated, body string) bool {
	if strings.EqualFold(strings.TrimSpace(cfMitigated), "challenge") {
		return true
	}
	lower := strings.ToLower(body)
	for _, marker := range []string{"just a moment", "cf-chl", "challenge-platform", "cloudflare"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

type antigravityUserSettingsReply struct {
	UserSettings map[string]any `json:"userSettings"`
}

// stillShares reports whether the reply still carries the telemetry switch (privacy not applied).
func (r antigravityUserSettingsReply) stillShares() bool {
	_, has := r.UserSettings["telemetryEnabled"]
	return has
}

func (c *Coordinator) setAntigravityPrivacy(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret) PrivacyResult {
	base := antigravityPrivacyBaseURL
	if override := c.privacyBaseOverride(); override != "" {
		base = override
	}
	// 1. Clear the user settings (telemetry and marketing emails off).
	set, status, err := c.antigravityPrivacyCall(ctx, accountID, meta, sec, base+"/v1internal:setUserSettings", map[string]any{"user_settings": map[string]any{}})
	if err != nil {
		return PrivacyResult{Mode: PrivacyModePrivacyFailed, Status: status, Message: err.Error()}
	}
	if set.stillShares() {
		return PrivacyResult{Mode: PrivacyModePrivacyFailed, Status: status, Message: "setUserSettings kept telemetry enabled"}
	}
	// 2. Read them back for the account's project.
	project := strings.TrimSpace(sec.ProjectID)
	if project == "" {
		return PrivacyResult{Mode: PrivacyModePrivacyFailed, Status: status, Message: "account has no project id to verify against"}
	}
	info, status, err := c.antigravityPrivacyCall(ctx, accountID, meta, sec, base+"/v1internal:fetchUserInfo", map[string]any{"project": project})
	if err != nil {
		return PrivacyResult{Mode: PrivacyModePrivacyFailed, Status: status, Message: err.Error()}
	}
	if info.stillShares() {
		return PrivacyResult{Mode: PrivacyModePrivacyFailed, Status: status, Message: "fetchUserInfo still reports telemetry"}
	}
	return PrivacyResult{Mode: PrivacyModePrivacySet, Status: status}
}

func (c *Coordinator) antigravityPrivacyCall(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret, target string, payload any) (antigravityUserSettingsReply, int, error) {
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return antigravityUserSettingsReply{}, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(sec.APIKey))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", AntigravityCLIUserAgent(""))

	resp, err := c.executeControlHTTPRequest(ctx, accountID, meta, sec, req)
	if err != nil {
		return antigravityUserSettingsReply{}, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, privacyMaxBodyBytes))
	if resp.StatusCode != http.StatusOK {
		return antigravityUserSettingsReply{}, resp.StatusCode, errors.New(privacyErrorSnippet(resp.StatusCode, body))
	}
	var out antigravityUserSettingsReply
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &out); err != nil {
			return out, resp.StatusCode, fmt.Errorf("decode %s: %w", target[strings.LastIndex(target, ":")+1:], err)
		}
	}
	return out, resp.StatusCode, nil
}

func privacyErrorSnippet(status int, body []byte) string {
	text := strings.TrimSpace(string(body))
	if r := []rune(text); len(r) > 200 {
		text = string(r[:200]) + "…"
	}
	if text == "" {
		return fmt.Sprintf("upstream HTTP %d", status)
	}
	return fmt.Sprintf("upstream HTTP %d: %s", status, text)
}
