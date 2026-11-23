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
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
)

const (
	claudeOAuthClientID      = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeOAuthTokenURL      = "https://platform.claude.com/v1/oauth/token"
	codexOAuthClientID       = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexOAuthTokenURL       = "https://auth.openai.com/oauth/token"
	googleOAuthTokenURL      = "https://oauth2.googleapis.com/token"
	antigravityOAuthClientID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
	qwenOAuthTokenURL        = "https://chat.qwen.ai/api/v1/oauth2/token"
)

type inflightOAuthRefresh struct {
	done   chan struct{}
	secret AccountSecret
	err    error
}

type oauthRefreshDeduper struct {
	mu       sync.Mutex
	inflight map[string]*inflightOAuthRefresh
}

func (d *oauthRefreshDeduper) do(key string, fn func() (AccountSecret, error)) (AccountSecret, error) {
	d.mu.Lock()
	if d.inflight == nil {
		d.inflight = make(map[string]*inflightOAuthRefresh)
	}
	if cur, ok := d.inflight[key]; ok {
		d.mu.Unlock()
		<-cur.done
		return cur.secret, cur.err
	}
	call := &inflightOAuthRefresh{done: make(chan struct{})}
	d.inflight[key] = call
	d.mu.Unlock()

	call.secret, call.err = fn()

	d.mu.Lock()
	delete(d.inflight, key)
	close(call.done)
	d.mu.Unlock()
	return call.secret, call.err
}

// RefreshAccountOAuth renews an account's OAuth access_token via its refresh_token over the account's
// bound Clash exit + uTLS profile (fail-closed on stealth_http/vm_slot), updates the L1 Vault, and
// persists the rotated credential back to slipgate-bff.
func (c *Coordinator) RefreshAccountOAuth(ctx context.Context, accountID string, force bool) (AccountSecret, error) {
	return c.oauthRefresher.do(accountID, func() (AccountSecret, error) {
		cur, ok := c.vault.Get(accountID)
		if !ok {
			return AccountSecret{}, ErrAccountSecretNotFound
		}
		if strings.TrimSpace(cur.RefreshToken) == "" {
			return cur, errors.New("dataplane: account has no OAuth refresh token")
		}
		if !force && !cur.NeedsOAuthRefresh(time.Now()) {
			return cur, nil
		}

		meta, hasMeta := c.accountMetaFor(accountID)
		if !hasMeta {
			meta = accountMeta{Platform: "openai", ExecutionMode: "direct_api", AuthKind: "oauth"}
		}

		reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()

		req, err := c.buildOAuthRefreshRequest(reqCtx, meta.Platform, cur)
		if err != nil {
			return cur, err
		}

		resp, err := c.executeControlHTTPRequest(reqCtx, accountID, meta, cur, req)
		if err != nil {
			return cur, fmt.Errorf("oauth refresh transport failed: %w", err)
		}
		defer resp.Body.Close()

		raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
		if err != nil {
			return cur, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return cur, fmt.Errorf("oauth token endpoint HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}

		var tokResp struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			IDToken      string `json:"id_token"`
			ExpiresIn    int64  `json:"expires_in"`
			Scope        string `json:"scope"`
		}
		if err := json.Unmarshal(raw, &tokResp); err != nil {
			return cur, fmt.Errorf("decode oauth token response: %w", err)
		}
		if strings.TrimSpace(tokResp.AccessToken) == "" {
			return cur, errors.New("oauth refresh returned empty access_token")
		}

		updated := cur
		updated.APIKey = strings.TrimSpace(tokResp.AccessToken)
		if strings.TrimSpace(tokResp.RefreshToken) != "" {
			updated.RefreshToken = strings.TrimSpace(tokResp.RefreshToken)
		}
		if strings.TrimSpace(tokResp.Scope) != "" {
			updated.Scope = strings.TrimSpace(tokResp.Scope)
		}
		expiresSec := tokResp.ExpiresIn
		if expiresSec <= 0 {
			expiresSec = 3600
		}
		updated.ExpiresAtUnixMs = time.Now().Add(time.Duration(expiresSec) * time.Second).UnixMilli()

		if jwtExp, jwtEmail, jwtAcc, jwtPlan := parseJWTTokenHints(firstNonEmpty(tokResp.IDToken, updated.APIKey)); jwtExp > 0 || jwtEmail != "" || jwtAcc != "" || jwtPlan != "" {
			if tokResp.ExpiresIn <= 0 && jwtExp > 0 {
				updated.ExpiresAtUnixMs = jwtExp
			}
			if jwtEmail != "" {
				updated.Email = jwtEmail
			}
			if jwtAcc != "" {
				updated.ChatGPTAccountID = jwtAcc
			}
			if tier := NormalizeSubscriptionTier(jwtPlan); tier != "" {
				updated.SubscriptionTier = tier
			}
		}

		c.vault.Put(accountID, updated)
		c.persistRefreshedCredentialsBounded(accountID, updated)
		return updated, nil
	})
}

func (c *Coordinator) buildOAuthRefreshRequest(ctx context.Context, platform string, sec AccountSecret) (*http.Request, error) {
	overrideURL := ""
	if c.allowPrivateUpstreams && sec.Headers != nil {
		overrideURL = strings.TrimSpace(sec.Headers["x-oauth-token-url"])
	}
	prov := strings.ToLower(strings.TrimSpace(platform))

	switch prov {
	case "anthropic":
		targetURL := firstNonEmpty(overrideURL, claudeOAuthTokenURL)
		payload := map[string]any{
			"grant_type":    "refresh_token",
			"refresh_token": sec.RefreshToken,
			"client_id":     firstNonEmpty(sec.ClientID, claudeOAuthClientID),
		}
		if strings.TrimSpace(sec.Scope) != "" {
			payload["scope"] = strings.TrimSpace(sec.Scope)
		}
		raw, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", claudeCLIUserAgent)
		return req, nil

	case "codex", "openai":
		targetURL := firstNonEmpty(overrideURL, codexOAuthTokenURL)
		clientID := firstNonEmpty(sec.ClientID, codexOAuthClientID)
		if strings.TrimSpace(sec.ClientSecret) == "" {
			raw, _ := json.Marshal(map[string]string{
				"client_id":     clientID,
				"grant_type":    "refresh_token",
				"refresh_token": sec.RefreshToken,
			})
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(raw))
			if err != nil {
				return nil, err
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json")
			req.Header.Set("User-Agent", codexCLIUserAgent)
			return req, nil
		}
		form := url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {sec.RefreshToken},
			"client_id":     {clientID},
			"client_secret": {sec.ClientSecret},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(form.Encode()))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", codexCLIUserAgent)
		return req, nil

	case "antigravity", "gemini":
		targetURL := firstNonEmpty(overrideURL, googleOAuthTokenURL)
		defaultCID := antigravityOAuthClientID
		defaultCSec := strings.TrimSpace(os.Getenv("ANTIGRAVITY_OAUTH_CLIENT_SECRET"))
		if prov == "gemini" {
			if envID := strings.TrimSpace(os.Getenv("GEMINI_OAUTH_CLIENT_ID")); envID != "" {
				defaultCID = envID
			}
			if envSec := strings.TrimSpace(os.Getenv("GEMINI_OAUTH_CLIENT_SECRET")); envSec != "" {
				defaultCSec = envSec
			}
		}
		form := url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {sec.RefreshToken},
			"client_id":     {firstNonEmpty(sec.ClientID, defaultCID)},
		}
		if cs := firstNonEmpty(sec.ClientSecret, defaultCSec); cs != "" {
			form.Set("client_secret", cs)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(form.Encode()))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		if prov == "antigravity" {
			req.Header.Set("User-Agent", antigravityUserAgent)
		}
		return req, nil

	case "qwen":
		targetURL := firstNonEmpty(overrideURL, qwenOAuthTokenURL)
		form := url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {sec.RefreshToken},
		}
		if sec.ClientID != "" {
			form.Set("client_id", sec.ClientID)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(form.Encode()))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		return req, nil

	default:
		return nil, fmt.Errorf("dataplane: unsupported OAuth refresh provider %q", platform)
	}
}

