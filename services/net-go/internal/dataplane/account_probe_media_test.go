package dataplane

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Account tests by endpoint: image, embedding and speech probes go through the multimodal /
// extended outbound path, report media (data: URLs or provider URLs) and embedding dimensions,
// surface upstream errors, and are refused for providers that do not offer the endpoint.

func TestProbeAccountByEndpointKind(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]map[string]any{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		seen[r.URL.Path] = body
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/images/generations":
			if body["prompt"] == "fail please" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprint(w, `{"error":{"type":"invalid_request_error","code":"content_policy_violation","message":"prompt rejected"}}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"created":1,"data":[{"url":"https://img.example/1.png"}]}`)
		case "/v1/embeddings":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2,0.3,0.4,0.5,0.6]}],"usage":{"prompt_tokens":5,"total_tokens":5}}`)
		case "/v1/audio/speech":
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("ID3fake-mp3"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "probe-media-vault-secret", AllowPrivateUpstreams: true})
	encReal, _ := coord.Vault().EncryptHex(fmt.Sprintf(`{"apiKey":"sk-probe-media","baseUrl":%q}`, upstream.URL+"/v1"))
	encMock, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp", Platform: "composite", SubscriptionType: "balance", RateMultiplier: 1, Enabled: true}},
		Accounts: []SyncAccountInput{
			{ID: "acc_openai", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encReal, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_mock", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encMock, MaxConcurrency: 2, Status: "active"},
			{ID: "acc_claude", GroupID: "grp", Platform: "anthropic", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encMock, MaxConcurrency: 2, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	last := func(events []ProbeEvent) ProbeEvent { return events[len(events)-1] }
	media := func(events []ProbeEvent) []ProbeEvent {
		var out []ProbeEvent
		for _, ev := range events {
			if ev.Type == "media" {
				out = append(out, ev)
			}
		}
		return out
	}

	t.Run("image through the real outbound path", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "image", Prompt: "a cat"})
		if events[0].Type != "start" || events[0].Kind != "image" || events[0].Model != "gpt-image-1" {
			t.Fatalf("expected an image start with the default image model, got %+v", events[0])
		}
		if got := seen["/v1/images/generations"]; got["model"] != "gpt-image-1" || got["prompt"] != "a cat" || got["n"] != float64(1) {
			t.Fatalf("unexpected upstream image request %+v", got)
		}
		m := media(events)
		if len(m) != 1 || m[0].MediaURL != "https://img.example/1.png" || m[0].Kind != "image" {
			t.Fatalf("expected the generated image URL, got %+v", m)
		}
		if done := last(events); done.Type != "done" || !done.Success || done.Status != http.StatusOK {
			t.Fatalf("expected a successful done, got %+v", done)
		}
	})

	t.Run("image rejected upstream reports the provider error", func(t *testing.T) {
		done := last(collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "image", Prompt: "fail please"}))
		if done.Success || done.Status != http.StatusBadRequest || done.Code != "content_policy_violation" || !strings.Contains(done.Message, "prompt rejected") {
			t.Fatalf("expected the upstream 400 to be reported, got %+v", done)
		}
	})

	t.Run("embedding reports the vector length", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "embedding", Prompt: "hello"})
		if got := seen["/v1/embeddings"]; got["model"] != "text-embedding-3-small" || got["input"] != "hello" {
			t.Fatalf("unexpected upstream embeddings request %+v", got)
		}
		if done := last(events); !done.Success || done.Dimensions != 6 || done.Kind != "embedding" {
			t.Fatalf("expected 6 dimensions, got %+v", done)
		}
	})

	t.Run("speech returns the audio as a data URL", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "speech"})
		if got := seen["/v1/audio/speech"]; got["model"] != "gpt-4o-mini-tts" || got["voice"] != "alloy" || got["input"] == "" {
			t.Fatalf("unexpected upstream speech request %+v", got)
		}
		m := media(events)
		if len(m) != 1 || m[0].MimeType != "audio/mpeg" || !strings.HasPrefix(m[0].MediaURL, "data:audio/mpeg;base64,") {
			t.Fatalf("expected the audio clip, got %+v", m)
		}
		if done := last(events); !done.Success {
			t.Fatalf("expected success, got %+v", done)
		}
	})

	t.Run("mock credentials answer every kind", func(t *testing.T) {
		img := collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "image"})
		if m := media(img); len(m) != 1 || !strings.HasPrefix(m[0].MediaURL, "data:image/png;base64,") || !last(img).Success {
			t.Fatalf("mock image: %+v", img)
		}
		if done := last(collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "embedding"})); !done.Success || done.Dimensions != 4 {
			t.Fatalf("mock embedding: %+v", done)
		}
		if done := last(collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "speech"})); !done.Success {
			t.Fatalf("mock speech: %+v", done)
		}
	})

	t.Run("unsupported kinds are refused, unknown kinds fall back to text", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_claude", ProbeRequest{Kind: "image"})
		if len(events) != 1 || events[0].Type != "error" || events[0].Code != "probe_kind_unsupported" {
			t.Fatalf("expected an unsupported-kind error, got %+v", events)
		}
		if start := collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "telepathy"})[0]; start.Kind != "text" {
			t.Fatalf("an unknown kind must run the text test, got %+v", start)
		}
	})

	if kinds := ProbeKindsFor("anthropic"); len(kinds) != 1 || kinds[0] != "text" {
		t.Fatalf("anthropic offers text only, got %v", kinds)
	}
	if DefaultProbeModelFor("image", "gemini") != "imagen-4.0-generate-001" || DefaultProbeModelFor("text", "openai") != DefaultProbeModel("openai") {
		t.Fatalf("unexpected default models")
	}
}
