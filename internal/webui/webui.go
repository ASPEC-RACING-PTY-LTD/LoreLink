package webui

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func Mount(mux *http.ServeMux, portalDir, docsDir string) {
	if docsDir != "" {
		mux.Handle("/view/", http.StripPrefix("/view", spa(docsDir, "docs")))
	}
	if portalDir != "" {
		mux.Handle("/", spa(portalDir, "portal"))
		return
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("LoreLink API is running. Build web/portal to serve the management UI.\n"))
	})
}

func spa(dir, name string) http.Handler {
	index := filepath.Join(dir, "index.html")
	file := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			http.ServeFile(w, r, index)
			return
		}
		full := filepath.Join(dir, filepath.Clean(p))
		if !strings.HasPrefix(full, filepath.Clean(dir)+string(os.PathSeparator)) && full != filepath.Clean(dir) {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			file.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, index)
	})
}

func DirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func Sub(fsys fs.FS, name string) (fs.FS, error) {
	return fs.Sub(fsys, name)
}
