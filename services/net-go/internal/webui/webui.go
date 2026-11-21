package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// Handler serves the embedded Vue SPA assets with history-mode index.html fallback.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleanPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if cleanPath == "" || cleanPath == "." {
			cleanPath = "index.html"
		}

		if info, statErr := fs.Stat(sub, cleanPath); statErr == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		// Do not serve SPA HTML for missing static asset bundles.
		if strings.HasPrefix(cleanPath, "assets/") {
			http.NotFound(w, r)
			return
		}

		indexBytes, readErr := fs.ReadFile(sub, "index.html")
		if readErr != nil {
			http.Error(w, "slipgate web ui unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(indexBytes)
	})
}
