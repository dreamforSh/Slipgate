package dataplane

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

var (
	ErrCiphertextTooShort = errors.New("dataplane: encrypted credential blob shorter than AES-GCM nonce+tag")
	ErrAccountSecretNotFound = errors.New("dataplane: upstream account secret not loaded in vault")
)

// AccountSecret holds decrypted runtime material for an upstream provider account (API key, Claude OAuth, Codex OAuth, or Antigravity Cloud Code).
type AccountSecret struct {
	APIKey           string            `json:"apiKey"`
	RefreshToken     string            `json:"refreshToken,omitempty"`
	ExpiresAtUnixMs  int64             `json:"expiresAtUnixMs,omitempty"`
	ClientID         string            `json:"clientId,omitempty"`
	ClientSecret     string            `json:"clientSecret,omitempty"`
	Scope            string            `json:"scope,omitempty"`
	Email            string            `json:"email,omitempty"`
	SubscriptionTier string            `json:"subscriptionTier,omitempty"`
	ChatGPTAccountID string            `json:"chatgptAccountId,omitempty"`
	ProjectID        string            `json:"projectId,omitempty"`
	OrganizationID   string            `json:"organizationId,omitempty"`
	BaseURL          string            `json:"baseUrl,omitempty"`
	UTLSProfileID    string            `json:"utlsProfileId,omitempty"`
	Headers          map[string]string `json:"headers,omitempty"`
}

// NeedsOAuthRefresh reports whether an OAuth credential has a refresh token and expires within 5 minutes.
func (s AccountSecret) NeedsOAuthRefresh(now time.Time) bool {
	if strings.TrimSpace(s.RefreshToken) == "" || s.ExpiresAtUnixMs <= 0 {
		return false
	}
	return now.UnixMilli() >= s.ExpiresAtUnixMs-5*60*1000
}

// SerializeCanonicalJSON encodes the AccountSecret into canonical JSON for encrypted BFF persistence.
func (s AccountSecret) SerializeCanonicalJSON() string {
	raw, err := json.Marshal(s)
	if err != nil {
		return s.APIKey
	}
	return string(raw)
}

// IsMock returns true when the account uses a deterministic local synthetic responder (`mock://ok`, `mock://echo`, etc.).
func (s AccountSecret) IsMock() bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.BaseURL)), "mock://") ||
		strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.APIKey)), "mock://")
}

// EffectiveMockTarget returns the normalized `mock://...` target string if IsMock() is true.
func (s AccountSecret) EffectiveMockTarget() string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.BaseURL)), "mock://") {
		return strings.TrimSpace(s.BaseURL)
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.APIKey)), "mock://") {
		return strings.TrimSpace(s.APIKey)
	}
	return ""
}

// Vault stores decrypted account credentials in L1 Go process memory, compatible with BFF's AES-256-GCM vault format.
type Vault struct {
	key [32]byte
	mu  sync.RWMutex
	m   map[string]AccountSecret
}

// NewVault initializes an in-memory credential vault keyed by SHA-256(vaultSecret).
func NewVault(vaultSecret string) *Vault {
	return &Vault{
		key: sha256.Sum256([]byte(vaultSecret)),
		m:   make(map[string]AccountSecret),
	}
}

// EncryptHex encrypts plaintext into hex([12-byte IV][AES-256-GCM ciphertext+tag]), byte-for-byte compatible with services/bff-ts/src/security/crypto.ts.
func (v *Vault) EncryptHex(plaintext string) (string, error) {
	block, err := aes.NewCipher(v.key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(sealed), nil
}

func (v *Vault) decryptRawHex(encHex string) ([]byte, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(encHex))
	if err != nil {
		return nil, fmt.Errorf("dataplane: invalid credential hex: %w", err)
	}
	block, err := aes.NewCipher(v.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonceSize := gcm.NonceSize()
	if len(raw) <= nonceSize+gcm.Overhead()-1 {
		return nil, ErrCiphertextTooShort
	}
	plain, err := gcm.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return nil, fmt.Errorf("dataplane: decrypt credential failed: %w", err)
	}
	return plain, nil
}

// DecryptHex decrypts hex([12-byte IV][AES-256-GCM ciphertext+tag]) and parses raw keys, `baseUrl|apiKey`, `mock://*`, or JSON credentials.
func (v *Vault) DecryptHex(encHex string) (AccountSecret, error) {
	plain, err := v.decryptRawHex(encHex)
	if err != nil {
		return AccountSecret{}, err
	}
	return ParseAccountSecret(string(plain)), nil
}

