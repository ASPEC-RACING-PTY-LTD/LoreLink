package codehold

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"lorelink.dev/lorelink/internal/connector"
)

// Connector talks to a CodeHold-compatible Git HTTP API.
// Webhook registration is attempted first; callers treat any registration
// error as a signal to enable poll fallback.
type Connector struct {
	Client *http.Client
}

func New() *Connector {
	return &Connector{Client: &http.Client{Timeout: 20 * time.Second}}
}

func (c *Connector) Name() connector.Provider { return connector.CodeHold }

func (c *Connector) Capabilities() connector.Capabilities {
	return connector.Capabilities{Webhooks: true, Listing: true, Polling: true}
}

func (c *Connector) Test(ctx context.Context, conn connector.Connection) error {
	_, err := c.do(ctx, conn, http.MethodGet, "/api/v1/user", nil)
	return err
}

func (c *Connector) ListRepos(ctx context.Context, conn connector.Connection) ([]connector.Repo, error) {
	body, err := c.do(ctx, conn, http.MethodGet, "/api/v1/user/repos?limit=100", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		FullName      string `json:"full_name"`
		CloneURL      string `json:"clone_url"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	out := make([]connector.Repo, 0, len(raw))
	for _, r := range raw {
		out = append(out, connector.Repo{
			FullName:      r.FullName,
			CloneURL:      r.CloneURL,
			DefaultBranch: firstNonEmpty(r.DefaultBranch, "main"),
			Private:       r.Private,
		})
	}
	return out, nil
}

func (c *Connector) HeadSHA(ctx context.Context, conn connector.Connection, repoFullName, branch string) (string, error) {
	if branch == "" {
		branch = "main"
	}
	path := fmt.Sprintf("/api/v1/repos/%s/branches/%s", repoFullName, branch)
	body, err := c.do(ctx, conn, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	var raw struct {
		Commit struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", err
	}
	return raw.Commit.ID, nil
}

func (c *Connector) RegisterWebhook(ctx context.Context, conn connector.Connection, repoFullName, callbackURL, secret string) (connector.WebhookResult, error) {
	payload := map[string]any{
		"type": "gitea",
		"config": map[string]string{
			"url":          callbackURL,
			"content_type": "json",
			"secret":       secret,
		},
		"events": []string{"push"},
		"active": true,
	}
	path := fmt.Sprintf("/api/v1/repos/%s/hooks", repoFullName)
	body, err := c.do(ctx, conn, http.MethodPost, path, payload)
	if err != nil {
		return connector.WebhookResult{PollFallback: true}, err
	}
	var raw struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return connector.WebhookResult{PollFallback: true}, err
	}
	return connector.WebhookResult{ID: fmt.Sprintf("%d", raw.ID)}, nil
}

func (c *Connector) UnregisterWebhook(ctx context.Context, conn connector.Connection, repoFullName, hookID string) error {
	if hookID == "" {
		return nil
	}
	path := fmt.Sprintf("/api/v1/repos/%s/hooks/%s", repoFullName, hookID)
	_, err := c.do(ctx, conn, http.MethodDelete, path, nil)
	return err
}

func (c *Connector) ParsePush(r *http.Request, body []byte, secret []byte) (*connector.PushEvent, error) {
	if len(secret) > 0 {
		sig := r.Header.Get("X-CodeHold-Signature")
		if sig == "" {
			sig = r.Header.Get("X-Gitea-Signature")
		}
		if sig == "" {
			sig = r.Header.Get("X-Hub-Signature-256")
		}
		if !connector.EqualMAC(secret, body, sig) && !connector.EqualMAC(secret, body, "sha256="+sig) {
			// CodeHold/Gitea often send the raw hex digest.
			if !hmacHexEqual(secret, body, sig) {
				return nil, connector.ErrAuth
			}
		}
	}
	var payload struct {
		Ref   string `json:"ref"`
		After string `json:"after"`
		Repo  struct {
			FullName      string `json:"full_name"`
			CloneURL      string `json:"clone_url"`
			DefaultBranch string `json:"default_branch"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	return &connector.PushEvent{
		Repo: connector.Repo{
			FullName:      payload.Repo.FullName,
			CloneURL:      payload.Repo.CloneURL,
			DefaultBranch: payload.Repo.DefaultBranch,
		},
		Ref:      payload.Ref,
		AfterSHA: payload.After,
	}, nil
}

func hmacHexEqual(secret, body []byte, header string) bool {
	return connector.EqualMAC(secret, body, strings.TrimPrefix(header, "sha256="))
}

func (c *Connector) do(ctx context.Context, conn connector.Connection, method, path string, payload any) ([]byte, error) {
	base := connector.NormalizeBase(conn.BaseURL)
	if base == "" {
		return nil, fmt.Errorf("codehold: base URL is required")
	}
	var rdr io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	token := conn.Secret.Token
	if token == "" {
		token = conn.Secret.Password
	}
	if token != "" {
		req.Header.Set("Authorization", "token "+token)
	}
	client := c.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, connector.ErrAuth
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("codehold: %s %s: %s", method, path, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
