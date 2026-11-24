package dataplane

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

func u32(v uint32) *uint32 { return &v }

type fakeClock struct{ t time.Time }

func (f *fakeClock) now() time.Time { return f.t }

func newGate(in *SyncUserLimitsInput, clock *fakeClock) *userLimitGate {
	g := &userLimitGate{now: clock.now}
	g.apply(in)
	return g
}

func mustAdmit(t *testing.T, g *userLimitGate, user, group string) func() {
	t.Helper()
	release, rej := g.admit(user, group)
	if rej != nil {
		t.Fatalf("admit(%s,%s) refused: %s", user, group, rej.code)
	}
	return release
}

func mustRefuse(t *testing.T, g *userLimitGate, user, group, code string) {
	t.Helper()
	_, rej := g.admit(user, group)
	if rej == nil {
		t.Fatalf("admit(%s,%s) admitted, want %s", user, group, code)
	}
	if rej.code != code {
		t.Fatalf("admit(%s,%s) refused with %s, want %s", user, group, rej.code, code)
	}
	if rej.status != http.StatusTooManyRequests || rej.errType != "rate_limit_error" {
		t.Fatalf("unexpected rejection shape: %+v", rej)
	}
}

func TestUserLimitGateUserRPMAcrossGroupsAndMinuteRollover(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{Users: []SyncUserCapInput{{UserID: "u1", RPMLimit: u32(2)}}}, clock)
	mustAdmit(t, g, "u1", "g1")()
	mustAdmit(t, g, "u1", "g2")() // one bucket across groups
	mustRefuse(t, g, "u1", "g3", "user_rpm_exceeded")
	// Other users are unaffected (no default cap).
	for range 10 {
		mustAdmit(t, g, "u2", "g1")()
	}
	_, rej := g.admit("u1", "g1")
	if rej == nil || rej.retryAfterMs == 0 || rej.retryAfterMs > 60_000 {
		t.Fatalf("expected a retry-after within the minute, got %+v", rej)
	}
	clock.t = clock.t.Add(time.Minute)
	mustAdmit(t, g, "u1", "g1")()
}

func TestUserLimitGateDefaultsAndExplicitUnlimited(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{
		DefaultRPMLimit: 1,
		Users:           []SyncUserCapInput{{UserID: "vip", RPMLimit: u32(0)}, {UserID: "own-conc", ConcurrencyLimit: u32(5)}},
	}, clock)
	mustAdmit(t, g, "anyone", "g")()
	mustRefuse(t, g, "anyone", "g", "user_rpm_exceeded")
	// An explicit 0 is unlimited even with a default set.
	for range 5 {
		mustAdmit(t, g, "vip", "g")()
	}
	// A user with only a concurrency cap still inherits the default RPM.
	mustAdmit(t, g, "own-conc", "g")()
	mustRefuse(t, g, "own-conc", "g", "user_rpm_exceeded")
}

func TestUserLimitGateGroupRPMOverrideReplacesAndZeroExempts(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{
		Users:  []SyncUserCapInput{{UserID: "exempt", RPMLimit: u32(3)}},
		Groups: []SyncGroupCapInput{{GroupID: "g1", RPMLimit: 1}},
		Overrides: []SyncUserGroupOverrideInput{
			{UserID: "boosted", GroupID: "g1", RPMOverride: u32(3)},
			{UserID: "exempt", GroupID: "g1", RPMOverride: u32(0)},
			{UserID: "rate-only", GroupID: "g1", RateMultiplier: func() *float64 { v := 0.5; return &v }()},
		},
	}, clock)
	// The group cap is per user: two users each get their own bucket.
	mustAdmit(t, g, "plain", "g1")()
	mustRefuse(t, g, "plain", "g1", "group_rpm_exceeded")
	mustAdmit(t, g, "other", "g1")()
	// Another group is not capped.
	mustAdmit(t, g, "plain", "g2")()
	// The override replaces the group cap.
	for range 3 {
		mustAdmit(t, g, "boosted", "g1")()
	}
	mustRefuse(t, g, "boosted", "g1", "group_rpm_exceeded")
	// Override 0 exempts from the group cap, the user cap still applies.
	for range 3 {
		mustAdmit(t, g, "exempt", "g1")()
	}
	mustRefuse(t, g, "exempt", "g1", "user_rpm_exceeded")
	// A rate-only override keeps the group's RPM cap.
	mustAdmit(t, g, "rate-only", "g1")()
	mustRefuse(t, g, "rate-only", "g1", "group_rpm_exceeded")
}