// DecryptPlaintextHex decrypts hex([12-byte IV][AES-256-GCM ciphertext+tag]) into raw plaintext.
func (v *Vault) DecryptPlaintextHex(encHex string) (string, error) {
	plain, err := v.decryptRawHex(encHex)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// ParseAccountSecret parses plaintext credential material into structured fields.
func ParseAccountSecret(raw string) AccountSecret {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return AccountSecret{}
	}

	if strings.HasPrefix(trimmed, "{") {
		var envelope struct {
			APIKey           string            `json:"apiKey"`
			AltAPIKey        string            `json:"api_key"`
			AccessToken      string            `json:"accessToken"`
			AltAccessToken   string            `json:"access_token"`
			SetupToken       string            `json:"setupToken"`
			AltSetupToken    string            `json:"setup_token"`
			SessionKey       string            `json:"sessionKey"`
			Token            string            `json:"token"`
			RefreshToken     string            `json:"refreshToken"`
			AltRefreshToken  string            `json:"refresh_token"`
			ChatGPTAccountID string            `json:"chatgptAccountId"`
			AltChatGPTAccID  string            `json:"chatgpt_account_id"`
			AccountID        string            `json:"accountId"`
			AltAccountID     string            `json:"account_id"`
			ProjectID        string            `json:"projectId"`
			AltProjectID     string            `json:"project_id"`
			CompanionProject string            `json:"cloudaicompanionProject"`
			OrganizationID   string            `json:"organizationId"`
			AltOrgID         string            `json:"organization_id"`
			BaseURL          string            `json:"baseUrl"`
			AltBaseURL       string            `json:"base_url"`
			UTLSProfileID    string            `json:"utlsProfileId"`
			AltProfileID     string            `json:"utls_profile_id"`
			SubscriptionTier string            `json:"subscriptionTier"`
			AltSubTier       string            `json:"subscription_tier"`
			PlanType         string            `json:"planType"`
			AltPlanType      string            `json:"plan_type"`
			ExpiresAtUnixMs    int64             `json:"expiresAtUnixMs"`
			AltExpiresAtUnixMs int64             `json:"expires_at_unix_ms"`
			AltExpiresAt       json.RawMessage   `json:"expiresAt"`
			AltExpiresAtSnk  json.RawMessage   `json:"expires_at"`
			AltExpiryDate    json.RawMessage   `json:"expiry_date"`
			ClientID         string            `json:"clientId"`
			AltClientID      string            `json:"client_id"`
			ClientSecret     string            `json:"clientSecret"`
			AltClientSecret  string            `json:"client_secret"`
			Scope            string            `json:"scope"`
			Email            string            `json:"email"`
			Headers          map[string]string `json:"headers"`
			// Direct support for pasted .claude/.credentials.json and .codex/auth.json structures.
			ClaudeAiOauth *struct {
				AccessToken      string          `json:"accessToken"`
				RefreshToken     string          `json:"refreshToken"`
				ExpiresAt        json.RawMessage `json:"expiresAt"`
				Scopes           []string        `json:"scopes"`
				SubscriptionType string          `json:"subscriptionType"`
				RateLimitTier    string          `json:"rateLimitTier"`
			} `json:"claudeAiOauth"`
			CodexOPENAIKey string `json:"OPENAI_API_KEY"`
			CodexTokens    *struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
				IDToken      string `json:"id_token"`
				AccountID    string `json:"account_id"`
				PlanType     string `json:"plan_type"`
			} `json:"tokens"`
		}
		if err := json.Unmarshal([]byte(trimmed), &envelope); err == nil {
			var claudeTok, claudeRef, claudeTier, claudeScope string
			var claudeExpMs int64
			if envelope.ClaudeAiOauth != nil {
				claudeTok = envelope.ClaudeAiOauth.AccessToken
				claudeRef = envelope.ClaudeAiOauth.RefreshToken
				claudeTier = firstNonEmpty(envelope.ClaudeAiOauth.RateLimitTier, envelope.ClaudeAiOauth.SubscriptionType)
				claudeExpMs = parseFlexibleExpiryMs(envelope.ClaudeAiOauth.ExpiresAt)
				if len(envelope.ClaudeAiOauth.Scopes) > 0 {
					claudeScope = strings.Join(envelope.ClaudeAiOauth.Scopes, " ")
				}
			}
			var codexTok, codexRef, codexAcc, codexPlan, codexIDTok string
			if envelope.CodexTokens != nil {
				codexTok = envelope.CodexTokens.AccessToken
				codexRef = envelope.CodexTokens.RefreshToken
				codexAcc = envelope.CodexTokens.AccountID
				codexPlan = envelope.CodexTokens.PlanType
				codexIDTok = envelope.CodexTokens.IDToken
			}
			key := firstNonEmpty(
				envelope.APIKey, envelope.AltAPIKey,
				envelope.AccessToken, envelope.AltAccessToken,
				envelope.SetupToken, envelope.AltSetupToken,
				envelope.SessionKey, envelope.Token,
				claudeTok, codexTok, envelope.CodexOPENAIKey,
			)
			refresh := firstNonEmpty(envelope.RefreshToken, envelope.AltRefreshToken, claudeRef, codexRef)
			jwtExpMs, jwtEmail, jwtAccID, jwtPlan := parseJWTTokenHints(firstNonEmpty(codexIDTok, key))
			tier := NormalizeSubscriptionTier(firstNonEmpty(
				envelope.SubscriptionTier, envelope.AltSubTier,
				envelope.PlanType, envelope.AltPlanType,
				claudeTier, codexPlan, jwtPlan,
			))
			chatgptAcc := firstNonEmpty(envelope.ChatGPTAccountID, envelope.AltChatGPTAccID, codexAcc, envelope.AccountID, envelope.AltAccountID, jwtAccID)
			proj := firstNonEmpty(envelope.ProjectID, envelope.AltProjectID, envelope.CompanionProject)
			org := firstNonEmpty(envelope.OrganizationID, envelope.AltOrgID)
			base := firstNonEmpty(envelope.BaseURL, envelope.AltBaseURL)
			prof := firstNonEmpty(envelope.UTLSProfileID, envelope.AltProfileID)
			expMs := envelope.ExpiresAtUnixMs
			if expMs <= 0 {
				expMs = envelope.AltExpiresAtUnixMs
			}
			if expMs <= 0 {
				expMs = parseFlexibleExpiryMs(envelope.AltExpiresAt)
			}
			if expMs <= 0 {
				expMs = parseFlexibleExpiryMs(envelope.AltExpiresAtSnk)
			}
			if expMs <= 0 {
				expMs = parseFlexibleExpiryMs(envelope.AltExpiryDate)
			}
			if expMs <= 0 {
				expMs = claudeExpMs
			}
			if expMs <= 0 && refresh != "" {
				expMs = jwtExpMs
			}
			return AccountSecret{
				APIKey:           key,
				RefreshToken:     refresh,
				ExpiresAtUnixMs:  expMs,
				ClientID:         firstNonEmpty(envelope.ClientID, envelope.AltClientID),
				ClientSecret:     firstNonEmpty(envelope.ClientSecret, envelope.AltClientSecret),
				Scope:            firstNonEmpty(envelope.Scope, claudeScope),
				Email:            firstNonEmpty(envelope.Email, jwtEmail),
				SubscriptionTier: tier,
				ChatGPTAccountID: chatgptAcc,
				ProjectID:        proj,
				OrganizationID:   org,
				BaseURL:          base,
				UTLSProfileID:    prof,
				Headers:          cloneHeaders(envelope.Headers),
			}
		}
	}

	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "mock://") {
		if idx := strings.IndexByte(trimmed, '|'); idx > 0 {
			return AccountSecret{
				BaseURL: strings.TrimSpace(trimmed[:idx]),
				APIKey:  strings.TrimSpace(trimmed[idx+1:]),
			}
		}
		return AccountSecret{
			BaseURL: trimmed,
			APIKey:  "mock-key",
		}
	}

	if idx := strings.IndexByte(trimmed, '|'); idx > 0 {
		left := strings.TrimSpace(trimmed[:idx])
		right := strings.TrimSpace(trimmed[idx+1:])
		leftLower := strings.ToLower(left)
		if strings.HasPrefix(leftLower, "http://") || strings.HasPrefix(leftLower, "https://") {
			return AccountSecret{
				BaseURL: left,
				APIKey:  right,
			}
		}
	}

	return AccountSecret{APIKey: trimmed}
}

