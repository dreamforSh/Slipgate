package clashpool

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashcore"
)

type mockRuntime struct {
	applyCount  atomic.Int32
	closedConns []string
	delayErr    error
	delayValue  time.Duration
}

func (m *mockRuntime) Mode() string    { return "embedded" }
func (m *mockRuntime) Ready() bool     { return true }
func (m *mockRuntime) Version() string { return "v1.19.31-mock" }
func (m *mockRuntime) Apply(_ context.Context, _ []byte) error {
	m.applyCount.Add(1)
	return nil
}
func (m *mockRuntime) HasProxy(string) bool { return true }
func (m *mockRuntime) DelayTest(context.Context, string, string) (time.Duration, error) {
	if m.delayErr != nil {
		return 0, m.delayErr
	}
	if m.delayValue > 0 {
		return m.delayValue, nil
	}
	return 28 * time.Millisecond, nil
}
func (m *mockRuntime) Connections() []clashcore.ConnectionStats { return nil }
func (m *mockRuntime) CloseInboundConnections(names []string) int {
	m.closedConns = append(m.closedConns, names...)
	return len(names)
}
func (m *mockRuntime) Close() error { return nil }

type mockStealthBridge struct {
	exitIPToReturn atomic.Value
}

func (b *mockStealthBridge) ListProfiles() []TLSProfile { return nil }
func (b *mockStealthBridge) RegisterProfile(TLSProfile) {}
func (b *mockStealthBridge) DeleteProfile(string) error { return nil }
func (b *mockStealthBridge) TestAccountHTTP(context.Context, string, string, string) (OutboundMeta, error) {
	return OutboundMeta{StatusCode: 200, TLSVersion: "TLS 1.3", NegotiatedALPN: "h2"}, nil
}
func (b *mockStealthBridge) ProbeNodeExitIP(context.Context, string, string, string, string, time.Duration) (string, uint32, error) {
	if v, ok := b.exitIPToReturn.Load().(string); ok && v != "" {
		return v, 24, nil
	}
	return "203.0.113.77", 24, nil
}

func TestCoordinatorSyncProbeDriftAndBindLifecycle(t *testing.T) {
	t.Parallel()

	subBody := `
proxies:
  - name: "Tokyo-A"
    type: socks5
    server: 198.51.100.10
    port: 1080
  - name: "Tokyo-B"
    type: socks5
    server: 198.51.100.11
    port: 1080
`
	subSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sub" {
			_, _ = w.Write([]byte(subBody))
			return
		}
		_, _ = w.Write([]byte("proxies:\n  - name: \"Only-One\"\n    type: socks5\n    server: 198.51.100.10\n    port: 1080\n"))
	}))
	defer subSrv.Close()

	mgr := NewManager(21000, 21050, 1)
	rt := &mockRuntime{}
	store := NewMemoryNetStore()
	bridge := &mockStealthBridge{}
	bridge.exitIPToReturn.Store("203.0.113.77")

	coord := NewCoordinator(CoordinatorOptions{
		Manager: mgr,
		Runtime: rt,
		Store:   store,
		Stealth: bridge,
		Logger:  log.New(io.Discard, "", 0),
	})

	ctx := context.Background()
	if err := coord.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap failed: %v", err)
	}

	sub, syncRes, err := coord.CreateSubscription(ctx, CreateSubscriptionInput{
		ID:         "sub-test",
		Name:       "Primary Airport",
		SourceKind: "url",
		SourceURL:  subSrv.URL + "/sub",
		AutoSync:   true,
	})
	if err != nil {
		t.Fatalf("CreateSubscription + Sync failed: %v", err)
	}
	if syncRes == nil || syncRes.TotalNodes != 2 || !syncRes.ReconcileApplied {
		t.Fatalf("unexpected sync result: %+v", syncRes)
	}

	// Re-syncing identical payload must produce identical SHA-256 and skip runtime.Apply.
	appliesBefore := rt.applyCount.Load()
	sync2, err := coord.SyncSubscription(ctx, sub.ID, false)
	if err != nil {
		t.Fatalf("second SyncSubscription failed: %v", err)
	}
	if sync2.ReconcileApplied || rt.applyCount.Load() != appliesBefore {
		t.Fatalf("expected second unchanged sync to skip mihomo Apply")
	}

	// Probe nodes -> discovers ExitIP and transitions nodes to healthy.
	outcomes, err := coord.ProbeNodes(ctx, nil, true, false)
	if err != nil || len(outcomes) != 2 {
		t.Fatalf("ProbeNodes failed: len=%d err=%v", len(outcomes), err)
	}
	nodes := coord.EnrichedNodes()
	firstID, secondID := nodes[0].NodeID, nodes[1].NodeID

	// Bind acc-1 to firstID, and verify 1-exit-IP constraint blocks binding acc-2 to secondID sharing 203.0.113.77.
	if _, err := coord.BindAccount(ctx, "acc-1", firstID, "chrome-131", false); err != nil {
		t.Fatalf("BindAccount acc-1 failed: %v", err)
	}
	if _, err := coord.BindAccount(ctx, "acc-2", secondID, "chrome-131", false); !errors.Is(err, ErrExitCapacityExceeded) {
		t.Fatalf("expected ErrExitCapacityExceeded for second account on same IP, got %v", err)
	}

	// Unexpected Exit IP drift must open circuit & close active listener connections immediately.
	bridge.exitIPToReturn.Store("203.0.113.99")
	outcomes, err = coord.ProbeNodes(ctx, []string{firstID}, true, false)
	if err != nil || !outcomes[0].DriftUnconfirmed || outcomes[0].Health != string(HealthCircuitOpen) {
		t.Fatalf("expected drift circuit_open, got %+v err=%v", outcomes, err)
	}
	if len(rt.closedConns) == 0 {
		t.Fatalf("expected drifted listener inbound connections closed")
	}

	// Admin ConfirmDrift restores healthy routing and new IP.
	restored, err := coord.ConfirmDrift(ctx, firstID)
	if err != nil || restored.DriftUnconfirmed || restored.Health != HealthHealthy || restored.ExitIP != "203.0.113.99" {
		t.Fatalf("expected healthy node after ConfirmDrift, got %+v err=%v", restored, err)
	}
}
