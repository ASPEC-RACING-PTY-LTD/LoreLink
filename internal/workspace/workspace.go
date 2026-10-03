package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"lorelink.dev/lorelink/internal/connector"
	"lorelink.dev/lorelink/internal/gitbound"
	"lorelink.dev/lorelink/internal/gitx"
	"lorelink.dev/lorelink/internal/loremark"
	"lorelink.dev/lorelink/internal/secrets"
	"lorelink.dev/lorelink/internal/store"
)

type Manager struct {
	DataDir string
	Store   *store.Store
	Cipher  *secrets.Cipher
	Reg     *connector.Registry
}

func (m *Manager) Path(projectID string) string {
	return filepath.Join(m.DataDir, "workspaces", projectID)
}

func (m *Manager) OwnedRoots(b *store.ProjectBinding, p *store.Project) []string {
	roots := []string{firstNonEmpty(b.DocsRoot, p.DocsRoot, "docs")}
	roots = append(roots, b.GeneratedRoots...)
	return roots
}

func (m *Manager) DecryptSecret(conn *store.GitConnection) (connector.Secret, error) {
	var sec connector.Secret
	if len(conn.SecretCiphertext) == 0 {
		return sec, nil
	}
	plain, err := m.Cipher.Decrypt(conn.SecretCiphertext, []byte(conn.ID))
	if err != nil {
		return sec, err
	}
	if err := json.Unmarshal(plain, &sec); err != nil {
		return sec, err
	}
	return sec, nil
}

func (m *Manager) EncryptSecret(connID string, sec connector.Secret) ([]byte, error) {
	b, err := json.Marshal(sec)
	if err != nil {
		return nil, err
	}
	return m.Cipher.Encrypt(b, []byte(connID))
}

func (m *Manager) LiveConn(conn *store.GitConnection) (connector.Connection, error) {
	sec, err := m.DecryptSecret(conn)
	if err != nil {
		return connector.Connection{}, err
	}
	return connector.Connection{
		ID:       conn.ID,
		Provider: connector.Provider(conn.Provider),
		BaseURL:  conn.BaseURL,
		AuthKind: conn.AuthKind,
		Secret:   sec,
	}, nil
}

func (m *Manager) Token(sec connector.Secret) string {
	if sec.Token != "" {
		return sec.Token
	}
	return sec.Password
}

func (m *Manager) Sync(ctx context.Context, projectID string) (string, error) {
	p, err := m.Store.GetProject(ctx, projectID)
	if err != nil {
		return "", err
	}
	b, err := m.Store.GetBinding(ctx, projectID)
	if err != nil {
		return "", err
	}
	conn, err := m.Store.GetConnection(ctx, b.ConnectionID)
	if err != nil {
		return "", err
	}
	live, err := m.LiveConn(conn)
	if err != nil {
		return "", err
	}
	ws := m.Path(projectID)
	b.WorkspaceRelpath = filepath.Join("workspaces", projectID)
	if err := gitx.EnsureRepo(ctx, ws, b.RepoURL, firstNonEmpty(b.DefaultBranch, p.DefaultBranch), m.Token(live.Secret)); err != nil {
		_ = m.Store.UpdateBindingSync(ctx, projectID, b.LastSyncedSHA, "error", err.Error())
		return "", err
	}
	sha, err := gitx.HeadSHA(ctx, ws)
	if err != nil {
		_ = m.Store.UpdateBindingSync(ctx, projectID, "", "error", err.Error())
		return "", err
	}
	if err := m.Store.UpdateBindingSync(ctx, projectID, sha, "ready", ""); err != nil {
		return "", err
	}
	return sha, nil
}

func (m *Manager) LoadConfig(p *store.Project) map[string]any {
	ws := m.Path(p.ID)
	for _, name := range []string{"lorelink.yml", "lorelink.yaml"} {
		raw, err := os.ReadFile(filepath.Join(ws, name))
		if err != nil {
			continue
		}
		cfg := loremark.ConfigFromYAML(string(raw))
		if docs, ok := cfg["docs_root"].(string); ok && strings.TrimSpace(docs) != "" {
			p.DocsRoot = strings.TrimSpace(docs)
		}
		if branch, ok := cfg["default_branch"].(string); ok && strings.TrimSpace(branch) != "" {
			p.DefaultBranch = strings.TrimSpace(branch)
		}
		return cfg
	}
	return map[string]any{}
}

func (m *Manager) DocsRoot(p *store.Project, b *store.ProjectBinding) string {
	m.LoadConfig(p)
	rel := firstNonEmpty(b.DocsRoot, p.DocsRoot, "docs")
	return filepath.Join(m.Path(p.ID), filepath.FromSlash(rel))
}

func (m *Manager) ReadOwned(p *store.Project, b *store.ProjectBinding, rel string) ([]byte, error) {
	ws := m.Path(p.ID)
	if err := gitbound.WithinAny(ws, rel, m.OwnedRoots(b, p)); err != nil {
		return nil, err
	}
	full, err := gitbound.AssertOwnedFile(ws, rel)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(full)
}

func (m *Manager) WriteOwned(p *store.Project, b *store.ProjectBinding, rel string, data []byte) error {
	ws := m.Path(p.ID)
	if err := gitbound.WithinAny(ws, rel, m.OwnedRoots(b, p)); err != nil {
		return err
	}
	full, err := gitbound.AssertOwnedFile(ws, rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, data, 0o644)
}

func (m *Manager) DeleteOwned(p *store.Project, b *store.ProjectBinding, rel string) error {
	ws := m.Path(p.ID)
	if err := gitbound.WithinAny(ws, rel, m.OwnedRoots(b, p)); err != nil {
		return err
	}
	full, err := gitbound.AssertOwnedFile(ws, rel)
	if err != nil {
		return err
	}
	return os.Remove(full)
}

type TreeEntry struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Bytes int64  `json:"bytes,omitempty"`
}

func (m *Manager) Tree(p *store.Project, b *store.ProjectBinding) ([]TreeEntry, error) {
	m.LoadConfig(p)
	ws := m.Path(p.ID)
	var out []TreeEntry
	for _, root := range m.OwnedRoots(b, p) {
		abs, err := gitbound.CleanOwned(ws, root)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(abs); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(ws, path)
			if err != nil {
				return err
			}
			slash := filepath.ToSlash(rel)
			if slash == "." {
				return nil
			}
			if d.IsDir() && (d.Name() == ".git" || strings.HasPrefix(d.Name(), ".")) {
				return fs.SkipDir
			}
			info, _ := d.Info()
			var size int64
			if info != nil && !d.IsDir() {
				size = info.Size()
			}
			out = append(out, TreeEntry{Path: slash, Name: d.Name(), Dir: d.IsDir(), Bytes: size})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (m *Manager) CommitAndPush(ctx context.Context, p *store.Project, b *store.ProjectBinding, message, author, email string) (string, error) {
	ws := m.Path(p.ID)
	sha, err := gitx.CommitAll(ctx, ws, message, author, email)
	if err != nil {
		return "", err
	}
	if err := gitx.Push(ctx, ws, firstNonEmpty(b.DefaultBranch, p.DefaultBranch)); err != nil {
		return sha, fmt.Errorf("saved locally but push failed: %w", err)
	}
	_ = m.Store.UpdateBindingSync(ctx, p.ID, sha, "ready", "")
	return sha, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
