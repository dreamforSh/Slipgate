package dataplane

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Per-user and per-(user, group) request caps enforced at the edge (lane U1).
//
// slipgate-bff sends the caps in the snapshot's `userLimits` (DataPlaneSyncUserLimitsSchema in
// packages/contracts/src/user_limits.ts). Every turn slipgate-core dispatches is admitted against
// all of them at once (Linksyncx parity: any breach rejects with HTTP 429 rate_limit_error):
//
//   - user RPM / concurrency: one bucket per user across every key and group;
//   - group RPM: one bucket per (user, group); the user's RPM override in that group replaces the
//     group's cap, and an override of 0 exempts the user from it (the user cap still applies);
//   - group concurrency: one in-flight bucket per (user, group).
//
// RPM uses the same fixed one-minute buckets as slipgate-core's per-key limiter. A refused turn
// counts against nothing; an admitted one holds its concurrency slots until the handler returns.
// slipgate-core's per-key buckets stay in force underneath (the BFF also clamps each key's own
// limits to the caps that cover it).

// SyncUserLimitsInput matches DataPlaneSyncUserLimitsSchema.
type SyncUserLimitsInput struct {
	DefaultRPMLimit         uint32                       `json:"defaultRpmLimit"`
	DefaultConcurrencyLimit uint32                       `json:"defaultConcurrencyLimit"`
	Users                   []SyncUserCapInput           `json:"users"`
	Groups                  []SyncGroupCapInput          `json:"groups"`
	Overrides               []SyncUserGroupOverrideInput `json:"overrides"`
}

// SyncUserCapInput is one user's own caps; nil inherits the default, 0 = unlimited.
type SyncUserCapInput struct {
	UserID           string  `json:"userId"`
	RPMLimit         *uint32 `json:"rpmLimit"`
	ConcurrencyLimit *uint32 `json:"concurrencyLimit"`
}

// SyncGroupCapInput is a group's per-user caps (0 = none).
type SyncGroupCapInput struct {
	GroupID          string `json:"groupId"`
	RPMLimit         uint32 `json:"rpmLimit"`
	ConcurrencyLimit uint32 `json:"concurrencyLimit"`
}

// SyncUserGroupOverrideInput is a user's custom settings in one group. RateMultiplier is billed by
// slipgate-bff and is not used here.
type SyncUserGroupOverrideInput struct {
	UserID         string   `json:"userId"`
	GroupID        string   `json:"groupId"`
	RPMOverride    *uint32  `json:"rpmOverride"`
	RateMultiplier *float64 `json:"rateMultiplier"`
}

type userCaps struct {
	rpm, concurrency uint32
}

type userLimitPolicy struct {
	defaults userCaps
	users    map[string]userCaps
	groups   map[string]userCaps
	// rpmOverrides holds only non-null overrides (0 = exempt from the group cap).
	rpmOverrides map[string]uint32
}

// capsFor resolves the caps covering one (user, group); 0 = none.
func (p *userLimitPolicy) capsFor(userID, groupID string) (user userCaps, group userCaps) {
	if p == nil {
		return userCaps{}, userCaps{}
	}
	user = p.defaults
	if own, ok := p.users[userID]; ok {
		user = own
	}
	group = p.groups[groupID]
	if override, ok := p.rpmOverrides[pairKey(userID, groupID)]; ok {
		group.rpm = override
	}
	return user, group
}

// limited reports whether any cap could apply to some user.
func (p *userLimitPolicy) limited() bool {
	return p != nil && (p.defaults.rpm > 0 || p.defaults.concurrency > 0 || len(p.users) > 0 || len(p.groups) > 0 || len(p.rpmOverrides) > 0)
}

func pairKey(userID, groupID string) string {
	return userID + "\x00" + groupID
}

