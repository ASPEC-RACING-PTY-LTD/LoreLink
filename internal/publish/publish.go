package publish

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lorelink.dev/lorelink/internal/gitbound"
	"lorelink.dev/lorelink/internal/loremark"
	"lorelink.dev/lorelink/internal/searchidx"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

type Target string

const (
	Hosted     Target = "hosted"
	Filesystem Target = "filesystem"
	Download   Target = "download"
)

type Service struct {
	DataDir string
	Store   *store.Store
	WS      *workspace.Manager
	Index   *searchidx.Indexer
}

func (s *Service) PublishedDir(orgSlug, projectSlug, version string) string {
	return filepath.Join(s.DataDir, "published", orgSlug, projectSlug, version)
}

func (s *Service) Run(ctx context.Context, run store.PublishRun, p *store.Project, orgSlug string) error {
	b, err := s.Store.GetBinding(ctx, p.ID)
	if err != nil {
		return s.fail(ctx, run.ID, err)
	}
	if _, err := s.WS.Sync(ctx, p.ID); err != nil {
		return s.fail(ctx, run.ID, err)
	}
	version := firstNonEmpty(run.VersionName, "latest")
	tree, err := s.WS.Tree(p, b)
	if err != nil {
		return s.fail(ctx, run.ID, err)
	}
	var files []string
	for _, e := range tree {
		if !e.Dir {
			files = append(files, e.Path)
		}
	}
	switch Target(run.Target) {
	case Hosted:
		dest := s.PublishedDir(orgSlug, p.Slug, version)
		if err := os.RemoveAll(dest); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.copyOwned(p, b, dest); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.writeManifest(dest, p, files); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if s.Index != nil {
			_ = s.Index.Reindex(ctx, p.ID, version)
		}
		url := "/view/" + orgSlug + "/" + p.Slug + "/" + version + "/"
		if err := s.Store.FinishPublishRun(ctx, run.ID, "ok", dest, url, ""); err != nil {
			return err
		}
	case Filesystem:
		dest := filepath.Join(s.DataDir, "exports", orgSlug, p.Slug, version)
		if err := os.RemoveAll(dest); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.copyOwned(p, b, dest); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.Store.FinishPublishRun(ctx, run.ID, "ok", dest, "", ""); err != nil {
			return err
		}
	case Download:
		dest := filepath.Join(s.DataDir, "artifacts", run.ID+".zip")
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.zipOwned(p, b, dest); err != nil {
			return s.fail(ctx, run.ID, err)
		}
		if err := s.Store.FinishPublishRun(ctx, run.ID, "ok", dest, "/api/v1/projects/"+p.ID+"/publish/"+run.ID+"/download", ""); err != nil {
			return err
		}
	default:
		return s.fail(ctx, run.ID, fmt.Errorf("unknown publish target %q", run.Target))
	}
	return nil
}

func (s *Service) fail(ctx context.Context, id string, err error) error {
	_ = s.Store.FinishPublishRun(ctx, id, "error", "", "", err.Error())
	return err
}

func (s *Service) copyOwned(p *store.Project, b *store.ProjectBinding, dest string) error {
	ws := s.WS.Path(p.ID)
	for _, root := range s.WS.OwnedRoots(b, p) {
		abs, err := gitbound.CleanOwned(ws, root)
		if err != nil {
			return err
		}
		if _, err := os.Stat(abs); err != nil {
			continue
		}
		err = filepath.Walk(abs, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(ws, path)
			if err != nil {
				return err
			}
			if info.IsDir() {
				return os.MkdirAll(filepath.Join(dest, rel), 0o755)
			}
			return copyFile(path, filepath.Join(dest, rel))
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) zipOwned(p *store.Project, b *store.ProjectBinding, dest string) error {
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	defer zw.Close()
	ws := s.WS.Path(p.ID)
	for _, root := range s.WS.OwnedRoots(b, p) {
		abs, err := gitbound.CleanOwned(ws, root)
		if err != nil {
			return err
		}
		if _, err := os.Stat(abs); err != nil {
			continue
		}
		err = filepath.Walk(abs, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			rel, err := filepath.Rel(ws, path)
			if err != nil {
				return err
			}
			w, err := zw.Create(filepath.ToSlash(rel))
			if err != nil {
				return err
			}
			in, err := os.Open(path)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(w, in)
			_ = in.Close()
			return copyErr
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) writeManifest(dest string, p *store.Project, files []string) error {
	var nav []loremark.NavItem
	for _, f := range files {
		if strings.HasSuffix(f, ".md") {
			nav = append(nav, loremark.NavItem{Title: strings.TrimSuffix(filepath.Base(f), ".md"), Path: f, Slug: loremark.PageSlug(f)})
		}
	}
	raw := fmt.Sprintf("{\"project\":%q,\"generated_at\":%q,\"pages\":%d}\n", p.Slug, time.Now().UTC().Format(time.RFC3339), len(nav))
	return os.WriteFile(filepath.Join(dest, "lorelink.publish.json"), []byte(raw), 0o644)
}

func copyFile(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