func (c *Coordinator) executeControlHTTPRequest(
	ctx context.Context,
	accountID string,
	meta accountMeta,
	secret AccountSecret,
	req *http.Request,
) (*http.Response, error) {
	SanitizeOutboundHeaders(req.Header)
	switch meta.ExecutionMode {
	case "stealth_http", "vm_slot":
		if c.pool != nil {
			if _, err := c.pool.ResolveDialTarget(accountID); err != nil {
				return nil, fmt.Errorf("fail-closed egress guard (%s): %w", meta.ExecutionMode, err)
			}
		}
		if c.stealth == nil {
			return nil, errors.New("stealth uTLS dialer is not configured")
		}
		utlsProfileID := strings.TrimSpace(secret.UTLSProfileID)
		if utlsProfileID == "" && c.pool != nil {
			if binding, ok := c.pool.GetBinding(accountID); ok && strings.TrimSpace(binding.UTLSProfileID) != "" {
				utlsProfileID = strings.TrimSpace(binding.UTLSProfileID)
			}
		}
		if utlsProfileID == "" {
			utlsProfileID = stealth.DefaultProfileForProvider(meta.Platform, meta.AuthKind)
		}
		out, err := c.stealth.DoAccountRequest(ctx, accountID, utlsProfileID, req)
		if err != nil {
			return nil, err
		}
		return out.Response, nil

	default:
		if err := netguard.ValidateOutboundURL(req.URL.String(), c.allowPrivateUpstreams); err != nil {
			return nil, err
		}
		return c.directClient.Do(req)
	}
}

func (c *Coordinator) persistRefreshedCredentialsBounded(accountID string, sec AccountSecret) {
	if c.bffOrigin == "" || c.internalToken == "" {
		return
	}
	c.postInternalJSONBounded("/api/v1/internal/dataplane/accounts/"+url.PathEscape(accountID)+"/credentials", map[string]any{
		"credentialSecret": sec.SerializeCanonicalJSON(),
		"subscriptionTier": sec.SubscriptionTier,
		"expiresAtUnixMs":  sec.ExpiresAtUnixMs,
	})
}

func (c *Coordinator) persistAccountCooldownBounded(accountID string, durationMs uint64, reason string) {
	if c.bffOrigin == "" || c.internalToken == "" || durationMs == 0 {
		return
	}
	untilIso := time.Now().Add(time.Duration(durationMs) * time.Millisecond).UTC().Format(time.RFC3339)
	c.postInternalJSONBounded("/api/v1/internal/dataplane/accounts/"+url.PathEscape(accountID)+"/cooldown", map[string]any{
		"cooldownUntilIso": untilIso,
		"cooldownReason":   reason,
	})
}

// ProactiveRefreshSweep renews OAuth credentials approaching expiration across active accounts.
func (c *Coordinator) ProactiveRefreshSweep(ctx context.Context) {
	now := time.Now()
	secrets := c.vault.Snapshot()
	for accID, sec := range secrets {
		if ctx.Err() != nil {
			return
		}
		if !sec.NeedsOAuthRefresh(now) {
			continue
		}
		if _, err := c.RefreshAccountOAuth(ctx, accID, false); err != nil {
			c.logEvent("warn", fmt.Sprintf("proactive OAuth refresh failed: %v", err), "account_id", accID)
		}
	}
}
