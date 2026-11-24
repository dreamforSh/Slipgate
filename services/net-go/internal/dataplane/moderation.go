package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
)

// SyncModerationRuleInput mirrors ModerationRuleSchema synced from slipgate-bff.
type SyncModerationRuleInput struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Enabled        bool     `json:"enabled"`
	Kind           string   `json:"kind"` // "keyword" | "regex"
	Pattern        string   `json:"pattern"`
	CaseSensitive  bool     `json:"caseSensitive"`
	Action         string   `json:"action"` // "block" | "log_only" | "strike"
	ScopePlatforms []string `json:"scopePlatforms"`
	ScopeGroupIDs  []string `json:"scopeGroupIds"`
	RejectMessage  string   `json:"rejectMessage"`
	Priority       int      `json:"priority"`
}

// SyncModerationInput mirrors DataPlaneSyncModerationSchema synced from slipgate-bff.
type SyncModerationInput struct {
	Enabled              bool                      `json:"enabled"`
	ExternalEnabled      bool                      `json:"externalEnabled"`
	ExternalEndpoint     string                    `json:"externalEndpoint"`
	ExternalAPIKeyEncHex string                    `json:"externalApiKeyEncHex"`
	ExternalModel        string                    `json:"externalModel"`
	ExternalTimeoutMs    int                       `json:"externalTimeoutMs"`
	ExternalFailOpen     bool                      `json:"externalFailOpen"`
	Rules                []SyncModerationRuleInput `json:"rules"`
}

// ModerationEventPayload matches RecordModerationEventInputSchema posted to slipgate-bff.
type ModerationEventPayload struct {
	RequestID      string  `json:"requestId"`
	UserID         *string `json:"userId,omitempty"`
	APIKeyID       *string `json:"apiKeyId,omitempty"`
	GroupID        *string `json:"groupId,omitempty"`
	Platform       string  `json:"platform"`
	PublicModel    string  `json:"publicModel"`
	RuleID         *string `json:"ruleId,omitempty"`
	RuleName       string  `json:"ruleName"`
	Source         string  `json:"source"`
	Action         string  `json:"action"`
	MatchedExcerpt string  `json:"matchedExcerpt"`
}

type compiledModerationRule struct {
	rule          SyncModerationRuleInput
	keywords      []string
	keywordsLower []string
	re            *regexp.Regexp
	platforms     map[string]struct{}
	groupIDs      map[string]struct{}
}

type moderationVerdict struct {
	Source         string
	Action         string
	RuleID         string
	RuleName       string
	RejectMessage  string
	MatchedExcerpt string
}

type moderationGate struct {
	mu               sync.RWMutex
	enabled          bool
	externalEnabled  bool
	externalEndpoint string
	externalAPIKey   string
	externalModel    string
	externalTimeout  time.Duration
	externalFailOpen bool
	allowPrivate     bool
	rules            []compiledModerationRule
	httpClient       *http.Client
}

