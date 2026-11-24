package dataplane

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
)

// testSnapshotKeys lists the "sk-sg-test" key the turn tests send, so an applied snapshot knows it.
var testSnapshotKeys = []SyncApiKeyInput{{ID: "key_1", UserID: "usr_1", GroupID: "grp_default", KeyHashHex: sha256HexOf("sk-sg-test"), Enabled: true}}

// trackedBody records whether the handler read the request body at all.
type trackedBody struct {
	io.Reader
	read atomic.Bool
}

func (b *trackedBody) Read(p []byte) (int, error) {
	b.read.Store(true)
	return b.Reader.Read(p)
}

func preauthTurn(coord *Coordinator, apiKey string) (*httptest.ResponseRecorder, bool) {
	body := &trackedBody{Reader: strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", body)
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	rec := httptest.NewRecorder()
	coord.HandleHTTP(rec, req)
	return rec, body.read.Load()
}

func TestKeysTheCoreWouldRefuseAreRefusedBeforeTheBodyIsRead(t *testing.T) {
	t.Parallel()
	core := newRecordingCore(t, func(f dpbridge.Frame) (dpbridge.Frame, bool) {
		if f.Type == dpbridge.FrameReqHeaders {
			return dispatchReply(42), true
		}
		return dpbridge.Frame{Type: dpbridge.FrameSettleAck, Payload: []byte(`{"ok":true}`)}, true
	})
	coord := NewCoordinator(CoordinatorOptions{CoreIPC: core.addr, InternalToken: coreHoldsToken, VaultSecret: "preauth-vault"})

	// A missing key is refused even before the first snapshot.
	rec, read := preauthTurn(coord, "")
	if rec.Code != http.StatusUnauthorized || read || !strings.Contains(rec.Body.String(), "invalid_api_key") {
		t.Fatalf("missing key: %d read=%v %s", rec.Code, read, rec.Body.String())
	}
	// Before a snapshot the edge cannot know the key set: the core decides.
	if _, read := preauthTurn(coord, "sk-sg-unknown"); !read {
		t.Fatal("without a snapshot an unknown key must still be left to slipgate-core")
	}

	enc, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Accounts:       []SyncAccountInput{{ID: "acc_mock", GroupID: "grp_default", Platform: "anthropic", ExecutionMode: "direct_api", CredentialsEncHex: enc, MaxConcurrency: 4, Status: "active"}},
		APIKeys: []SyncApiKeyInput{
			{ID: "key_1", UserID: "usr_1", GroupID: "grp_default", KeyHashHex: sha256HexOf("sk-sg-known"), Enabled: true},
			{ID: "key_off", UserID: "usr_1", GroupID: "grp_default", KeyHashHex: sha256HexOf("sk-sg-disabled"), Enabled: false},
		},
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	evalsBefore := len(core.ofType(dpbridge.FrameReqHeaders))

	rec, read = preauthTurn(coord, "sk-sg-unknown")
	if rec.Code != http.StatusUnauthorized || read || !strings.Contains(rec.Body.String(), "invalid_api_key") {
		t.Fatalf("unknown key after a snapshot: %d read=%v %s", rec.Code, read, rec.Body.String())
	}
	if got := len(core.ofType(dpbridge.FrameReqHeaders)); got != evalsBefore {
		t.Fatalf("an unknown key must not reach slipgate-core (%d evaluations)", got-evalsBefore)
	}

	// Known keys, disabled ones included (the core answers those itself), are read and evaluated.
	for _, key := range []string{"sk-sg-known", "sk-sg-disabled"} {
		if _, read := preauthTurn(coord, key); !read {
			t.Fatalf("%s must reach slipgate-core", key)
		}
	}
	if got := len(core.ofType(dpbridge.FrameReqHeaders)); got != evalsBefore+2 {
		t.Fatalf("expected 2 more evaluations, got %d", got-evalsBefore)
	}
}
