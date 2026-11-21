package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
)

//go:embed all:dist
var distFS embed.FS

// DynamicHandler serves the Vue SPA from an optional live-updated directory on disk,
// falling back transparently to the embedded dist bundle.
type DynamicHandler struct {
	embedded    fs.FS
	overrideDir atomic.Pointer[string]
}

// Handler returns a dynamic SPA handler backed by embedded assets and live override support.
func Handler() *DynamicHandler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return &DynamicHandler{embedded: sub}
}

// SetOverrideDir configures (or clears when empty) the hot-synced frontend bundle directory.
func (d *DynamicHandler) SetOverrideDir(dir string) {
	cleaned := strings.TrimSpace(dir)
	if cleaned == "" {
		d.overrideDir.Store(nil)
		return
	}
	abs := cleaned
	if resolved, err := filepath.Abs(cleaned); err == nil {
		abs = resolved
	}
	d.overrideDir.Store(&abs)
}

// OverrideDir returns the currently active hot-synced frontend directory, or empty string if none.
func (d *DynamicHandler) OverrideDir() string {
	ptr := d.overrideDir.Load()
	if ptr == nil {
		return ""
	}
	return *ptr
}

func (d *DynamicHandler) activeFS() fs.FS {
	dir := d.OverrideDir()
	if dir != "" {
		if info, err := os.Stat(filepath.Join(dir, "index.html")); err == nil && !info.IsDir() {
			return os.DirFS(dir)
		}
	}
	return d.embedded
}

// ServeHTTP serves static assets or falls back to index.html for Vue history-mode routes.
func (d *DynamicHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	active := d.activeFS()
	fileServer := http.FileServer(http.FS(active))

	cleanPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if cleanPath == "" || cleanPath == "." {
		cleanPath = "index.html"
	}

	if info, statErr := fs.Stat(active, cleanPath); statErr == nil && !info.IsDir() {
		fileServer.ServeHTTP(w, r)
		return
	}

	// Do not serve SPA HTML for missing static asset bundles.
	if strings.HasPrefix(cleanPath, "assets/") {
		http.NotFound(w, r)
		return
	}

	indexBytes, readErr := fs.ReadFile(active, "index.html")
	if readErr != nil {
		http.Error(w, "slipgate web ui unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(indexBytes)
}
