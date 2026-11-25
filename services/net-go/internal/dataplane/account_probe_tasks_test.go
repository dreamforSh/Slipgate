package dataplane

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Account tests with uploads and long-running tasks: an OpenAI image edit from an uploaded
// image, transcription of an uploaded clip (or the built-in silent one), and video tasks polled
// until they render, fail or outlast the wait.

type probeUpload struct {
	fields   map[string]string
	fileName string
	fileMime string
	file     []byte
}

func readProbeMultipart(t *testing.T, r *http.Request) probeUpload {
	t.Helper()
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("not multipart: %v", err)
	}
	out := probeUpload{fields: map[string]string{}}
	mr := multipart.NewReader(r.Body, params["boundary"])
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("multipart: %v", err)
		}
		data, _ := io.ReadAll(part)
		if part.FileName() != "" {
			out.fileName, out.fileMime, out.file = part.FileName(), part.Header.Get("Content-Type"), data
		} else {
			out.fields[part.FormName()] = string(data)
		}
	}
}

func TestProbeAccountUploadsAndTasks(t *testing.T) {
	prevWait, prevPoll := probeVideoMaxWait, probeVideoPollInterval
	probeVideoMaxWait, probeVideoPollInterval = 2*time.Second, 10*time.Millisecond
	defer func() { probeVideoMaxWait, probeVideoPollInterval = prevWait, prevPoll }()

	var mu sync.Mutex
	uploads := map[string]probeUpload{}
	bodies := map[string]map[string]any{}
	polls := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && (r.URL.Path == "/v1/images/edits" || r.URL.Path == "/v1/audio/transcriptions"):
			up := readProbeMultipart(t, r)
			uploads[r.URL.Path] = up
			if r.URL.Path == "/v1/images/edits" {
				fmt.Fprint(w, `{"created":1,"data":[{"b64_json":"aW1n"}]}`)
				return
			}
			if bytes.HasPrefix(up.file, []byte("RIFF")) {
				fmt.Fprint(w, `{"text":""}`)
				return
			}
			fmt.Fprint(w, `{"text":" hello world "}`)
		case r.Method == http.MethodPost && (r.URL.Path == "/v1/videos" || r.URL.Path == "/v1/videos/generations"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			bodies[r.URL.Path] = body
			id := strings.ReplaceAll(fmt.Sprint(body["prompt"]), " ", "_")
			if r.URL.Path == "/v1/videos/generations" {
				fmt.Fprintf(w, `{"request_id":%q}`, id)
				return
			}
			fmt.Fprintf(w, `{"id":%q,"object":"video","status":"queued"}`, id)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/content"):
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("fake-mp4"))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/videos/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/videos/")
			polls[id]++
			n := polls[id]
			switch {
			case id == "renders_fine" && n < 3:
				fmt.Fprintf(w, `{"id":%q,"status":"in_progress","progress":%d}`, id, n*40)
			case id == "renders_fine":
				fmt.Fprintf(w, `{"id":%q,"status":"completed","progress":100}`, id)
			case id == "breaks":
				fmt.Fprintf(w, `{"id":%q,"status":"failed","error":{"code":"moderation_blocked","message":"blocked by moderation"}}`, id)
			case id == "grok_clip":
				fmt.Fprint(w, `{"status":"done","video":{"url":"https://vid.example/clip.mp4"}}`)
			default:
				fmt.Fprintf(w, `{"id":%q,"status":"in_progress","progress":0.25}`, id)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	coord := NewCoordinator(CoordinatorOptions{VaultSecret: "probe-tasks-vault-secret", AllowPrivateUpstreams: true})
	enc := func(key string) string {
		v, _ := coord.Vault().EncryptHex(fmt.Sprintf(`{"apiKey":%q,"baseUrl":%q}`, key, upstream.URL+"/v1"))
		return v
	}
	encMock, _ := coord.Vault().EncryptHex("mock://ok")
	if _, err := coord.SyncSnapshot(context.Background(), SyncSnapshot{
		RevisionUnixMs: 1,
		Groups:         []SyncGroupInput{{ID: "grp", Platform: "composite", SubscriptionType: "balance", RateMultiplier: 1, Enabled: true}},
		Accounts: []SyncAccountInput{
			{ID: "acc_openai", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc("sk-openai"), MaxConcurrency: 4, Status: "active"},
			{ID: "acc_grok", GroupID: "grp", Platform: "grok", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: enc("xai-key"), MaxConcurrency: 4, Status: "active"},
			{ID: "acc_gemini", GroupID: "grp", Platform: "gemini", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encMock, MaxConcurrency: 4, Status: "active"},
			{ID: "acc_mock", GroupID: "grp", Platform: "openai", ExecutionMode: "direct_api", AuthKind: "api_key", CredentialsEncHex: encMock, MaxConcurrency: 4, Status: "active"},
		},
	}); err != nil {
		t.Fatalf("SyncSnapshot: %v", err)
	}
	last := func(events []ProbeEvent) ProbeEvent { return events[len(events)-1] }
	byType := func(events []ProbeEvent, typ string) []ProbeEvent {
		var out []ProbeEvent
		for _, ev := range events {
			if ev.Type == typ {
				out = append(out, ev)
			}
		}
		return out
	}
	png := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("\x89PNG-source"))

	t.Run("an uploaded image turns the OpenAI image test into an edit", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "image", Prompt: "make it blue", ImageDataURL: png})
		up := uploads["/v1/images/edits"]
		if up.fields["model"] != "gpt-image-1" || up.fields["prompt"] != "make it blue" || up.fileName != "source.png" || up.fileMime != "image/png" || string(up.file) != "\x89PNG-source" {
			t.Fatalf("unexpected edit upload %+v", up)
		}
		if m := byType(events, "media"); len(m) != 1 || m[0].MediaURL != "data:image/png;base64,aW1n" {
			t.Fatalf("expected the edited image, got %+v", m)
		}
		if done := last(events); !done.Success {
			t.Fatalf("expected success, got %+v", done)
		}
	})

	t.Run("uploads are validated against the kind and provider", func(t *testing.T) {
		cases := []struct {
			account string
			req     ProbeRequest
			code    string
		}{
			{"acc_gemini", ProbeRequest{Kind: "image", ImageDataURL: png}, "probe_input_unsupported"},
			{"acc_openai", ProbeRequest{Kind: "text", AudioDataURL: "data:audio/wav;base64,UklGRg=="}, "probe_input_unsupported"},
			{"acc_openai", ProbeRequest{Kind: "image", ImageDataURL: "https://img.example/x.png"}, "probe_input_invalid"},
			{"acc_openai", ProbeRequest{Kind: "image", ImageDataURL: "data:text/plain;base64,aGk="}, "probe_input_invalid"},
			{"acc_openai", ProbeRequest{Kind: "transcription", AudioDataURL: "data:audio/wav;base64,!!!"}, "probe_input_invalid"},
			{"acc_openai", ProbeRequest{Kind: "image", ImageDataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, probeMaxInputMediaBytes+1))}, "probe_input_invalid"},
		}
		for _, tc := range cases {
			events := collectProbe(t, coord, tc.account, tc.req)
			if len(events) != 1 || events[0].Type != "error" || events[0].Code != tc.code {
				t.Fatalf("%s %+v: expected %s, got %+v", tc.account, tc.req.Kind, tc.code, events)
			}
		}
	})

	t.Run("transcription sends the built-in silent clip when nothing is uploaded", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "transcription"})
		up := uploads["/v1/audio/transcriptions"]
		if up.fields["model"] != "whisper-1" || up.fields["response_format"] != "json" || up.fileName != "audio.wav" || !bytes.HasPrefix(up.file, []byte("RIFF")) || len(up.file) != 44+32000 {
			t.Fatalf("unexpected transcription upload: fields=%v file=%s (%d bytes)", up.fields, up.fileName, len(up.file))
		}
		if len(byType(events, "delta")) != 0 || len(byType(events, "progress")) != 2 {
			t.Fatalf("expected the built-in clip note and an empty-transcript note, got %+v", events)
		}
		if done := last(events); !done.Success || done.Kind != "transcription" {
			t.Fatalf("expected success, got %+v", done)
		}
	})

	t.Run("transcription of an uploaded clip returns the transcript", func(t *testing.T) {
		clip := "data:audio/mpeg;base64," + base64.StdEncoding.EncodeToString([]byte("ID3-speech"))
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "transcription", AudioDataURL: clip, Prompt: "names: Slipgate"})
		up := uploads["/v1/audio/transcriptions"]
		if up.fileName != "audio.mp3" || string(up.file) != "ID3-speech" || up.fields["prompt"] != "names: Slipgate" {
			t.Fatalf("unexpected upload %+v", up)
		}
		if d := byType(events, "delta"); len(d) != 1 || d[0].Text != "hello world" {
			t.Fatalf("expected the transcript, got %+v", events)
		}
	})

	t.Run("an OpenAI video is polled until it renders, then previewed", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "video", Prompt: "renders fine"})
		if got := bodies["/v1/videos"]; got["model"] != "sora-2" || got["seconds"] != "4" {
			t.Fatalf("unexpected video request %+v", got)
		}
		progress := byType(events, "progress")
		if len(progress) < 3 || progress[1].Progress != 40 || progress[len(progress)-1].Progress != 100 {
			t.Fatalf("expected queued → 40%% → … → 100%%, got %+v", progress)
		}
		m := byType(events, "media")
		if len(m) != 1 || m[0].Kind != "video" || m[0].MediaURL != "data:video/mp4;base64,"+base64.StdEncoding.EncodeToString([]byte("fake-mp4")) {
			t.Fatalf("expected the downloaded clip, got %+v", m)
		}
		if done := last(events); !done.Success || done.Kind != "video" {
			t.Fatalf("expected success, got %+v", done)
		}
	})

	t.Run("a failed video task fails the test with the provider's reason", func(t *testing.T) {
		done := last(collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "video", Prompt: "breaks"}))
		if done.Success || done.Code != "video_failed" || done.Message != "blocked by moderation" {
			t.Fatalf("expected the failure reason, got %+v", done)
		}
	})

	t.Run("a video still rendering at the deadline passes with a note", func(t *testing.T) {
		probeVideoMaxWait = 120 * time.Millisecond
		defer func() { probeVideoMaxWait = 2 * time.Second }()
		events := collectProbe(t, coord, "acc_openai", ProbeRequest{Kind: "video", Prompt: "takes forever"})
		progress := byType(events, "progress")
		if len(progress) < 2 || progress[1].Progress != 25 || !strings.Contains(progress[len(progress)-1].Text, "still rendering") {
			t.Fatalf("expected progress then a still-rendering note, got %+v", progress)
		}
		if done := last(events); !done.Success || len(byType(events, "media")) != 0 {
			t.Fatalf("expected a pass without media, got %+v", events)
		}
	})

	t.Run("a Grok video takes a first frame and returns its URL", func(t *testing.T) {
		events := collectProbe(t, coord, "acc_grok", ProbeRequest{Kind: "video", Prompt: "grok clip", ImageDataURL: png})
		got := bodies["/v1/videos/generations"]
		image, _ := got["image"].(map[string]any)
		if got["model"] != "grok-imagine-video" || image["url"] != png {
			t.Fatalf("unexpected grok video request %+v", got)
		}
		if m := byType(events, "media"); len(m) != 1 || m[0].MediaURL != "https://vid.example/clip.mp4" {
			t.Fatalf("expected the video URL, got %+v", events)
		}
	})

	t.Run("mock credentials pass video and transcription", func(t *testing.T) {
		if done := last(collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "video"})); !done.Success {
			t.Fatalf("mock video: %+v", done)
		}
		events := collectProbe(t, coord, "acc_mock", ProbeRequest{Kind: "transcription"})
		if d := byType(events, "delta"); len(d) != 1 || !last(events).Success {
			t.Fatalf("mock transcription: %+v", events)
		}
	})
}

func TestVideoSecondsValueAcceptsStringsAndNumbers(t *testing.T) {
	for raw, want := range map[string]uint32{`"4"`: 4, `8`: 8, `"2.5"`: 3, `null`: 0, `"x"`: 0, `-1`: 0, ``: 0} {
		if got := videoSecondsValue(json.RawMessage(raw)); got != want {
			t.Fatalf("videoSecondsValue(%s) = %d, want %d", raw, got, want)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, "http://x/v1/videos", strings.NewReader(`{"model":"sora-2","prompt":"p","seconds":"8"}`))
	turn, err := parseMultimodalIngress(req, []byte(`{"model":"sora-2","prompt":"p","seconds":"8"}`))
	if err != nil || turn.VideoSeconds != 8 {
		t.Fatalf("OpenAI string seconds must parse: %v %+v", err, turn)
	}
}
