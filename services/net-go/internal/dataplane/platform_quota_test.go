package dataplane

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUserLimitGatePlatformQuotaChecksAndPrecheck(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{
		BlockedPlatforms: []SyncBlockedPlatformInput{
			{UserID: "u1", Platform: "anthropic", Window: "daily"},
			{UserID: "u2", Platform: "composite", Window: "monthly"},
		},
	}, clock)

	if !g.policy.limited() {
		t.Fatalf("expected policy to be limited when blockedPlatforms is populated")
	}

	if rej := g.checkPlatformQuota("u1", "anthropic"); rej == nil || rej.code != "platform_quota_exceeded" || rej.status != http.StatusTooManyRequests {
		t.Fatalf("expected platform_quota_exceeded for u1/anthropic, got %+v", rej)
	} else if !strings.Contains(rej.message, "daily") {
		t.Fatalf("expected error message to mention window 'daily', got %q", rej.message)
	}

	if rej := g.checkPlatformQuota("u1", "openai"); rej != nil {
		t.Fatalf("expected u1/openai to pass, got %+v", rej)
	}

	if rej := g.precheck("u1", "grp_anth", "anthropic"); rej == nil || rej.code != "platform_quota_exceeded" {
		t.Fatalf("expected precheck to block u1/anthropic, got %+v", rej)
	}
	if rej := g.precheck("u2", "grp_comp", "composite"); rej == nil || rej.code != "platform_quota_exceeded" {
		t.Fatalf("expected precheck to block u2/composite, got %+v", rej)
	}
}

func TestCoordinatorAdmitUserLimitsRejectsBlockedPlatformAndReleasesHold(t *testing.T) {
	coord := NewCoordinator(CoordinatorOptions{AllowPrivateUpstreams: true})
	coord.mu.Lock()
	coord.groupPlatforms["grp_comp"] = "composite"
	coord.mu.Unlock()

	coord.userLimits.apply(&SyncUserLimitsInput{
		BlockedPlatforms: []SyncBlockedPlatformInput{
			{UserID: "u1", Platform: "anthropic", Window: "weekly"},
		},
	})

	settled := 0
	rec := httptest.NewRecorder()
	release, admitted := coord.admitUserLimits(rec, CodecAnthropicMessages, &coreDispatchDirective{
		UserID:   "u1",
		GroupID:  "grp_comp",
		Provider: "anthropic",
	}, func(m RelayMetrics) coreSettleAck {
		settled++
		if m.UpstreamStatus != http.StatusTooManyRequests {
			t.Fatalf("expected 429 settle status, got %d", m.UpstreamStatus)
		}
		return coreSettleAck{}
	})
	defer release()

	if admitted {
		t.Fatalf("expected turn to be rejected when platform quota is blocked")
	}
	if settled != 1 {
		t.Fatalf("expected hold release settle to run once, got %d", settled)
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected HTTP 429, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "platform_quota_exceeded") {
		t.Fatalf("expected platform_quota_exceeded error payload, got %s", rec.Body.String())
	}
}