func buildUserLimitPolicy(in *SyncUserLimitsInput) *userLimitPolicy {
	if in == nil {
		return nil
	}
	p := &userLimitPolicy{
		defaults:     userCaps{rpm: in.DefaultRPMLimit, concurrency: in.DefaultConcurrencyLimit},
		users:        make(map[string]userCaps, len(in.Users)),
		groups:       make(map[string]userCaps, len(in.Groups)),
		rpmOverrides: make(map[string]uint32, len(in.Overrides)),
	}
	for _, u := range in.Users {
		id := strings.TrimSpace(u.UserID)
		if id == "" {
			continue
		}
		caps := p.defaults
		if u.RPMLimit != nil {
			caps.rpm = *u.RPMLimit
		}
		if u.ConcurrencyLimit != nil {
			caps.concurrency = *u.ConcurrencyLimit
		}
		p.users[id] = caps
	}
	for _, g := range in.Groups {
		id := strings.TrimSpace(g.GroupID)
		if id == "" || (g.RPMLimit == 0 && g.ConcurrencyLimit == 0) {
			continue
		}
		p.groups[id] = userCaps{rpm: g.RPMLimit, concurrency: g.ConcurrencyLimit}
	}
	for _, o := range in.Overrides {
		if o.RPMOverride == nil || strings.TrimSpace(o.UserID) == "" || strings.TrimSpace(o.GroupID) == "" {
			continue
		}
		p.rpmOverrides[pairKey(o.UserID, o.GroupID)] = *o.RPMOverride
	}
	return p
}

type limitCounter struct {
	minute   int64
	count    uint32
	inFlight uint32
	lastSeen int64
}

// rpmAt is the count of the current minute bucket.
func (c *limitCounter) rpmAt(minute int64) uint32 {
	if c == nil || c.minute != minute {
		return 0
	}
	return c.count
}

const (
	// userLimitSweepEvery bounds how often idle counters are dropped.
	userLimitSweepEvery = 30 * time.Second
	// userLimitMaxTracked bounds the counter maps: past it, turns of users without any cap are no
	// longer tracked (their stats read 0); capped users always are, so enforcement never lapses.
	userLimitMaxTracked = 500_000
)

// userLimitGate is the edge admission state. Its zero value is ready to use (no caps).
type userLimitGate struct {
	mu        sync.Mutex
	policy    *userLimitPolicy
	users     map[string]*limitCounter
	pairs     map[string]*limitCounter
	lastSweep int64
	// now is overridden by tests.
	now func() time.Time
}

// apply installs the caps of a new snapshot (nil = no caps). Counters carry over.
func (g *userLimitGate) apply(in *SyncUserLimitsInput) {
	p := buildUserLimitPolicy(in)
	g.mu.Lock()
	g.policy = p
	g.mu.Unlock()
}

func (g *userLimitGate) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// userLimitRejection is why a turn was refused.
type userLimitRejection struct {
	status       int
	errType      string
	code         string
	message      string
	retryAfterMs uint64
}

func (g *userLimitGate) sweepLocked(nowMs int64) {
	interval := userLimitSweepEvery.Milliseconds()
	if len(g.users)+len(g.pairs) >= userLimitMaxTracked {
		interval = time.Second.Milliseconds()
	}
	if nowMs-g.lastSweep < interval {
		return
	}
	g.lastSweep = nowMs
	minute := nowMs / 60_000
	for k, c := range g.users {
		if c.inFlight == 0 && c.minute < minute {
			delete(g.users, k)
		}
	}
	for k, c := range g.pairs {
		if c.inFlight == 0 && c.minute < minute {
			delete(g.pairs, k)
		}
	}
}

func counterFor(m map[string]*limitCounter, key string, minute, nowMs int64, track bool) *limitCounter {
	c := m[key]
	if c == nil {
		if !track {
			return nil
		}
		c = &limitCounter{minute: minute}
		m[key] = c
	}
	if c.minute != minute {
		c.minute = minute
		c.count = 0
	}
	c.lastSeen = nowMs
	return c
}

