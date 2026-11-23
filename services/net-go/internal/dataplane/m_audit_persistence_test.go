package dataplane

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
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

func sha256HexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestPreIPCGateRejectsDisallowedIPAndThrottledUserWithoutBurningCoreRPM(t *testing.T) {
	const internalTok = "test-internal-tok"
	const plainKey = "sk-sg-test-precheck-key-0001"

	var coreHits atomic.Int32
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				if f.Type == dpbridge.FrameSyncState {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameSyncAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true}`),
					})
					return
				}
				if f.Type == dpbridge.FrameSettleReport {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameSettleAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true,"settledCostNanoUsd":"1000"}`),
					})
					return
				}
				coreHits.Add(1)
				payload, _ := json.Marshal(coreDispatchDirective{
					Engine:        "zig",
					Action:        "dispatch",
					HoldID:        1,
					UserID:        "usr_1",
					APIKeyID:      "key_1",
					GroupID:       "grp_1",
					AccountID:     "acc_1",
					Provider:      "openai",
					ExecutionMode: "direct_api",
					AuthKind:      "api_key",
					PublicModel:   "gpt-4o-mini",
					UpstreamModel: "gpt-4o-mini",
				})
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{
					StreamID: f.StreamID,
					Type:     dpbridge.FrameDispatchDirective,
					Flags:    dpbridge.FlagEndStream,
					Payload:  payload,
				})
			}(conn)
		}
	}()

	const vaultSecret = "0123456789abcdef0123456789abcdef"
	coord := NewCoordinator(CoordinatorOptions{
		CoreIPC:               ln.Addr().String(),
		InternalToken:         internalTok,
		VaultSecret:           vaultSecret,
		AllowPrivateUpstreams: true,
	})
	encCred, err := coord.Vault().EncryptHex(`{"apiKey":"mock://echo"}`)
	if err != nil {
		t.Fatal(err)
	}
	rpmOne := uint32(1)
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts: []SyncAccountInput{{
			ID:                "acc_1",
			GroupID:           "grp_1",
			Platform:          "openai",
			ExecutionMode:     "direct_api",
			AuthKind:          "api_key",
			CredentialsEncHex: encCred,
			Status:            "active",
			MaxConcurrency:    5,
		}},
		APIKeys: []SyncApiKeyInput{{
			ID:               "key_1",
			UserID:           "usr_1",
			GroupID:          "grp_1",
			KeyHashHex:       sha256HexOf(plainKey),
			RPMLimit:         60,
			ConcurrencyLimit: 5,
			IPAllowlist:      []string{"203.0.113.10"},
			Enabled:          true,
		}},
		UserLimits: &SyncUserLimitsInput{
			Users: []SyncUserCapInput{{UserID: "usr_1", RPMLimit: &rpmOne}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// 1. Disallowed client IP must be rejected at edge with 0 IPC hits to core-zig.
	badIPReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}`))
	badIPReq.RemoteAddr = "198.51.100.99:44321"
	badIPReq.Header.Set("Authorization", "Bearer "+plainKey)
	badIPReq.Header.Set("Content-Type", "application/json")
	rec1 := httptest.NewRecorder()
	coord.HandleHTTP(rec1, badIPReq)
	if rec1.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed IP, got %d: %s", rec1.Code, rec1.Body.String())
	}
	if coreHits.Load() != 0 {
		t.Fatalf("expected 0 core IPC calls for disallowed IP, got %d", coreHits.Load())
	}

	// 2. Allowed client IP succeeds once (1 core hit), then second call in same minute is rejected by precheck with 0 extra core hits.
	okReq := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}`))
		r.RemoteAddr = "203.0.113.10:44321"
		r.Header.Set("Authorization", "Bearer "+plainKey)
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		coord.HandleHTTP(rec, r)
		return rec
	}
	if r := okReq(); r.Code != http.StatusOK {
		t.Fatalf("expected 200 on first allowed call, got %d: %s", r.Code, r.Body.String())
	}
	if coreHits.Load() != 1 {
		t.Fatalf("expected 1 core IPC hit after first allowed call, got %d", coreHits.Load())
	}
	if r := okReq(); r.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 on second call over user RPM, got %d", r.Code)
	}
	if coreHits.Load() != 1 {
		t.Fatalf("expected throttled second call to stop before core IPC (still 1 hit), got %d", coreHits.Load())
	}
}

