package dataplane

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Not parallel: synced versions are process-wide.
func TestCLIVersionSyncFollowsReleasesWithinGuards(t *testing.T) {
	for _, tool := range cliTools {
		for _, k := range tool.EnvKeys {
			t.Setenv(k, "")
		}
	}
	t.Cleanup(func() {
		for _, tool := range cliTools {
			syncedCLIVersions.Delete(tool.Key)
		}
	})

	answers := map[string]string{
		"/-/package/@anthropic-ai/claude-code/dist-tags": `{"stable":"2.1.326","latest":"2.1.340"}`,
		// Older than the pin: ignored.
		"/-/package/@openai/codex/dist-tags": `{"latest":"0.150.0"}`,
		// Prerelease: ignored.
		"/-/package/@google/gemini-cli/dist-tags": `{"latest":"0.72.0-preview.0"}`,
		// New major: waits for a reviewed pin.
		"/-/package/@qwen-code/qwen-code/dist-tags": `{"latest":"1.0.0"}`,
		"/-/package/@xai-official/grok/dist-tags":   `{"latest":"1.0.95"}`,
		"/api/saoudrizwan/claude-dev":               `{"version":"4.2.0"}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := answers[r.URL.Path]
		if !ok {
			http.Error(w, "nope", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	s := NewCLIVersionSyncer()
	s.npmBase, s.openVSXBase = srv.URL, srv.URL
	report := s.SyncOnce(context.Background())

	if got := CLIClaudeVersion(); got != "2.1.340" {
		t.Fatalf("claude = %q, want synced 2.1.340", got)
	}
	if got := ClaudeCLIUserAgent(""); got != "claude-cli/2.1.340 (external, cli)" {
		t.Fatalf("claude UA = %q", got)
	}
	if got := CLICodexVersion(); got != defaultCodexCLIVersion {
		t.Fatalf("codex took an older release: %q", got)
	}
	if got := CLIGeminiVersion(); got != defaultGeminiCLIVersion {
		t.Fatalf("gemini took a prerelease: %q", got)
	}
	if got := CLIQwenVersion(); got != defaultQwenCLIVersion {
		t.Fatalf("qwen jumped a major: %q", got)
	}
	if got := CLIGrokVersion(); got != "1.0.95" {
		t.Fatalf("grok = %q", got)
	}
	if got := CLIClineVersion(); got != "4.2.0" {
		t.Fatalf("cline = %q", got)
	}

	byKey := map[string]CLIFingerprintTool{}
	for _, tool := range report.Tools {
		byKey[tool.Key] = tool
	}
	if c := byKey["claude"]; c.Source != "synced" || c.Latest != "2.1.340" || c.Builtin != defaultClaudeCLIVersion {
		t.Fatalf("claude row = %+v", c)
	}
	if c := byKey["codex"]; c.Source != "builtin" || c.Latest != "0.150.0" {
		t.Fatalf("codex row = %+v", c)
	}
	if o := byKey["opencode"]; o.Error == "" || !strings.Contains(o.Error, "HTTP 500") {
		t.Fatalf("opencode should report the registry error, got %+v", o)
	}
	if a := byKey["antigravity"]; a.Syncable || a.Source != "builtin" {
		t.Fatalf("antigravity row = %+v", a)
	}
	if report.LastSyncAtMs == 0 {
		t.Fatal("last sync time not recorded")
	}

	// An env override still wins over a synced release.
	t.Setenv("SLIPGATE_CLAUDE_CLI_VERSION", "2.1.399")
	if got := CLIClaudeVersion(); got != "2.1.399" {
		t.Fatalf("env override lost: %q", got)
	}
	if row := s.Report().Tools[0]; row.Source != "env" {
		t.Fatalf("claude source with env = %+v", row)
	}
}