// Put stores or overwrites a secret in memory.
func (v *Vault) Put(accountID string, secret AccountSecret) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.m[accountID] = cloneAccountSecret(secret)
}

// ReplaceAll atomically swaps the in-memory credential table during a full ControlPlane snapshot sync.
func (v *Vault) ReplaceAll(next map[string]AccountSecret) {
	copied := make(map[string]AccountSecret, len(next))
	for id, sec := range next {
		copied[id] = cloneAccountSecret(sec)
	}
	v.mu.Lock()
	v.m = copied
	v.mu.Unlock()
}

// Get retrieves the decrypted secret for accountID.
func (v *Vault) Get(accountID string) (AccountSecret, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	sec, ok := v.m[accountID]
	if !ok {
		return AccountSecret{}, false
	}
	return cloneAccountSecret(sec), true
}

func cloneAccountSecret(sec AccountSecret) AccountSecret {
	out := sec
	out.Headers = cloneHeaders(sec.Headers)
	return out
}

// Count returns the number of decrypted account secrets currently cached.
func (v *Vault) Count() int {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return len(v.m)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}

// NormalizeSubscriptionTier canonicalizes upstream plan/rateLimitTier strings into Slipgate's tier taxonomy:
// Codex: plus (1x), pro_5x (5x), pro_10x (10x), pro_25x (25x); Claude: pro (1x), max (5x), ultra (20x).
func NormalizeSubscriptionTier(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	switch s {
	case "standard", "plus", "pro", "pro_5x", "pro_10x", "pro_25x", "max", "ultra":
		return s
	case "default_claude_max_20x", "claude_max_20x", "max_20x", "20x", "claude_ultra":
		return "ultra"
	case "default_claude_max_5x", "claude_max_5x", "max_5x", "claude_max":
		return "max"
	case "5x", "codex_pro_5x", "pro5x", "pro-5x":
		return "pro_5x"
	case "10x", "codex_pro_10x", "pro10x", "pro-10x":
		return "pro_10x"
	case "25x", "codex_pro_25x", "pro25x", "pro-25x":
		return "pro_25x"
	default:
		if strings.Contains(s, "20x") || strings.Contains(s, "ultra") {
			return "ultra"
		}
		if strings.Contains(s, "25x") {
			return "pro_25x"
		}
		if strings.Contains(s, "10x") {
			return "pro_10x"
		}
		if strings.Contains(s, "claude") && strings.Contains(s, "5x") {
			return "max"
		}
		if strings.Contains(s, "5x") {
			return "pro_5x"
		}
		return ""
	}
}

