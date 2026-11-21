package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDynamicHandlerOverrideAndFallback(t *testing.T) {
	t.Parallel()

	h := Handler()

	// 1. Default embedded index serves HTML.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /, got %d", rec.Code)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
		t.Fatalf("expected HTML response from embedded dist")
	}

	// 2. Missing assets/* returns 404.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/does-not-exist.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing asset, got %d", rec.Code)
	}

	// 3. Hot-swap override dir serves updated SPA without rebuilding handler.
	overrideDir := t.TempDir()
	customHTML := "<!doctype html><html><body>hot-updated-webui</body></html>"
	if err := os.WriteFile(filepath.Join(overrideDir, "index.html"), []byte(customHTML), 0o644); err != nil {
		t.Fatalf("write override index.html: %v", err)
	}
	h.SetOverrideDir(overrideDir)
	if h.OverrideDir() == "" {
		t.Fatalf("expected non-empty OverrideDir")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/dashboard", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on overridden SPA fallback, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "hot-updated-webui") {
		t.Fatalf("expected overridden webui content, got %q", rec.Body.String())
	}

	// 4. Clearing override reverts cleanly to embedded bundle.
	h.SetOverrideDir("")
	if h.OverrideDir() != "" {
		t.Fatalf("expected empty OverrideDir after clear")
	}
}