func TestUserLimitGateConcurrencyHoldsUntilRelease(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{
		Users:  []SyncUserCapInput{{UserID: "u1", ConcurrencyLimit: u32(2)}},
		Groups: []SyncGroupCapInput{{GroupID: "g1", ConcurrencyLimit: 1}},
	}, clock)
	r1 := mustAdmit(t, g, "u1", "g1")
	mustRefuse(t, g, "u1", "g1", "group_concurrency_exceeded")
	r2 := mustAdmit(t, g, "u1", "g2")
	mustRefuse(t, g, "u1", "g3", "user_concurrency_exceeded")
	r1()
	r1() // idempotent: must not free a slot twice
	r3 := mustAdmit(t, g, "u1", "g1")
	mustRefuse(t, g, "u1", "g4", "user_concurrency_exceeded")
	st := g.stats([]string{"u1"})
	if len(st) != 1 || st[0].InFlight != 2 {
		t.Fatalf("stats = %+v, want 2 in flight", st)
	}
	r2()
	r3()
	if st := g.stats([]string{"u1"}); st[0].InFlight != 0 {
		t.Fatalf("in flight after release = %d", st[0].InFlight)
	}
}

func TestUserLimitGateRefusedTurnsCountNothing(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(&SyncUserLimitsInput{
		Users:  []SyncUserCapInput{{UserID: "u1", RPMLimit: u32(2)}},
		Groups: []SyncGroupCapInput{{GroupID: "g1", RPMLimit: 1}},
	}, clock)
	mustAdmit(t, g, "u1", "g1")()
	for range 5 {
		mustRefuse(t, g, "u1", "g1", "group_rpm_exceeded")
	}
	// The refused g1 turns did not use the user's budget.
	mustAdmit(t, g, "u1", "g2")()
	mustRefuse(t, g, "u1", "g2", "user_rpm_exceeded")
	st := g.stats([]string{"u1"})
	if st[0].RPMUsed != 2 || len(st[0].Groups) != 2 {
		t.Fatalf("stats = %+v", st)
	}
}

func TestUserLimitGateNoPolicyAndFailClosedOwner(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	open := newGate(nil, clock)
	for range 100 {
		mustAdmit(t, open, "u1", "g1")()
	}
	if _, rej := open.admit("", "g1"); rej != nil {
		t.Fatalf("no caps configured: an ownerless turn should pass, got %s", rej.code)
	}
	if st := open.stats([]string{"u1"}); st[0].RPMUsed != 100 {
		t.Fatalf("uncapped users are still counted for stats: %+v", st)
	}
	capped := newGate(&SyncUserLimitsInput{DefaultConcurrencyLimit: 3}, clock)
	_, rej := capped.admit("", "g1")
	if rej == nil || rej.code != "user_limits_unresolved" || rej.status != http.StatusServiceUnavailable {
		t.Fatalf("ownerless turn with caps configured must be refused, got %+v", rej)
	}
	// A new snapshot replaces the caps; counters carry over.
	capped.apply(&SyncUserLimitsInput{DefaultRPMLimit: 1})
	mustAdmit(t, capped, "u9", "g1")()
	mustRefuse(t, capped, "u9", "g1", "user_rpm_exceeded")
	capped.apply(nil)
	mustAdmit(t, capped, "u9", "g1")()
}

func TestUserLimitGateSweepDropsIdleCounters(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g := newGate(nil, clock)
	held := mustAdmit(t, g, "busy", "g1")
	mustAdmit(t, g, "idle", "g1")()
	clock.t = clock.t.Add(2 * time.Minute)
	mustAdmit(t, g, "fresh", "g1")()
	g.mu.Lock()
	_, idleKept := g.users["idle"]
	_, busyKept := g.users["busy"]
	g.mu.Unlock()
	if idleKept || !busyKept {
		t.Fatalf("sweep kept idle=%v busy=%v", idleKept, busyKept)
	}
	held()
}

func TestUserLimitGateConcurrentAdmissionsNeverExceedCap(t *testing.T) {
	g := &userLimitGate{}
	g.apply(&SyncUserLimitsInput{Users: []SyncUserCapInput{{UserID: "u1", ConcurrencyLimit: u32(4)}}})
	var inFlight, peak atomic.Int32
	var wg sync.WaitGroup
	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, rej := g.admit("u1", "g1")
			if rej != nil {
				return
			}
			n := inFlight.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			inFlight.Add(-1)
			release()
		}()
	}
	wg.Wait()
	if peak.Load() > 4 {
		t.Fatalf("peak in flight %d exceeds the cap of 4", peak.Load())
	}
}

