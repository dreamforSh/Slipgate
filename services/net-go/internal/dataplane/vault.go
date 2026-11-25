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
	// Multi-protocol provider configuration (migrated from Wei-Shaw/sub2api).
	AccountMode   string            `json:"accountMode,omitempty"`
	APIProtocol   string            `json:"apiProtocol,omitempty"`
	APIBaseURLs   map[string]string `json:"apiBaseUrls,omitempty"`
	ProtocolRules []ProtocolRule    `json:"protocolRules,omitempty"`
	// AWS Bedrock credentials & region.
	AWSAccessKeyID     string `json:"awsAccessKeyId,omitempty"`
	AWSSecretAccessKey string `json:"awsSecretAccessKey,omitempty"`
	AWSSessionToken    string `json:"awsSessionToken,omitempty"`
	AWSRegion          string `json:"awsRegion,omitempty"`
	// GCP Vertex AI service account credentials & location.
	GCPClientEmail  string `json:"clientEmail,omitempty"`
	GCPPrivateKey   string `json:"privateKey,omitempty"`
	GCPPrivateKeyID string `json:"privateKeyId,omitempty"`
	GCPTokenURI     string `json:"tokenUri,omitempty"`
	GCPLocation     string `json:"location,omitempty"`
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
			// Multi-protocol provider fields (camelCase & snake_case).
			AccountMode      string            `json:"accountMode"`
			AltAccountMode   string            `json:"account_mode"`
			APIProtocol      string            `json:"apiProtocol"`
			AltAPIProtocol   string            `json:"api_protocol"`
			APIBaseURLs      map[string]string `json:"apiBaseUrls"`
			AltAPIBaseURLs   map[string]string `json:"api_base_urls"`
			ProtocolRules    []ProtocolRule    `json:"protocolRules"`
			AltProtocolRules []ProtocolRule    `json:"protocol_rules"`
			// AWS Bedrock / custom endpoint aliases.
			AltEndpoint          string `json:"endpoint"`
			AWSAccessKeyID       string `json:"awsAccessKeyId"`
			AltAWSAccessKeyID    string `json:"aws_access_key_id"`
			AccessKeyID          string `json:"accessKeyId"`
			AltAccessKeyID       string `json:"access_key_id"`
			AWSSecretAccessKey   string `json:"awsSecretAccessKey"`
			AltAWSSecretKey      string `json:"aws_secret_access_key"`
			SecretAccessKey      string `json:"secretAccessKey"`
			AltSecretAccessKey   string `json:"secret_access_key"`
			AWSSessionToken      string `json:"awsSessionToken"`
			AltAWSSessionToken   string `json:"aws_session_token"`
			SessionToken         string `json:"sessionToken"`
			AltSessionToken      string `json:"session_token"`
			AWSRegion            string `json:"awsRegion"`
			AltAWSRegion         string `json:"aws_region"`
			Region               string `json:"region"`
			// GCP Vertex AI Service Account fields.
			ClientEmail          string `json:"clientEmail"`
			AltClientEmail       string `json:"client_email"`
			PrivateKey           string `json:"privateKey"`
			AltPrivateKey        string `json:"private_key"`
			PrivateKeyID         string `json:"privateKeyId"`
			AltPrivateKeyID      string `json:"private_key_id"`
			TokenURI             string `json:"tokenUri"`
			AltTokenURI          string `json:"token_uri"`
			Location             string `json:"location"`
			GCPLocation          string `json:"gcpLocation"`
			AltGCPLocation       string `json:"gcp_location"`
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
			// Explicit tiers and Claude's rateLimitTier keep the generic mapping; ChatGPT plan_type
			// fields (auth.json / id_token) use the Codex SKU mapping ("pro" = Pro 200).
			tier := ""
			if rawTier := firstNonEmpty(
				envelope.SubscriptionTier, envelope.AltSubTier,
				envelope.PlanType, envelope.AltPlanType,
				claudeTier,
			); rawTier != "" {
				tier = NormalizeSubscriptionTier(rawTier)
			} else {
				tier = NormalizeChatGPTPlanTier(firstNonEmpty(codexPlan, jwtPlan))
			}
			chatgptAcc := firstNonEmpty(envelope.ChatGPTAccountID, envelope.AltChatGPTAccID, codexAcc, envelope.AccountID, envelope.AltAccountID, jwtAccID)
			proj := firstNonEmpty(envelope.ProjectID, envelope.AltProjectID, envelope.CompanionProject)
			org := firstNonEmpty(envelope.OrganizationID, envelope.AltOrgID)
			base := firstNonEmpty(envelope.BaseURL, envelope.AltBaseURL, envelope.AltEndpoint)
			prof := firstNonEmpty(envelope.UTLSProfileID, envelope.AltProfileID)
			accMode := strings.ToLower(firstNonEmpty(envelope.AccountMode, envelope.AltAccountMode))
			apiProto := strings.ToLower(firstNonEmpty(envelope.APIProtocol, envelope.AltAPIProtocol))
			apiBaseURLs := cloneHeaders(envelope.APIBaseURLs)
			if len(apiBaseURLs) == 0 {
				apiBaseURLs = cloneHeaders(envelope.AltAPIBaseURLs)
			}
			protoRules := cloneProtocolRules(envelope.ProtocolRules)
			if len(protoRules) == 0 {
				protoRules = cloneProtocolRules(envelope.AltProtocolRules)
			}
			awsKey := firstNonEmpty(envelope.AWSAccessKeyID, envelope.AltAWSAccessKeyID, envelope.AccessKeyID, envelope.AltAccessKeyID)
			awsSecret := firstNonEmpty(envelope.AWSSecretAccessKey, envelope.AltAWSSecretKey, envelope.SecretAccessKey, envelope.AltSecretAccessKey)
			awsSess := firstNonEmpty(envelope.AWSSessionToken, envelope.AltAWSSessionToken, envelope.SessionToken, envelope.AltSessionToken)
			awsRegion := firstNonEmpty(envelope.AWSRegion, envelope.AltAWSRegion, envelope.Region)
			gcpEmail := firstNonEmpty(envelope.ClientEmail, envelope.AltClientEmail)
			gcpPrivKey := firstNonEmpty(envelope.PrivateKey, envelope.AltPrivateKey)
			gcpKeyID := firstNonEmpty(envelope.PrivateKeyID, envelope.AltPrivateKeyID)
			gcpTokenURI := firstNonEmpty(envelope.TokenURI, envelope.AltTokenURI)
			gcpLoc := firstNonEmpty(envelope.Location, envelope.GCPLocation, envelope.AltGCPLocation, envelope.Region)
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
				AccountMode:      accMode,
				APIProtocol:      apiProto,
				APIBaseURLs:      apiBaseURLs,
				ProtocolRules:    protoRules,
				AWSAccessKeyID:     awsKey,
				AWSSecretAccessKey: awsSecret,
				AWSSessionToken:    awsSess,
				AWSRegion:          awsRegion,
				GCPClientEmail:     gcpEmail,
				GCPPrivateKey:      gcpPrivKey,
				GCPPrivateKeyID:    gcpKeyID,
				GCPTokenURI:        gcpTokenURI,
				GCPLocation:        gcpLoc,
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
	out.APIBaseURLs = cloneHeaders(sec.APIBaseURLs)
	out.ProtocolRules = cloneProtocolRules(sec.ProtocolRules)
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