func TestResponsesAndVideoPersistenceAcrossCoordinatorRestarts(t *testing.T) {
	const internalTok = "persist-internal-tok"
	const vaultSecret = "fedcba9876543210fedcba9876543210"
	const plainKey = "sk-sg-persist-test-key-0002"

	var bffMu sync.Mutex
	persisted := make(map[string]map[string]any)
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Slipgate-Internal-Token") != internalTok {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/internal/dataplane/media-tasks" {
			raw, _ := io.ReadAll(r.Body)
			var doc map[string]any
			_ = json.Unmarshal(raw, &doc)
			key := doc["kind"].(string) + ":" + doc["id"].(string)
			bffMu.Lock()
			persisted[key] = doc
			bffMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/internal/dataplane/media-tasks/") {
			rest := strings.TrimPrefix(r.URL.Path, "/api/v1/internal/dataplane/media-tasks/")
			parts := strings.SplitN(rest, "/", 2)
			key := parts[0] + ":" + parts[1]
			apiKeyID := r.URL.Query().Get("apiKeyId")
			bffMu.Lock()
			doc, ok := persisted[key]
			if !ok || doc["apiKeyId"] != apiKeyID {
				bffMu.Unlock()
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Method == http.MethodDelete {
				delete(persisted, key)
				bffMu.Unlock()
				_, _ = w.Write([]byte(`{"ok":true,"deleted":true}`))
				return
			}
			out, _ := json.Marshal(map[string]any{"ok": true, "item": doc})
			bffMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(out)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer bff.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				f, err := dpbridge.ReadFrame(c)
				if err != nil {
					return
				}
				if f.Type == dpbridge.FrameSyncState {
					_ = dpbridge.WriteFrame(c, dpbridge.Frame{
						StreamID: f.StreamID,
						Type:     dpbridge.FrameSyncAck,
						Flags:    dpbridge.FlagEndStream,
						Payload:  []byte(`{"ok":true}`),
					})
					return
				}
				payload, _ := json.Marshal(coreDispatchDirective{
					Engine:   "zig",
					Action:   "models",
					APIKeyID: "key_persist",
					UserID:   "usr_p",
					GroupID:  "grp_p",
					Models:   []string{"gpt-5"},
				})
				_ = dpbridge.WriteFrame(c, dpbridge.Frame{
					StreamID: f.StreamID,
					Type:     dpbridge.FrameDispatchDirective,
					Flags:    dpbridge.FlagEndStream,
					Payload:  payload,
				})
			}(conn)
		}
	}()

	makeCoord := func() *Coordinator {
		c := NewCoordinator(CoordinatorOptions{
			CoreIPC:               ln.Addr().String(),
			BFFOrigin:             bff.URL,
			InternalToken:         internalTok,
			VaultSecret:           vaultSecret,
			AllowPrivateUpstreams: true,
		})
		encCred, err := c.Vault().EncryptHex(`{"apiKey":"mock://echo"}`)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = c.SyncSnapshot(context.Background(), SyncSnapshot{
			RevisionUnixMs: 1,
			Accounts: []SyncAccountInput{{
				ID:                "acc_vid",
				GroupID:           "grp_p",
				Platform:          "openai",
				ExecutionMode:     "direct_api",
				AuthKind:          "api_key",
				CredentialsEncHex: encCred,
				Status:            "active",
			}},
		})
		return c
	}

	// Coordinator #1 writes stateful response + video task to BFF, then "restarts" (discarded).
	coord1 := makeCoord()
	turn := &CanonicalTurn{Messages: []CanonicalMessage{{Role: "user", Content: "persist me"}}}
	coord1.responsesState.captureTurn("key_persist", "gpt-5", turn, []byte(`{"id":"resp_restart_1","object":"response","output":[{"type":"message","content":[{"type":"output_text","text":"saved!"}]}]}`))
	coord1.mediaTasks.put(mediaTaskAffinity{
		taskID:      "vid_restart_1",
		ownerKeyID:  "key_persist",
		userID:      "usr_p",
		groupID:     "grp_p",
		accountID:   "acc_vid",
		provider:    "openai",
		publicModel: "sora-2",
		expiresAt:   time.Now().Add(time.Hour),
	})

	// Coordinator #2 starts with empty RAM and reads both back from BFF seamlessly.
	coord2 := makeCoord()

	getResp := httptest.NewRequest(http.MethodGet, "/v1/responses/resp_restart_1", bytes.NewReader(nil))
	getResp.Header.Set("Authorization", "Bearer "+plainKey)
	recResp := httptest.NewRecorder()
	coord2.HandleHTTP(recResp, getResp)
	if recResp.Code != http.StatusOK || !strings.Contains(recResp.Body.String(), "resp_restart_1") {
		t.Fatalf("expected 200 persisted response after restart, got %d: %s", recResp.Code, recResp.Body.String())
	}

	getVid := httptest.NewRequest(http.MethodGet, "/v1/videos/vid_restart_1", bytes.NewReader(nil))
	getVid.Header.Set("Authorization", "Bearer "+plainKey)
	recVid := httptest.NewRecorder()
	coord2.HandleHTTP(recVid, getVid)
	if recVid.Code != http.StatusOK || !strings.Contains(recVid.Body.String(), "vid_restart_1") {
		t.Fatalf("expected 200 persisted video task after restart, got %d: %s", recVid.Code, recVid.Body.String())
	}

	delResp := httptest.NewRequest(http.MethodDelete, "/v1/responses/resp_restart_1", bytes.NewReader(nil))
	delResp.Header.Set("Authorization", "Bearer "+plainKey)
	recDel := httptest.NewRecorder()
	coord2.HandleHTTP(recDel, delResp)
	if recDel.Code != http.StatusOK {
		t.Fatalf("expected 200 deleting persisted response, got %d", recDel.Code)
	}

	// Coordinator #3 confirms deletion propagated to BFF.
	coord3 := makeCoord()
	recGone := httptest.NewRecorder()
	coord3.HandleHTTP(recGone, httptest.NewRequest(http.MethodGet, "/v1/responses/resp_restart_1", nil))
	if recGone.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after persisted delete, got %d", recGone.Code)
	}
}