func (g *moderationGate) Apply(in *SyncModerationInput, vault *Vault, allowPrivate bool) {
	if in == nil {
		g.mu.Lock()
		g.enabled = false
		g.externalEnabled = false
		g.externalEndpoint = ""
		g.externalAPIKey = ""
		g.rules = nil
		g.allowPrivate = allowPrivate
		g.httpClient = nil
		g.mu.Unlock()
		return
	}

	sorted := append([]SyncModerationRuleInput(nil), in.Rules...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Priority < sorted[j].Priority
	})

	compiled := make([]compiledModerationRule, 0, len(sorted))
	for _, r := range sorted {
		if !r.Enabled {
			continue
		}
		if strings.TrimSpace(r.RejectMessage) == "" {
			r.RejectMessage = "Request blocked by content moderation policy"
		}
		entry := compiledModerationRule{rule: r}
		if len(r.ScopePlatforms) > 0 {
			entry.platforms = make(map[string]struct{}, len(r.ScopePlatforms))
			for _, p := range r.ScopePlatforms {
				if norm := strings.ToLower(strings.TrimSpace(p)); norm != "" {
					entry.platforms[norm] = struct{}{}
				}
			}
		}
		if len(r.ScopeGroupIDs) > 0 {
			entry.groupIDs = make(map[string]struct{}, len(r.ScopeGroupIDs))
			for _, gid := range r.ScopeGroupIDs {
				if norm := strings.TrimSpace(gid); norm != "" {
					entry.groupIDs[norm] = struct{}{}
				}
			}
		}

		if r.Kind == "keyword" {
			parts := strings.FieldsFunc(r.Pattern, func(ch rune) bool {
				return ch == ',' || ch == '\r' || ch == '\n'
			})
			for _, part := range parts {
				term := strings.TrimSpace(part)
				if term == "" {
					continue
				}
				entry.keywords = append(entry.keywords, term)
				entry.keywordsLower = append(entry.keywordsLower, strings.ToLower(term))
			}
			if len(entry.keywords) == 0 {
				continue
			}
		} else {
			pat := r.Pattern
			if !r.CaseSensitive {
				pat = "(?i)" + pat
			}
			re, err := regexp.Compile(pat)
			if err != nil {
				continue
			}
			entry.re = re
		}
		compiled = append(compiled, entry)
	}

	var apiKey string
	if encHex := strings.TrimSpace(in.ExternalAPIKeyEncHex); encHex != "" && vault != nil {
		if plain, err := vault.DecryptPlaintextHex(encHex); err == nil {
			apiKey = strings.TrimSpace(plain)
		}
	}

	timeoutMs := in.ExternalTimeoutMs
	if timeoutMs < 500 || timeoutMs > 15000 {
		timeoutMs = 3000
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	model := strings.TrimSpace(in.ExternalModel)
	if model == "" {
		model = "omni-moderation-latest"
	}

	var cli *http.Client
	endpoint := strings.TrimSpace(in.ExternalEndpoint)
	if in.ExternalEnabled && endpoint != "" {
		cli = netguard.NewSafeHTTPClient(timeout, allowPrivate)
	}

	g.mu.Lock()
	g.enabled = in.Enabled
	g.externalEnabled = in.ExternalEnabled
	g.externalEndpoint = endpoint
	g.externalAPIKey = apiKey
	g.externalModel = model
	g.externalTimeout = timeout
	g.externalFailOpen = in.ExternalFailOpen
	g.allowPrivate = allowPrivate
	g.rules = compiled
	g.httpClient = cli
	g.mu.Unlock()
}

func excerptWindow(text string, start int, length int) string {
	if start < 0 {
		start = 0
	}
	lo := start - 24
	if lo < 0 {
		lo = 0
	}
	hi := start + length + 24
	if hi > len(text) {
		hi = len(text)
	}
	s := strings.TrimSpace(text[lo:hi])
	if len(s) > 256 {
		return s[:253] + "..."
	}
	return s
}

