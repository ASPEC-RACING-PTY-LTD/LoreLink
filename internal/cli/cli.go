package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"lorelink.dev/lorelink/internal/app"
	"lorelink.dev/lorelink/internal/config"
)

func Execute(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: lorelink <serve|version|doctor>")
		return 2
	}
	switch args[1] {
	case "version", "--version", "-v":
		fmt.Println(app.Version())
		return 0
	case "serve":
		return runServe()
	case "doctor":
		return runDoctor()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[1])
		return 2
	}
}

func runServe() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := app.Start(ctx, cfg, log)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	<-ctx.Done()
	shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = a.Close(shut)
	return 0
}

func runDoctor() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := app.Doctor(context.Background(), cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