// SubscriptionTierMultiplier returns the integer quota capacity weight for a (provider, tier) pair.
func SubscriptionTierMultiplier(provider, tier string) uint16 {
	switch NormalizeSubscriptionTier(tier) {
	case "pro_5x", "max":
		return 5
	case "pro_10x":
		return 10
	case "ultra":
		return 20
	case "pro_25x":
		return 25
	case "pro":
		if strings.EqualFold(strings.TrimSpace(provider), "antigravity") {
			return 5
		}
		return 1
	default:
		return 1
	}
}

// Snapshot returns a deep copy of all decrypted secrets currently cached in the vault.
func (v *Vault) Snapshot() map[string]AccountSecret {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := make(map[string]AccountSecret, len(v.m))
	for id, sec := range v.m {
		out[id] = cloneAccountSecret(sec)
	}
	return out
}

func parseFlexibleExpiryMs(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var num float64
	if err := json.Unmarshal(raw, &num); err == nil && num > 0 {
		if num < 1e11 {
			return int64(num * 1000)
		}
		return int64(num)
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		str = strings.TrimSpace(str)
		if t, perr := time.Parse(time.RFC3339, str); perr == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

func parseJWTTokenHints(tok string) (expMs int64, email, chatgptAccountID, planType string) {
	parts := strings.Split(strings.TrimSpace(tok), ".")
	if len(parts) != 3 {
		return 0, "", "", ""
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, "", "", ""
	}
	var claims struct {
		Exp        int64  `json:"exp"`
		Email      string `json:"email"`
		OpenAIAuth *struct {
			ChatGPTAccountID string `json:"chatgpt_account_id"`
			ChatGPTPlanType  string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(decoded, &claims) != nil {
		return 0, "", "", ""
	}
	if claims.Exp > 0 {
		expMs = claims.Exp * 1000
	}
	email = strings.TrimSpace(claims.Email)
	if claims.OpenAIAuth != nil {
		chatgptAccountID = strings.TrimSpace(claims.OpenAIAuth.ChatGPTAccountID)
		planType = strings.TrimSpace(claims.OpenAIAuth.ChatGPTPlanType)
	}
	return expMs, email, chatgptAccountID, planType
}

func cloneHeaders(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
