package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"lorelink.dev/lorelink/internal/api"
	"lorelink.dev/lorelink/internal/config"
	"lorelink.dev/lorelink/internal/secrets"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/webui"
)

type App struct {
	Cfg    config.Config
	Store  *store.Store
	Cipher *secrets.Cipher
	Log    *slog.Logger
	Server *http.Server
}

func Start(ctx context.Context, cfg config.Config, log *slog.Logger) (*App, error) {
	if log == nil {
		log = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := store.Migrate(ctx, st.DB); err != nil {
		_ = st.Close()
		return nil, err
	}
	key, err := secrets.LoadOrCreateInstanceKey(cfg.DataDir)
	if err != nil {
		_ = st.Close()
		return nil, err
	}
	cipher, err := secrets.NewCipher(key)
	if err != nil {
		_ = st.Close()
		return nil, err
	}

	apiServer := api.New(st, log, cfg.PublicURL)
	mux := http.NewServeMux()
	mux.Handle("/healthz", apiServer.Handler())
	mux.Handle("/readyz", apiServer.Handler())
	mux.Handle("/api/", apiServer.Handler())

	portalDir := firstExisting(
		filepath.Join(cfg.DataDir, "web", "portal"),
		"web/portal/dist",
		"/app/web/portal",
	)
	docsDir := firstExisting(
		filepath.Join(cfg.DataDir, "web", "docs-site"),
		"web/docs-site/dist",
		"/app/web/docs-site",
	)
	webui.Mount(mux, portalDir, docsDir)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	a := &App{Cfg: cfg, Store: st, Cipher: cipher, Log: log, Server: srv}
	go func() {
		log.Info("lorelink listening", "addr", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server", "err", err)
		}
	}()
	return a, nil
}

func (a *App) Close(ctx context.Context) error {
	if a.Server != nil {
		_ = a.Server.Shutdown(ctx)
	}
	if a.Store != nil {
		return a.Store.Close()
	}
	return nil
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if webui.DirExists(p) {
			return p
		}
	}
	return ""
}

func Version() string {
	return "0.1.0-phase0"
}

func Doctor(ctx context.Context, cfg config.Config) error {
	fmt.Println("LoreLink doctor")
	fmt.Println("  data dir:", cfg.DataDir)
	fmt.Println("  http:    ", cfg.HTTPAddr)
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer st.Close()
	if err := st.Ping(ctx); err != nil {
		return fmt.Errorf("database ping: %w", err)
	}
	fmt.Println("  database: ok")
	if _, err := secrets.LoadOrCreateInstanceKey(cfg.DataDir); err != nil {
		return fmt.Errorf("instance key: %w", err)
	}
	fmt.Println("  instance key: ok")
	return nil
}