// NormalizeSubscriptionTier canonicalizes upstream plan/rateLimitTier strings into Slipgate's tier taxonomy
// (SubscriptionTierSchema in @slipgate/contracts): Codex: free, go, plus (1x), pro_5x (5x), pro_10x (10x),
// pro_25x (25x), team, enterprise, edu; Claude: pro (1x), max (5x), ultra (20x), team, enterprise.
// ChatGPT plan_type values ("pro" = Pro 200, ...) go through NormalizeChatGPTPlanTier instead.
func NormalizeSubscriptionTier(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	switch s {
	case "standard", "free", "go", "plus", "pro", "pro_5x", "pro_10x", "pro_25x", "max", "ultra", "premium", "super", "team", "enterprise", "edu":
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

// NormalizeChatGPTPlanTier maps a ChatGPT plan_type (Codex id_token / auth.json) to a tier, matching
// normalizeChatGptPlan in @slipgate/contracts: prolite = Pro 100 (pro_5x), pro = Pro 200 (pro_10x),
// promax = Pro 500 (pro_25x); business / team plans are team, ent26 / CBP plans enterprise.
// Tier ids pass through; anything else returns "".
func NormalizeChatGPTPlanTier(raw string) string {
	key := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(strings.TrimSpace(raw)))
	switch key {
	case "":
		return ""
	case "free", "go", "plus", "team", "enterprise", "edu":
		return key
	case "prolite", "pro100", "pro5x":
		return "pro_5x"
	case "pro", "chatgptpro", "pro200", "pro10x":
		return "pro_10x"
	case "promax", "pro500", "pro25x":
		return "pro_25x"
	case "business", "selfservebusinessusagebased", "selfservebusinessprolite":
		return "team"
	case "ent26", "enterprisecbpusagebased", "enterprisecbpautomation":
		return "enterprise"
	case "eduplus", "edupro":
		return "edu"
	case "standard":
		return "standard"
	default:
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
	case "premium":
		return 4
	case "super":
		return 15
	case "ultra":
		// XPass (grok) Ultra is 50x Plus; Claude / Google Ultra is 20x.
		if strings.EqualFold(strings.TrimSpace(provider), "grok") {
			return 50
		}
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
