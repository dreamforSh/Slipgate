package config

import (
	"fmt"
	"strings"
)

// MinSecretBytes is the shortest SLIPGATE_JWT_SECRET / SLIPGATE_VAULT_SECRET accepted at startup.
const MinSecretBytes = 32

// Built-in development fallbacks. They are public in the source tree, so a deployment that
// runs on them lets anyone mint admin JWTs or decrypt the credential vault.
const (
	DevJWTSecret   = "slipgate-dev-jwt-secret-change-in-prod"
	DevVaultSecret = "slipgate-dev-vault-secret-change-in-prod"
)

// WeakSecretReason explains why value must not be used as a production secret, or returns ""
// when it is acceptable. It mirrors services/bff-ts/src/security/secrets.ts.
func WeakSecretReason(value string) string {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	switch {
	case trimmed == "":
		return "not set"
	case trimmed == DevJWTSecret || trimmed == DevVaultSecret:
		return "is the public built-in development default"
	case strings.HasPrefix(lower, "change-me") || strings.HasPrefix(lower, "changeme") || strings.Contains(lower, "change-in-prod"):
		return "is still the .env.example placeholder"
	case len(trimmed) < MinSecretBytes:
		return fmt.Sprintf("is shorter than %d bytes", MinSecretBytes)
	}
	return ""
}

// SecretProblems lists every weak secret in cfg, e.g. "SLIPGATE_JWT_SECRET is not set".
// An empty result means both secrets are safe to run with.
func (c Config) SecretProblems() []string {
	var problems []string
	for _, item := range []struct{ name, value string }{
		{"SLIPGATE_JWT_SECRET", c.JWTSecret},
		{"SLIPGATE_VAULT_SECRET", c.VaultSecret},
	} {
		if reason := WeakSecretReason(item.value); reason != "" {
			problems = append(problems, item.name+" "+reason)
		}
	}
	return problems
}
