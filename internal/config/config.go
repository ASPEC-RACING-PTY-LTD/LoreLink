package config

import (
	"fmt"
	"net"
	"os"
	"strings"
)

const (
	EnvDatabaseURL = "LORELINK_DATABASE_URL"
	EnvDataDir     = "LORELINK_DATA_DIR"
	EnvHTTPAddr    = "LORELINK_HTTP_ADDR"
	EnvPublicURL   = "LORELINK_PUBLIC_URL"

	DefaultDataDir  = "./data"
	DefaultHTTPAddr = ":8080"
)

type Config struct {
	DatabaseURL string
	DataDir     string
	HTTPAddr    string
	PublicURL   string
}

func Load() (Config, error) {
	return LoadFromEnv(os.Getenv)
}

func LoadFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, fmt.Errorf("config: getenv is required")
	}
	cfg := Config{
		DatabaseURL: strings.TrimSpace(getenv(EnvDatabaseURL)),
		DataDir:     firstNonEmpty(strings.TrimSpace(getenv(EnvDataDir)), DefaultDataDir),
		HTTPAddr:    firstNonEmpty(strings.TrimSpace(getenv(EnvHTTPAddr)), DefaultHTTPAddr),
		PublicURL:   strings.TrimSpace(getenv(EnvPublicURL)),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return fmt.Errorf("config: %s is required", EnvDatabaseURL)
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("config: %s is required", EnvDataDir)
	}
	if err := validateAddr(EnvHTTPAddr, c.HTTPAddr); err != nil {
		return err
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func validateAddr(name, addr string) error {
	if strings.TrimSpace(addr) == "" {
		return fmt.Errorf("config: %s is required", name)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if _, err := net.LookupPort("tcp", strings.TrimPrefix(addr, ":")); err == nil {
			return nil
		}
		return fmt.Errorf("config: %s: %w", name, err)
	}
	_ = host
	if port == "" {
		return fmt.Errorf("config: %s: port is required", name)
	}
	return nil
}
