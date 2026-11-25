package dataplane

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// TempUnschedRule mirrors TempUnschedRuleSchema from @slipgate/contracts: an admin rule that puts
// an account into cooldown when an upstream error matches it. StatusCode 0 matches any HTTP error
// (>= 400); Keywords (any of them, case-insensitive) are searched in the error body, and an empty
// list lets the status alone decide.
type TempUnschedRule struct {
	StatusCode      int      `json:"statusCode"`
	Keywords        []string `json:"keywords"`
	DurationMinutes int      `json:"durationMinutes"`
	Description     string   `json:"description"`
}

// tempUnschedReasonPrefix marks cooldowns set by a rule (TEMP_UNSCHED_REASON_PREFIX in contracts).
const tempUnschedReasonPrefix = "temp_unsched:"

// tempUnschedMaxMinutes caps a rule's cooldown at one week, like the contract schema.
const tempUnschedMaxMinutes = 10080

// matchTempUnschedRule returns the first rule matching an upstream error response, if any.
func matchTempUnschedRule(rules []TempUnschedRule, status int, body []byte) (TempUnschedRule, bool) {
	if status < 400 || len(rules) == 0 {
		return TempUnschedRule{}, false
	}
	var lower string
	lowered := false
	for _, rule := range rules {
		if rule.DurationMinutes <= 0 {
			continue
		}
		if rule.StatusCode != 0 && rule.StatusCode != status {
			continue
		}
		if len(rule.Keywords) == 0 {
			return rule, true
		}
		if !lowered {
			lower = strings.ToLower(string(body))
			lowered = true
		}
		for _, kw := range rule.Keywords {
			kw = strings.ToLower(strings.TrimSpace(kw))
			if kw != "" && strings.Contains(lower, kw) {
				return rule, true
			}
		}
	}
	return TempUnschedRule{}, false
}

// cooldownMs is the rule's cooldown, clamped to [1 minute, 1 week].
func (r TempUnschedRule) cooldownMs() uint64 {
	minutes := min(max(r.DurationMinutes, 1), tempUnschedMaxMinutes)
	return uint64(minutes) * 60_000
}

// reason is the cooldown reason persisted to the BFF: the rule's description, else the status.
func (r TempUnschedRule) reason(status int) string {
	label := strings.TrimSpace(r.Description)
	if label == "" {
		label = fmt.Sprintf("upstream_http_%d", status)
	}
	return tempUnschedReasonPrefix + label
}

// prefixedBody replays bytes already read from a response body before the rest of it.
type prefixedBody struct {
	io.Reader
	io.Closer
}

// peekErrorBody reads up to limit bytes of an upstream error body for rule matching and puts them
// back, so error relays and failover reports still see the whole body.
func peekErrorBody(resp *http.Response, limit int64) []byte {
	if resp == nil || resp.Body == nil {
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	orig := resp.Body
	resp.Body = prefixedBody{Reader: io.MultiReader(bytes.NewReader(raw), orig), Closer: orig}
	return raw
}

// accountTempUnschedHit checks an account's rules against a pre-first-byte upstream error.
func (c *Coordinator) accountTempUnschedHit(accountID string, resp *http.Response) (TempUnschedRule, bool) {
	if resp == nil || resp.StatusCode < 400 {
		return TempUnschedRule{}, false
	}
	meta, ok := c.accountMetaFor(accountID)
	if !ok || len(meta.TempUnschedRules) == 0 {
		return TempUnschedRule{}, false
	}
	return matchTempUnschedRule(meta.TempUnschedRules, resp.StatusCode, peekErrorBody(resp, requestErrorMaxBodyLen))
}
