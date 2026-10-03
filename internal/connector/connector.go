package connector

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
)

var (
	ErrUnsupported = errors.New("connector: unsupported provider")
	ErrAuth        = errors.New("connector: authentication failed")
)

type Provider string

const (
	Generic  Provider = "generic"
	CodeHold Provider = "codehold"
	GitHub   Provider = "github"
)

type Capabilities struct {
	Webhooks bool `json:"webhooks"`
	Listing  bool `json:"listing"`
	Polling  bool `json:"polling"`
}

type Secret struct {
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type Connection struct {
	ID       string
	Provider Provider
	BaseURL  string
	AuthKind string
	Secret   Secret
}

type Repo struct {
	FullName      string `json:"full_name"`
	CloneURL      string `json:"clone_url"`
	DefaultBranch string `json:"default_branch"`
	Private       bool   `json:"private"`
}

type WebhookResult struct {
	ID           string
	PollFallback bool
}

type PushEvent struct {
	Repo     Repo
	Ref      string
	AfterSHA string
}

type Connector interface {
	Name() Provider
	Capabilities() Capabilities
	Test(ctx context.Context, conn Connection) error
	ListRepos(ctx context.Context, conn Connection) ([]Repo, error)
	HeadSHA(ctx context.Context, conn Connection, repoFullName, branch string) (string, error)
	RegisterWebhook(ctx context.Context, conn Connection, repoFullName, callbackURL, secret string) (WebhookResult, error)
	UnregisterWebhook(ctx context.Context, conn Connection, repoFullName, hookID string) error
	ParsePush(r *http.Request, body []byte, secret []byte) (*PushEvent, error)
}

type Registry struct {
	providers map[Provider]Connector
}

func NewRegistry(items ...Connector) *Registry {
	r := &Registry{providers: map[Provider]Connector{}}
	for _, item := range items {
		r.providers[item.Name()] = item
	}
	return r
}

func (r *Registry) Get(name string) (Connector, error) {
	c, ok := r.providers[Provider(strings.ToLower(strings.TrimSpace(name)))]
	if !ok {
		return nil, ErrUnsupported
	}
	return c, nil
}

func (r *Registry) All() []Connector {
	out := make([]Connector, 0, len(r.providers))
	for _, c := range r.providers {
		out = append(out, c)
	}
	return out
}

func NormalizeBase(url string) string {
	return strings.TrimRight(strings.TrimSpace(url), "/")
}

func HMACSHA256Hex(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func EqualMAC(secret, body []byte, header string) bool {
	header = strings.TrimSpace(header)
	header = strings.TrimPrefix(header, "sha256=")
	want, err := hex.DecodeString(header)
	if err != nil || len(want) == 0 {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}
