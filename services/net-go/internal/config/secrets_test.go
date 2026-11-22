package config

import (
	"strings"
	"testing"
)

const strongSecret = "3f9a1c0d7e5b42a8916f0c3d2b7e8a41c5d6e7f8091a2b3c4d5e6f708192a3b4"

func TestWeakSecretReason(t *testing.T) {
	cases := []struct {
		name  string
		value string
		weak  bool
	}{
		{"empty", "", true},
		{"whitespace", "   ", true},
		{"dev jwt default", DevJWTSecret, true},
		{"dev vault default", DevVaultSecret, true},
		{"env example placeholder", "change-me-32-byte-jwt-secret", true},
		{"long placeholder", "CHANGE-ME-please-replace-this-with-something-long", true},
		{"changeme variant", "changeme0123456789abcdef0123456789abcdef", true},
		{"too short", "0123456789abcdef0123456789abcde", true},
		{"exactly 32 bytes", "0123456789abcdef0123456789abcdef", false},
		{"openssl hex", strongSecret, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := WeakSecretReason(tc.value)
			if tc.weak && reason == "" {
				t.Fatalf("expected %q to be rejected", tc.value)
			}
			if !tc.weak && reason != "" {
				t.Fatalf("expected %q to be accepted, got %q", tc.value, reason)
			}
		})
	}
}

func TestSecretProblemsNamesEachWeakSecret(t *testing.T) {
	problems := Config{JWTSecret: "", VaultSecret: DevVaultSecret}.SecretProblems()
	if len(problems) != 2 {
		t.Fatalf("expected 2 problems, got %v", problems)
	}
	if !strings.HasPrefix(problems[0], "SLIPGATE_JWT_SECRET ") || !strings.HasPrefix(problems[1], "SLIPGATE_VAULT_SECRET ") {
		t.Fatalf("problems should name the variables: %v", problems)
	}

	if got := (Config{JWTSecret: strongSecret, VaultSecret: strongSecret}).SecretProblems(); len(got) != 0 {
		t.Fatalf("strong secrets should pass, got %v", got)
	}
}

func TestLoadFromEnvReadsSecretSettings(t *testing.T) {
	t.Setenv("SLIPGATE_JWT_SECRET", "  "+strongSecret+"  ")
	t.Setenv("SLIPGATE_VAULT_SECRET", "")
	t.Setenv("SLIPGATE_ALLOW_INSECURE_SECRETS", "true")

	cfg := LoadFromEnv()
	if cfg.JWTSecret != strongSecret {
		t.Fatalf("JWTSecret not trimmed/loaded: %q", cfg.JWTSecret)
	}
	if cfg.VaultSecret != DevVaultSecret {
		t.Fatalf("unset vault secret should fall back to the dev default, got %q", cfg.VaultSecret)
	}
	if !cfg.AllowInsecureSecrets {
		t.Fatal("SLIPGATE_ALLOW_INSECURE_SECRETS=true not honored")
	}
}
