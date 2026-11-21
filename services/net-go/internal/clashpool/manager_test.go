package clashpool

import (
	"errors"
	"testing"
)

func seedHealthyNode(id, subID, exitIP string, port int) Node {
	return Node{
		ID:            id,
		SubscriptionID: subID,
		Name:          "node-" + id,
		ProxySlotID:   "slot-" + id,
		ListenerPort:  port,
		SocksUsername: "u-" + id,
		SocksPassword: "p-" + id,
		ExitIP:        exitIP,
		LatencyMS:     45,
		Health:        HealthHealthy,
		Enabled:       true,
	}
}

func TestSingleExitIPCapacityAndShadowExemption(t *testing.T) {
	t.Parallel()

	mgr := NewManager(20000, 24999, 1)
	_, err := mgr.SyncNodes("sub-1", []Node{
		seedHealthyNode("n1", "sub-1", "203.0.113.10", 20001),
		seedHealthyNode("n2", "sub-1", "203.0.113.10", 20002), // same exit IP
	}, false)
	if err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}

	if err := mgr.BindAccount("acc-1", "n1", false); err != nil {
		t.Fatalf("first bind failed: %v", err)
	}

	// Second primary account sharing the same exit IP must be rejected.
	if err := mgr.BindAccount("acc-2", "n2", false); !errors.Is(err, ErrExitCapacityExceeded) {
		t.Fatalf("expected ErrExitCapacityExceeded, got %v", err)
	}

	// Shadow follower account sharing the parent exit IP must be permitted.
	if err := mgr.BindAccount("acc-1-shadow", "n1", true); err != nil {
		t.Fatalf("shadow bind failed: %v", err)
	}
}

func TestFailClosedOnUnhealthyOrDriftedExit(t *testing.T) {
	t.Parallel()

	mgr := NewManager(20000, 24999, 1)
	if _, err := mgr.SyncNodes("sub-1", []Node{
		seedHealthyNode("n1", "sub-1", "198.51.100.7", 20010),
	}, false); err != nil {
		t.Fatalf("SyncNodes failed: %v", err)
	}

	if err := mgr.BindAccount("acc-1", "n1", false); err != nil {
		t.Fatalf("BindAccount failed: %v", err)
	}

	target, err := mgr.ResolveDialTarget("acc-1")
	if err != nil {
		t.Fatalf("ResolveDialTarget failed while healthy: %v", err)
	}
	if target.SOCKSAddr != "127.0.0.1:20010" {
		t.Fatalf("unexpected SOCKSAddr: %s", target.SOCKSAddr)
	}

	// Unexpected exit IP drift must trip fail-closed circuit breaker.
	if err := mgr.ReportProbe("n1", "198.51.100.99", 50, true); err != nil {
		t.Fatalf("ReportProbe failed: %v", err)
	}
	if _, err := mgr.ResolveDialTarget("acc-1"); !errors.Is(err, ErrExitCircuitOpen) {
		t.Fatalf("expected ErrExitCircuitOpen on IP drift, got %v", err)
	}

	// Admin confirmation restores routing.
	if err := mgr.ConfirmExitDrift("n1"); err != nil {
		t.Fatalf("ConfirmExitDrift failed: %v", err)
	}
	if _, err := mgr.ResolveDialTarget("acc-1"); err != nil {
		t.Fatalf("expected restored dial target after confirm, got %v", err)
	}
}

func TestSubscriptionDropGuard(t *testing.T) {
	t.Parallel()

	mgr := NewManager(20000, 24999, 1)
	initial := []Node{
		seedHealthyNode("n1", "sub-1", "198.51.100.1", 20001),
		seedHealthyNode("n2", "sub-1", "198.51.100.2", 20002),
		seedHealthyNode("n3", "sub-1", "198.51.100.3", 20003),
		seedHealthyNode("n4", "sub-1", "198.51.100.4", 20004),
	}
	if _, err := mgr.SyncNodes("sub-1", initial, false); err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}

	// Dropping from 4 nodes to 1 (>50%) must trigger drop guard unless forced.
	report, err := mgr.SyncNodes("sub-1", initial[:1], false)
	if !errors.Is(err, ErrDropGuardTriggered) || !report.SkippedByDropGuard {
		t.Fatalf("expected drop guard skip, got report=%+v err=%v", report, err)
	}

	// Force sync overrides drop guard and circuits-open removed nodes.
	if _, err := mgr.SyncNodes("sub-1", initial[:1], true); err != nil {
		t.Fatalf("forced sync failed: %v", err)
	}
}
