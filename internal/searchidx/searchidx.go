package searchidx

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"lorelink.dev/lorelink/internal/loremark"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

type Indexer struct {
	Store *store.Store
	WS    *workspace.Manager
}

func (x *Indexer) Reindex(ctx context.Context, projectID, version string) error {
	if version == "" {
		version = "latest"
	}
	p, err := x.Store.GetProject(ctx, projectID)
	if err != nil {
		return err
	}
	b, err := x.Store.GetBinding(ctx, projectID)
	if err != nil {
		return err
	}
	if err := x.Store.ClearSearch(ctx, projectID, version); err != nil {
		return err
	}
	tree, err := x.WS.Tree(p, b)
	if err != nil {
		return err
	}
	for _, entry := range tree {
		if entry.Dir || !strings.HasSuffix(entry.Path, ".md") {
			continue
		}
		raw, err := x.WS.ReadOwned(p, b, entry.Path)
		if err != nil {
			continue
		}
		doc := loremark.Parse(string(raw))
		var heads []string
		for _, h := range doc.Headings {
			heads = append(heads, h.Text)
		}
		title := doc.Title
		if title == "" {
			title = filepath.Base(entry.Path)
		}
		if err := x.Store.UpsertSearchDocument(ctx, store.SearchDocument{
			ProjectID:   projectID,
			VersionName: version,
			Path:        entry.Path,
			Title:       title,
			Headings:    strings.Join(heads, " "),
			Body:        doc.Text,
			Keywords:    strings.Join(keywordValues(doc.FrontMatter), " "),
		}); err != nil {
			return err
		}
	}
	return nil
}

func keywordValues(fm map[string]string) []string {
	if fm == nil {
		return nil
	}
	var out []string
	for _, k := range []string{"keywords", "tags"} {
		if v := fm[k]; v != "" {
			out = append(out, v)
		}
	}
	return out
}

func LoadFile(_ context.Context, path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
