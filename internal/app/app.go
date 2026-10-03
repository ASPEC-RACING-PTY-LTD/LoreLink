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
	"lorelink.dev/lorelink/internal/aspecmod"
	"lorelink.dev/lorelink/internal/config"
	"lorelink.dev/lorelink/internal/connector"
	"lorelink.dev/lorelink/internal/connector/codehold"
	"lorelink.dev/lorelink/internal/connector/genericgit"
	"lorelink.dev/lorelink/internal/connector/githubconn"
	"lorelink.dev/lorelink/internal/jobs"
	"lorelink.dev/lorelink/internal/maintainer"
	"lorelink.dev/lorelink/internal/publish"
	"lorelink.dev/lorelink/internal/searchidx"
	"lorelink.dev/lorelink/internal/secrets"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/webui"
	"lorelink.dev/lorelink/internal/workspace"
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
	if err := st.SeedASPEC(ctx); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("seed aspec modules: %w", err)
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

	reg := connector.NewRegistry(genericgit.New(), codehold.New(), githubconn.New())
	ws := &workspace.Manager{DataDir: cfg.DataDir, Store: st, Cipher: cipher, Reg: reg}
	idx := &searchidx.Indexer{Store: st, WS: ws}
	pub := &publish.Service{DataDir: cfg.DataDir, Store: st, WS: ws, Index: idx}
	mnt := &maintainer.Service{Store: st, WS: ws}
	worker := jobs.New(st, ws, pub, idx, mnt, log)
	worker.Start(ctx)

	apiServer := api.New(st, log, cfg.PublicURL).WithPlatform(cipher, reg, ws, cfg.DataDir)
	apiServer.APIKeyPepper = aspecmod.PepperFromInstanceKey(key)
	apiServer.Maintainer = mnt
	apiServer.Index = idx
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
	return "0.2.0"
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
	if _, err := os.Stat(cfg.DataDir); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}
	fmt.Println("  workspaces:", filepath.Join(cfg.DataDir, "workspaces"))
	return nil
}
