package genericgit

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"lorelink.dev/lorelink/internal/connector"
	"lorelink.dev/lorelink/internal/gitx"
)

type Connector struct{}

func New() Connector { return Connector{} }

func (Connector) Name() connector.Provider { return connector.Generic }

func (Connector) Capabilities() connector.Capabilities {
	return connector.Capabilities{Webhooks: false, Listing: false, Polling: true}
}

func (c Connector) Test(ctx context.Context, conn connector.Connection) error {
	if strings.TrimSpace(conn.BaseURL) == "" {
		return connector.ErrAuth
	}
	_, err := gitx.Run(ctx, "", "ls-remote", "--heads", cloneURL(conn))
	return err
}

func (c Connector) ListRepos(_ context.Context, conn connector.Connection) ([]connector.Repo, error) {
	if strings.TrimSpace(conn.BaseURL) == "" {
		return nil, nil
	}
	return []connector.Repo{{
		FullName:      repoName(conn.BaseURL),
		CloneURL:      conn.BaseURL,
		DefaultBranch: "main",
	}}, nil
}

func (c Connector) HeadSHA(ctx context.Context, conn connector.Connection, _ string, branch string) (string, error) {
	if branch == "" {
		branch = "main"
	}
	res, err := gitx.Run(ctx, "", "ls-remote", cloneURL(conn), "refs/heads/"+branch)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(res.Stdout)
	if len(fields) == 0 {
		return "", nil
	}
	return fields[0], nil
}

func (c Connector) RegisterWebhook(context.Context, connector.Connection, string, string, string) (connector.WebhookResult, error) {
	return connector.WebhookResult{PollFallback: true}, nil
}

func (c Connector) UnregisterWebhook(context.Context, connector.Connection, string, string) error {
	return nil
}

func (c Connector) ParsePush(r *http.Request, body []byte, secret []byte) (*connector.PushEvent, error) {
	if len(secret) > 0 {
		sig := r.Header.Get("X-LoreLink-Signature")
		if sig == "" {
			sig = r.Header.Get("X-Hub-Signature-256")
		}
		if !connector.EqualMAC(secret, body, sig) {
			return nil, connector.ErrAuth
		}
	}
	var payload struct {
		Ref    string `json:"ref"`
		After  string `json:"after"`
		Clone  string `json:"clone_url"`
		Repo   struct {
			FullName      string `json:"full_name"`
			CloneURL      string `json:"clone_url"`
			DefaultBranch string `json:"default_branch"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	clone := firstNonEmpty(payload.Repo.CloneURL, payload.Clone)
	return &connector.PushEvent{
		Repo: connector.Repo{
			FullName:      payload.Repo.FullName,
			CloneURL:      clone,
			DefaultBranch: payload.Repo.DefaultBranch,
		},
		Ref:      payload.Ref,
		AfterSHA: payload.After,
	}, nil
}

func cloneURL(conn connector.Connection) string {
	u := conn.BaseURL
	token := conn.Secret.Token
	if token == "" {
		token = conn.Secret.Password
	}
	if token == "" || !strings.HasPrefix(u, "https://") {
		return u
	}
	rest := strings.TrimPrefix(u, "https://")
	if strings.Contains(rest, "@") {
		return u
	}
	user := conn.Secret.Username
	if user == "" {
		user = "x-access-token"
	}
	return "https://" + user + ":" + token + "@" + rest
}

func repoName(u string) string {
	u = strings.TrimSuffix(strings.TrimSpace(u), ".git")
	u = strings.TrimSuffix(u, "/")
	parts := strings.Split(u, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return u
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
