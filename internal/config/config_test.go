package config

import "testing"

func TestLoadFromEnvRequiresDatabase(t *testing.T) {
	t.Parallel()
	_, err := LoadFromEnv(func(string) string { return "" })
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadFromEnvDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := LoadFromEnv(func(key string) string {
		if key == EnvDatabaseURL {
			return "postgres://lorelink:lorelink@127.0.0.1:5432/lorelink?sslmode=disable"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != DefaultDataDir {
		t.Fatalf("data dir: %s", cfg.DataDir)
	}
	if cfg.HTTPAddr != DefaultHTTPAddr {
		t.Fatalf("http addr: %s", cfg.HTTPAddr)
	}
}
