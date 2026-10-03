package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"lorelink.dev/lorelink/internal/app"
	"lorelink.dev/lorelink/internal/config"
)

func Execute(args []string) int {
	if len(args) < 2 {
		usage(os.Stderr)
		return 2
	}
	switch args[1] {
	case "help", "-h", "--help":
		usage(os.Stdout)
		return 0
	case "version", "--version", "-v":
		fmt.Println(app.Version())
		return 0
	case "serve":
		return runServe()
	case "doctor":
		return runDoctor()
	case "login":
		return runLogin(args[2:])
	case "logout":
		return runLogout()
	case "whoami":
		return runWhoami()
	case "status":
		return runStatus(args[2:])
	case "orgs":
		return runOrgs()
	case "projects":
		return runProjects(args[2:])
	case "connect":
		return runConnect(args[2:])
	case "bind":
		return runBind(args[2:])
	case "sync":
		return runSync(args[2:])
	case "docs":
		return runDocs(args[2:])
	case "check":
		return runMaintain(append([]string{"check"}, args[2:]...))
	case "build":
		return runPublish(append([]string{"--target", "hosted"}, args[2:]...))
	case "publish":
		return runPublish(args[2:])
	case "maintain":
		return runMaintain(args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[1])
		usage(os.Stderr)
		return 2
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, `usage: lorelink <command>

  serve              start the control plane
  version            print version
  doctor             check local instance health
  login              store an API token
  logout             forget the stored token
  whoami             show the authenticated user
  status             show project binding and jobs
  orgs               list organisations
  projects           list projects
  connect            create a git connection
  bind               bind a project to a repository
  sync               enqueue a repository sync
  docs               tree|get|put documentation files
  check              run maintainer check
  build              publish the hosted target
  publish            publish to hosted|filesystem|download
  maintain           check|sync|explain generated docs

lol is the same binary under a shorter name.`)
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

func runLogin(args []string) int {
	flags := parseFlags(args)
	base := flag(flags, "url", os.Getenv("LORELINK_URL"))
	email := flag(flags, "email", "")
	password := flag(flags, "password", "")
	if base == "" || email == "" || password == "" {
		fmt.Fprintln(os.Stderr, "usage: lorelink login --url https://host --email you@example.com --password ...")
		return 2
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 20 * time.Second}
	if err := jsonRequest(client, base, "", "POST", "/api/v1/auth/login", map[string]string{"email": email, "password": password}, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var tok struct {
		Token string `json:"token"`
	}
	if err := jsonRequest(client, base, "", "POST", "/api/v1/auth/token", map[string]string{}, &tok); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := saveCreds(base, tok.Token); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("logged in")
	return 0
}

func runLogout() int {
	path, err := credsPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = os.Remove(path)
	fmt.Println("logged out")
	return 0
}

func runWhoami() int {
	var me map[string]any
	if err := apiGet("/api/v1/me", &me); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(me)
}

func runStatus(args []string) int {
	flags := parseFlags(args)
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var out map[string]any
	if err := apiGet("/api/v1/orgs/"+org+"/projects/"+project, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var jobs map[string]any
	_ = apiGet("/api/v1/orgs/"+org+"/projects/"+project+"/jobs", &jobs)
	out["jobs"] = jobs["jobs"]
	return printJSON(out)
}

func runOrgs() int {
	var out map[string]any
	if err := apiGet("/api/v1/orgs", &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runProjects(args []string) int {
	flags := parseFlags(args)
	org, err := resolveOrg(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var out map[string]any
	if err := apiGet("/api/v1/orgs/"+org+"/projects", &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runConnect(args []string) int {
	if len(args) == 0 || args[0] != "create" {
		fmt.Fprintln(os.Stderr, "usage: lorelink connect create --org <id> --provider generic|codehold|github --name <name> --url <base> --token <secret>")
		return 2
	}
	flags := parseFlags(args[1:])
	org, err := resolveOrg(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	body := map[string]string{
		"provider":     flag(flags, "provider", "generic"),
		"display_name": flag(flags, "name", ""),
		"base_url":     flag(flags, "url", ""),
		"token":        flag(flags, "token", ""),
	}
	var out map[string]any
	if err := apiPost("/api/v1/orgs/"+org+"/connections", body, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runBind(args []string) int {
	flags := parseFlags(args)
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	body := map[string]string{
		"connection_id":  flag(flags, "connection", ""),
		"repo_url":       flag(flags, "repo", ""),
		"repo_full_name": flag(flags, "full-name", ""),
		"default_branch": flag(flags, "branch", ""),
		"docs_root":      flag(flags, "docs-root", ""),
	}
	var out map[string]any
	if err := apiPost("/api/v1/orgs/"+org+"/projects/"+project+"/bind", body, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runSync(args []string) int {
	flags := parseFlags(args)
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var out map[string]any
	if err := apiPost("/api/v1/orgs/"+org+"/projects/"+project+"/sync", map[string]any{}, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runDocs(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: lorelink docs <tree|get|put> --org --project [--path] [--file]")
		return 2
	}
	flags := parseFlags(args[1:])
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	switch args[0] {
	case "tree":
		var out map[string]any
		if err := apiGet("/api/v1/orgs/"+org+"/projects/"+project+"/files", &out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return printJSON(out)
	case "get":
		path := flag(flags, "path", "")
		var out map[string]any
		if err := apiGet("/api/v1/orgs/"+org+"/projects/"+project+"/file?path="+path, &out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if raw, ok := out["content"].(string); ok {
			fmt.Print(raw)
			return 0
		}
		return printJSON(out)
	case "put":
		path := flag(flags, "path", "")
		file := flag(flags, "file", "")
		data, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var out map[string]any
		if err := apiPut("/api/v1/orgs/"+org+"/projects/"+project+"/file", map[string]string{"path": path, "content": string(data)}, &out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return printJSON(out)
	default:
		fmt.Fprintf(os.Stderr, "unknown docs command %q\n", args[0])
		return 2
	}
}

func runPublish(args []string) int {
	flags := parseFlags(args)
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	body := map[string]string{
		"target":  flag(flags, "target", "hosted"),
		"version": flag(flags, "version", "latest"),
	}
	var out map[string]any
	if err := apiPost("/api/v1/orgs/"+org+"/projects/"+project+"/publish", body, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

func runMaintain(args []string) int {
	action := "check"
	rest := args
	if len(args) > 0 && (args[0] == "check" || args[0] == "sync" || args[0] == "explain") {
		action = args[0]
		rest = args[1:]
	}
	flags := parseFlags(rest)
	org, project, err := resolveProject(flags)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var out map[string]any
	if err := apiPost("/api/v1/orgs/"+org+"/projects/"+project+"/maintainer/"+action, map[string]any{}, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return printJSON(out)
}

type creds struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func credsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lorelink", "credentials.json"), nil
}

func saveCreds(url, token string) error {
	path, err := credsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(creds{URL: strings.TrimRight(url, "/"), Token: token}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func loadCreds() (creds, error) {
	path, err := credsPath()
	if err != nil {
		return creds{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return creds{}, fmt.Errorf("not logged in: run lorelink login")
	}
	var c creds
	if err := json.Unmarshal(b, &c); err != nil {
		return creds{}, err
	}
	return c, nil
}

func apiGet(path string, dest any) error {
	c, err := loadCreds()
	if err != nil {
		return err
	}
	return jsonRequest(http.DefaultClient, c.URL, c.Token, "GET", path, nil, dest)
}

func apiPost(path string, body any, dest any) error {
	c, err := loadCreds()
	if err != nil {
		return err
	}
	return jsonRequest(http.DefaultClient, c.URL, c.Token, "POST", path, body, dest)
}

func apiPut(path string, body any, dest any) error {
	c, err := loadCreds()
	if err != nil {
		return err
	}
	return jsonRequest(http.DefaultClient, c.URL, c.Token, "PUT", path, body, dest)
}

func jsonRequest(client *http.Client, base, token, method, path string, body any, dest any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimRight(base, "/")+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %s", method, path, strings.TrimSpace(string(data)))
	}
	if dest == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, dest)
}

func resolveOrg(flags map[string]string) (string, error) {
	if v := flag(flags, "org", os.Getenv("LORELINK_ORG")); v != "" {
		return v, nil
	}
	var out struct {
		Organisations []struct {
			ID string `json:"id"`
		} `json:"organisations"`
	}
	if err := apiGet("/api/v1/orgs", &out); err != nil {
		return "", err
	}
	if len(out.Organisations) == 0 {
		return "", fmt.Errorf("no organisations")
	}
	return out.Organisations[0].ID, nil
}

func resolveProject(flags map[string]string) (string, string, error) {
	org, err := resolveOrg(flags)
	if err != nil {
		return "", "", err
	}
	if v := flag(flags, "project", os.Getenv("LORELINK_PROJECT")); v != "" {
		return org, v, nil
	}
	return "", "", fmt.Errorf("--project is required")
}

func parseFlags(args []string) map[string]string {
	out := map[string]string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "--") {
			continue
		}
		key := strings.TrimPrefix(a, "--")
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			out[key] = args[i+1]
			i++
			continue
		}
		out[key] = "true"
	}
	return out
}

func flag(m map[string]string, key, fallback string) string {
	if v := strings.TrimSpace(m[key]); v != "" {
		return v
	}
	return fallback
}

func printJSON(v any) int {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
