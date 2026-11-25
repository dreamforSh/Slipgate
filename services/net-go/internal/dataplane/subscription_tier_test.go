package dataplane

import "testing"

func TestNormalizeChatGPTPlanTier(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"prolite":                         "pro_5x",
		"pro":                             "pro_10x",
		"ProMax":                          "pro_25x",
		"pro_25x":                         "pro_25x",
		"plus":                            "plus",
		"go":                              "go",
		"free":                            "free",
		"self_serve_business_usage_based": "team",
		"team":                            "team",
		"ent26":                           "enterprise",
		"enterprise_cbp_automation":       "enterprise",
		"edu_pro":                         "edu",
		"unknown":                         "",
		"":                                "",
	}
	for in, want := range cases {
		if got := NormalizeChatGPTPlanTier(in); got != want {
			t.Fatalf("NormalizeChatGPTPlanTier(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeSubscriptionTierKnowsNewTiers(t *testing.T) {
	t.Parallel()
	for _, tier := range []string{"free", "go", "team", "enterprise", "edu"} {
		if got := NormalizeSubscriptionTier(tier); got != tier {
			t.Fatalf("NormalizeSubscriptionTier(%q) = %q", tier, got)
		}
		if mult := SubscriptionTierMultiplier("codex", tier); mult != 1 {
			t.Fatalf("SubscriptionTierMultiplier(codex, %q) = %d, want 1", tier, mult)
		}
	}
	// XPass (grok) plans weigh 1x / 4x / 15x / 50x; Claude Ultra stays 20x.
	for tier, want := range map[string]uint16{"plus": 1, "premium": 4, "super": 15, "ultra": 50} {
		if got := SubscriptionTierMultiplier("grok", tier); got != want {
			t.Fatalf("SubscriptionTierMultiplier(grok, %q) = %d, want %d", tier, got, want)
		}
	}
	if got := SubscriptionTierMultiplier("anthropic", "ultra"); got != 20 {
		t.Fatalf("anthropic ultra = %d", got)
	}
	// Claude's own Pro stays "pro" through the generic mapping.
	if got := NormalizeSubscriptionTier("pro"); got != "pro" {
		t.Fatalf("generic pro = %q", got)
	}
}

func TestCodexAuthJSONPlanTypeUsesChatGPTSkus(t *testing.T) {
	t.Parallel()
	for plan, want := range map[string]string{"pro": "pro_10x", "prolite": "pro_5x", "promax": "pro_25x", "team": "team"} {
		raw := `{"tokens":{"access_token":"eyJ-codex","refresh_token":"rt","account_id":"acct_1","plan_type":"` + plan + `"}}`
		if got := ParseAccountSecret(raw).SubscriptionTier; got != want {
			t.Fatalf("auth.json plan_type %q -> %q, want %q", plan, got, want)
		}
	}
	// Claude credentials keep the generic mapping.
	claude := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-y","rateLimitTier":"default_claude_max_5x"}}`
	if got := ParseAccountSecret(claude).SubscriptionTier; got != "max" {
		t.Fatalf("claude rateLimitTier -> %q", got)
	}
}