// precheck inspects whether (userID, groupID) has already hit an RPM or concurrency cap without
// mutating counters. Used before slipgate-core IPC so a throttled user does not burn key RPM.
func (g *userLimitGate) precheck(userID, groupID string) *userLimitRejection {
	if userID == "" {
		return nil
	}
	nowMs := g.clock().UnixMilli()
	minute := nowMs / 60_000
	g.mu.Lock()
	defer g.mu.Unlock()
	policy := g.policy
	if policy == nil {
		return nil
	}
	userCap, groupCap := policy.capsFor(userID, groupID)
	untilNextMinute := uint64((minute+1)*60_000 - nowMs)
	if groupID != "" && groupCap.rpm > 0 {
		if gc := g.pairs[pairKey(userID, groupID)]; gc.rpmAt(minute) >= groupCap.rpm {
			return &userLimitRejection{
				status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "group_rpm_exceeded",
				message: "group requests-per-minute limit exceeded", retryAfterMs: untilNextMinute,
			}
		}
	}
	if userCap.rpm > 0 {
		if uc := g.users[userID]; uc.rpmAt(minute) >= userCap.rpm {
			return &userLimitRejection{
				status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "user_rpm_exceeded",
				message: "user requests-per-minute limit exceeded", retryAfterMs: untilNextMinute,
			}
		}
	}
	if groupID != "" && groupCap.concurrency > 0 {
		if gc := g.pairs[pairKey(userID, groupID)]; gc != nil && gc.inFlight >= groupCap.concurrency {
			return &userLimitRejection{
				status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "group_concurrency_exceeded",
				message: "group concurrent request limit exceeded", retryAfterMs: 1000,
			}
		}
	}
	if userCap.concurrency > 0 {
		if uc := g.users[userID]; uc != nil && uc.inFlight >= userCap.concurrency {
			return &userLimitRejection{
				status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "user_concurrency_exceeded",
				message: "user concurrent request limit exceeded", retryAfterMs: 1000,
			}
		}
	}
	return nil
}

// admit decides one turn. On success it returns a release func (idempotent) that frees the
// turn's concurrency slots; on refusal it returns the rejection and a no-op release.
func (g *userLimitGate) admit(userID, groupID string) (func(), *userLimitRejection) {
	nowMs := g.clock().UnixMilli()
	minute := nowMs / 60_000
	g.mu.Lock()
	defer g.mu.Unlock()
	policy := g.policy
	if userID == "" {
		// Fail closed: a dispatched turn without an owner cannot be counted against any cap.
		if policy.limited() {
			return func() {}, &userLimitRejection{
				status:  http.StatusServiceUnavailable,
				errType: "api_error",
				code:    "user_limits_unresolved",
				message: "request owner could not be resolved for user limits",
			}
		}
		return func() {}, nil
	}
	if g.users == nil {
		g.users = make(map[string]*limitCounter)
		g.pairs = make(map[string]*limitCounter)
	}
	g.sweepLocked(nowMs)

	userCap, groupCap := policy.capsFor(userID, groupID)
	capped := userCap.rpm > 0 || userCap.concurrency > 0 || groupCap.rpm > 0 || groupCap.concurrency > 0
	track := capped || len(g.users)+len(g.pairs) < userLimitMaxTracked
	uc := counterFor(g.users, userID, minute, nowMs, track)
	var gc *limitCounter
	if groupID != "" {
		gc = counterFor(g.pairs, pairKey(userID, groupID), minute, nowMs, track)
	}
	untilNextMinute := uint64((minute+1)*60_000 - nowMs)

	if groupCap.rpm > 0 && gc.rpmAt(minute) >= groupCap.rpm {
		return func() {}, &userLimitRejection{
			status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "group_rpm_exceeded",
			message: "group requests-per-minute limit exceeded", retryAfterMs: untilNextMinute,
		}
	}
	if userCap.rpm > 0 && uc.rpmAt(minute) >= userCap.rpm {
		return func() {}, &userLimitRejection{
			status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "user_rpm_exceeded",
			message: "user requests-per-minute limit exceeded", retryAfterMs: untilNextMinute,
		}
	}
	if groupCap.concurrency > 0 && gc != nil && gc.inFlight >= groupCap.concurrency {
		return func() {}, &userLimitRejection{
			status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "group_concurrency_exceeded",
			message: "group concurrent request limit exceeded", retryAfterMs: 1000,
		}
	}
	if userCap.concurrency > 0 && uc.inFlight >= userCap.concurrency {
		return func() {}, &userLimitRejection{
			status: http.StatusTooManyRequests, errType: "rate_limit_error", code: "user_concurrency_exceeded",
			message: "user concurrent request limit exceeded", retryAfterMs: 1000,
		}
	}
	if uc == nil {
		// Untracked (over the bound and uncapped): nothing to count or release.
		return func() {}, nil
	}
	uc.count++
	uc.inFlight++
	if gc != nil {
		gc.count++
		gc.inFlight++
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			if uc.inFlight > 0 {
				uc.inFlight--
			}
			if gc != nil && gc.inFlight > 0 {
				gc.inFlight--
			}
		})
	}, nil
}