// TestCoordinatorEnforcesUserLimitsAtTheEdge drives HandleHTTP against a fake slipgate-core:
// the snapshot's userLimits refuse the second turn of a user capped at 1 RPM with a 429 before it
// reaches the core (so no hold is taken), and the live stats report the admitted turn.
func TestCoordinatorEnforcesUserLimitsAtTheEdge(t *testing.T) {
	coreLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("core listen failed: %v", err)
	}
	defer coreLn.Close()
	var settles, evals atomic.Int32
	var lastSyncPayload atomic.Value
	go func() {
		for {
			conn, acceptErr := coreLn.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, rErr := dpbridge.ReadFrame(c)
				if rErr != nil {
					return
				}
				reply := dpbridge.Frame{StreamID: req.StreamID, Flags: dpbridge.FlagEndStream}
				switch req.Type {
				case dpbridge.FrameSyncState:
					lastSyncPayload.Store(string(req.Payload))
					reply.Type, reply.Payload = dpbridge.FrameSyncAck, []byte(`{"ok":true}`)
				case dpbridge.FrameReqHeaders:
					evals.Add(1)
					raw, _ := json.Marshal(coreDispatchDirective{
						Action: "dispatch", Status: 200, HoldID: 7, UserID: "usr_cap", APIKeyID: "key_cap",
						GroupID: "grp_1", AccountID: "acc_missing", Provider: "anthropic", ExecutionMode: "direct_http",
						PublicModel: "claude-sonnet-4-5", UpstreamModel: "claude-sonnet-4-5",
					})
					reply.Type, reply.Payload = dpbridge.FrameDispatchDirective, raw
				case dpbridge.FrameSettleReport:
					settles.Add(1)
					reply.Type, reply.Payload = dpbridge.FrameSettleAck, []byte(`{"ok":true,"settledCostNanoUsd":"0"}`)
				default:
					return
				}
				_ = dpbridge.WriteFrame(c, reply)
			}(conn)
		}
	}()

	coord := NewCoordinator(CoordinatorOptions{CoreIPC: coreLn.Addr().String(), VaultSecret: "unit-vault"})
	snapshot := `{"revisionUnixMs":1,"groups":[],"routes":[],"accounts":[],"apiKeys":[],"wallets":[],
		"userLimits":{"defaultRpmLimit":0,"defaultConcurrencyLimit":0,
			"users":[{"userId":"usr_cap","rpmLimit":1,"concurrencyLimit":null}],"groups":[],"overrides":[]}}`
	var snap SyncSnapshot
	if err := json.Unmarshal([]byte(snapshot), &snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	snap.APIKeys = []SyncApiKeyInput{{ID: "key_cap", UserID: "usr_cap", GroupID: "grp_1", KeyHashHex: sha256HexOf("sk-sg-test"), Enabled: true}}
	if _, err := coord.SyncSnapshot(context.Background(), snap); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	if p, _ := lastSyncPayload.Load().(string); strings.Contains(p, "userLimits") {
		t.Fatalf("userLimits must stay at the edge, not reach slipgate-core: %s", p)
	}

	send := func() *httptest.ResponseRecorder {
		body := `{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
		req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
		req.Header.Set("x-api-key", "sk-sg-test")
		rec := httptest.NewRecorder()
		coord.HandleHTTP(rec, req)
		return rec
	}

	first := send()
	// Admitted: it gets past the edge gate and stops at the missing account secret.
	if first.Code != http.StatusServiceUnavailable || !strings.Contains(first.Body.String(), "account_secret_unavailable") {
		t.Fatalf("first turn: %d %s", first.Code, first.Body.String())
	}
	evalsAfterFirst := evals.Load()
	second := send()
	if second.Code != http.StatusTooManyRequests || !strings.Contains(second.Body.String(), "user_rpm_exceeded") {
		t.Fatalf("second turn: %d %s", second.Code, second.Body.String())
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatalf("a refused turn carries Retry-After")
	}
	if got := evals.Load(); got != evalsAfterFirst {
		t.Fatalf("the refused turn must not reach slipgate-core, got %d more evaluations", got-evalsAfterFirst)
	}
	if got := settles.Load(); got < 1 {
		t.Fatalf("the admitted turn's hold must be released at slipgate-core, got %d settle reports", got)
	}
	stats := coord.UserLimitStats([]string{"usr_cap", "usr_none"})
	if len(stats) != 2 || stats[0].RPMUsed != 1 || stats[0].InFlight != 0 || stats[1].RPMUsed != 0 {
		t.Fatalf("stats = %+v", stats)
	}
	if len(stats[0].Groups) != 1 || stats[0].Groups[0].GroupID != "grp_1" {
		t.Fatalf("group stats = %+v", stats[0].Groups)
	}
}
