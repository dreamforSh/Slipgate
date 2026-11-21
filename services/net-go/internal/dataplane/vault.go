package dataplane

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

var (
	ErrCiphertextTooShort = errors.New("dataplane: encrypted credential blob shorter than AES-GCM nonce+tag")
	ErrAccountSecretNotFound = errors.New("dataplane: upstream account secret not loaded in vault")
)

// AccountSecret holds decrypted runtime material for an upstream provider account (API key, Claude OAuth, Codex OAuth, or Antigravity Cloud Code).
type AccountSecret struct {
	APIKey           string            `json:"apiKey"`
	RefreshToken     string            `json:"refreshToken,omitempty"`
	ChatGPTAccountID string            `json:"chatgptAccountId,omitempty"`
	ProjectID        string            `json:"projectId,omitempty"`
	OrganizationID   string            `json:"organizationId,omitempty"`
	BaseURL          string            `json:"baseUrl"`
	UTLSProfileID    string            `json:"utlsProfileId"`
	Headers          map[string]string `json:"headers,omitempty"`
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

// DecryptHex decrypts hex([12-byte IV][AES-256-GCM ciphertext+tag]) and parses raw keys, `baseUrl|apiKey`, `mock://*`, or JSON credentials.
func (v *Vault) DecryptHex(encHex string) (AccountSecret, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(encHex))
	if err != nil {
		return AccountSecret{}, fmt.Errorf("dataplane: invalid credential hex: %w", err)
	}
	block, err := aes.NewCipher(v.key[:])
	if err != nil {
		return AccountSecret{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return AccountSecret{}, err
	}
	nonceSize := gcm.NonceSize()
	if len(raw) <= nonceSize+gcm.Overhead()-1 {
		return AccountSecret{}, ErrCiphertextTooShort
	}
	plain, err := gcm.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return AccountSecret{}, fmt.Errorf("dataplane: decrypt credential failed: %w", err)
	}
	return ParseAccountSecret(string(plain)), nil
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
			Headers          map[string]string `json:"headers"`
			// Direct support for pasted .claude/.credentials.json and .codex/auth.json structures.
			ClaudeAiOauth *struct {
				AccessToken  string `json:"accessToken"`
				RefreshToken string `json:"refreshToken"`
			} `json:"claudeAiOauth"`
			CodexOPENAIKey string `json:"OPENAI_API_KEY"`
			CodexTokens    *struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
				AccountID    string `json:"account_id"`
			} `json:"tokens"`
		}
		if err := json.Unmarshal([]byte(trimmed), &envelope); err == nil {
			var claudeTok, claudeRef string
			if envelope.ClaudeAiOauth != nil {
				claudeTok = envelope.ClaudeAiOauth.AccessToken
				claudeRef = envelope.ClaudeAiOauth.RefreshToken
			}
			var codexTok, codexRef, codexAcc string
			if envelope.CodexTokens != nil {
				codexTok = envelope.CodexTokens.AccessToken
				codexRef = envelope.CodexTokens.RefreshToken
				codexAcc = envelope.CodexTokens.AccountID
			}
			key := firstNonEmpty(
				envelope.APIKey, envelope.AltAPIKey,
				envelope.AccessToken, envelope.AltAccessToken,
				envelope.SetupToken, envelope.AltSetupToken,
				envelope.SessionKey, envelope.Token,
				claudeTok, codexTok, envelope.CodexOPENAIKey,
			)
			refresh := firstNonEmpty(envelope.RefreshToken, envelope.AltRefreshToken, claudeRef, codexRef)
			chatgptAcc := firstNonEmpty(envelope.ChatGPTAccountID, envelope.AltChatGPTAccID, codexAcc, envelope.AccountID, envelope.AltAccountID)
			proj := firstNonEmpty(envelope.ProjectID, envelope.AltProjectID, envelope.CompanionProject)
			org := firstNonEmpty(envelope.OrganizationID, envelope.AltOrgID)
			base := firstNonEmpty(envelope.BaseURL, envelope.AltBaseURL)
			prof := firstNonEmpty(envelope.UTLSProfileID, envelope.AltProfileID)
			return AccountSecret{
				APIKey:           key,
				RefreshToken:     refresh,
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