// UserLimitGroupStats is one (user, group) pair's live counters.
type UserLimitGroupStats struct {
	GroupID  string `json:"groupId"`
	RPMUsed  uint32 `json:"rpmUsed"`
	InFlight uint32 `json:"inFlight"`
}

// UserLimitStats is one user's live counters (current minute and in flight).
type UserLimitStats struct {
	UserID   string                `json:"userId"`
	RPMUsed  uint32                `json:"rpmUsed"`
	InFlight uint32                `json:"inFlight"`
	Groups   []UserLimitGroupStats `json:"groups"`
}

// stats reads the counters of the given users (unknown users read 0).
func (g *userLimitGate) stats(userIDs []string) []UserLimitStats {
	minute := g.clock().UnixMilli() / 60_000
	g.mu.Lock()
	defer g.mu.Unlock()
	wanted := make(map[string]int, len(userIDs))
	out := make([]UserLimitStats, 0, len(userIDs))
	for _, id := range userIDs {
		if _, dup := wanted[id]; dup || id == "" {
			continue
		}
		wanted[id] = len(out)
		st := UserLimitStats{UserID: id, Groups: []UserLimitGroupStats{}}
		if c := g.users[id]; c != nil {
			st.RPMUsed = c.rpmAt(minute)
			st.InFlight = c.inFlight
		}
		out = append(out, st)
	}
	for k, c := range g.pairs {
		userID, groupID, ok := strings.Cut(k, "\x00")
		if !ok {
			continue
		}
		idx, hit := wanted[userID]
		if !hit {
			continue
		}
		rpm := c.rpmAt(minute)
		if rpm == 0 && c.inFlight == 0 {
			continue
		}
		out[idx].Groups = append(out[idx].Groups, UserLimitGroupStats{GroupID: groupID, RPMUsed: rpm, InFlight: c.inFlight})
	}
	for i := range out {
		sort.Slice(out[i].Groups, func(a, b int) bool { return out[i].Groups[a].GroupID < out[i].Groups[b].GroupID })
	}
	return out
}

// UserLimitStats reports live per-user counters for slipgate-bff's admin views.
func (c *Coordinator) UserLimitStats(userIDs []string) []UserLimitStats {
	return c.userLimits.stats(userIDs)
}

// admitUserLimits runs the edge admission for a dispatched turn. When the turn is refused it
// releases slipgate-core's hold (no charge), writes the 429 and returns admitted=false. The
// returned release must always be deferred: it frees the turn's concurrency slots (no-op when
// refused).
func (c *Coordinator) admitUserLimits(
	w http.ResponseWriter,
	codec CodecKind,
	d *coreDispatchDirective,
	settle func(RelayMetrics) coreSettleAck,
) (release func(), admitted bool) {
	release, rej := c.userLimits.admit(d.UserID, d.GroupID)
	if rej == nil {
		return release, true
	}
	settle(RelayMetrics{UpstreamStatus: rej.status})
	setRetryAfter(w.Header(), rej.retryAfterMs)
	WriteProtocolError(w, codec, rej.status, rej.errType, rej.code, rej.message)
	return release, false
}