func (g *moderationGate) Evaluate(ctx context.Context, text string, platform string, groupID string) *moderationVerdict {
	if strings.TrimSpace(text) == "" {
		return nil
	}

	g.mu.RLock()
	enabled := g.enabled
	rules := g.rules
	extEnabled := g.externalEnabled
	extEndpoint := g.externalEndpoint
	extKey := g.externalAPIKey
	extModel := g.externalModel
	extFailOpen := g.externalFailOpen
	extTimeout := g.externalTimeout
	allowPrivate := g.allowPrivate
	cli := g.httpClient
	g.mu.RUnlock()

	if !enabled {
		return nil
	}

	normPlatform := strings.ToLower(strings.TrimSpace(platform))
	normGroup := strings.TrimSpace(groupID)
	var textLower string

	for _, cr := range rules {
		if len(cr.platforms) > 0 {
			if _, ok := cr.platforms[normPlatform]; !ok {
				continue
			}
		}
		if len(cr.groupIDs) > 0 {
			if _, ok := cr.groupIDs[normGroup]; !ok {
				continue
			}
		}

		if cr.rule.Kind == "keyword" {
			if cr.rule.CaseSensitive {
				for _, kw := range cr.keywords {
					if idx := strings.Index(text, kw); idx != -1 {
						return &moderationVerdict{
							Source:         "local_rule",
							Action:         cr.rule.Action,
							RuleID:         cr.rule.ID,
							RuleName:       cr.rule.Name,
							RejectMessage:  cr.rule.RejectMessage,
							MatchedExcerpt: excerptWindow(text, idx, len(kw)),
						}
					}
				}
			} else {
				if textLower == "" {
					textLower = strings.ToLower(text)
				}
				for _, kwLower := range cr.keywordsLower {
					if idx := strings.Index(textLower, kwLower); idx != -1 {
						return &moderationVerdict{
							Source:         "local_rule",
							Action:         cr.rule.Action,
							RuleID:         cr.rule.ID,
							RuleName:       cr.rule.Name,
							RejectMessage:  cr.rule.RejectMessage,
							MatchedExcerpt: excerptWindow(text, idx, len(kwLower)),
						}
					}
				}
			}
		} else if cr.re != nil {
			if loc := cr.re.FindStringIndex(text); loc != nil {
				return &moderationVerdict{
					Source:         "local_rule",
					Action:         cr.rule.Action,
					RuleID:         cr.rule.ID,
					RuleName:       cr.rule.Name,
					RejectMessage:  cr.rule.RejectMessage,
					MatchedExcerpt: excerptWindow(text, loc[0], loc[1]-loc[0]),
				}
			}
		}
	}

	if !extEnabled || extEndpoint == "" {
		return nil
	}

	if err := netguard.ValidateOutboundURL(extEndpoint, allowPrivate); err != nil {
		if extFailOpen {
			return nil
		}
		return &moderationVerdict{
			Source:        "external_api",
			Action:        "block",
			RuleName:      "external_moderation",
			RejectMessage: "Content moderation check rejected restricted endpoint",
		}
	}

	if cli == nil {
		cli = netguard.NewSafeHTTPClient(extTimeout, allowPrivate)
	}
	sample := text
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	payload, _ := json.Marshal(map[string]any{
		"model": extModel,
		"input": sample,
	})
	reqCtx, cancel := context.WithTimeout(ctx, extTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, extEndpoint, bytes.NewReader(payload))
	if err != nil {
		if extFailOpen {
			return nil
		}
		return &moderationVerdict{
			Source:        "external_api",
			Action:        "block",
			RuleName:      "external_moderation",
			RejectMessage: "Content moderation service unavailable",
		}
	}
	req.Header.Set("Content-Type", "application/json")
	if extKey != "" {
		req.Header.Set("Authorization", "Bearer "+extKey)
	}

	resp, err := cli.Do(req)
	if err != nil {
		if extFailOpen {
			return nil
		}
		return &moderationVerdict{
			Source:        "external_api",
			Action:        "block",
			RuleName:      "external_moderation",
			RejectMessage: "Content moderation service unavailable",
		}
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if readErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if extFailOpen {
			return nil
		}
		return &moderationVerdict{
			Source:        "external_api",
			Action:        "block",
			RuleName:      "external_moderation",
			RejectMessage: "Content moderation service error",
		}
	}

	var parsed struct {
		Flagged bool `json:"flagged"`
		Blocked bool `json:"blocked"`
		Reason  string `json:"reason"`
		Results []struct {
			Flagged bool `json:"flagged"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		if extFailOpen {
			return nil
		}
		return &moderationVerdict{
			Source:        "external_api",
			Action:        "block",
			RuleName:      "external_moderation",
			RejectMessage: "Content moderation parse error",
		}
	}

	flagged := parsed.Flagged || parsed.Blocked || (len(parsed.Results) > 0 && parsed.Results[0].Flagged)
	if !flagged {
		return nil
	}
	msg := strings.TrimSpace(parsed.Reason)
	if msg == "" {
		msg = "Request blocked by external content moderation policy"
	}
	return &moderationVerdict{
		Source:         "external_api",
		Action:         "block",
		RuleName:       "external_moderation",
		RejectMessage:  msg,
		MatchedExcerpt: excerptWindow(sample, 0, min(len(sample), 64)),
	}
}
