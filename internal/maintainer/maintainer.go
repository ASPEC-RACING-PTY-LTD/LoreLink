package maintainer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"lorelink.dev/lorelink/internal/loremark"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

type Service struct {
	Store *store.Store
	WS    *workspace.Manager
}

type IR struct {
	Kind    string   `json:"kind"`
	Title   string   `json:"title"`
	Source  string   `json:"source"`
	Items   []IRItem `json:"items"`
}

type IRItem struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Description string   `json:"description,omitempty"`
	Path        string   `json:"path,omitempty"`
	Children    []IRItem `json:"children,omitempty"`
}

type Finding struct {
	Level   string `json:"level"`
	Mapping string `json:"mapping"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
}

type Report struct {
	Enabled  bool       `json:"enabled"`
	Findings []Finding  `json:"findings"`
	Coverage Coverage   `json:"coverage"`
	Explain  []Explain  `json:"explain,omitempty"`
}

type Coverage struct {
	Mappings int `json:"mappings"`
	Sources  int `json:"sources"`
	Outputs  int `json:"outputs"`
	Drift    int `json:"drift"`
}

type Explain struct {
	Output  string `json:"output"`
	Source  string `json:"source"`
	Excerpt string `json:"excerpt"`
}

func (s *Service) Check(ctx context.Context, projectID string) (Report, error) {
	return s.run(ctx, projectID, false, false)
}

func (s *Service) Sync(ctx context.Context, projectID string) (Report, error) {
	return s.run(ctx, projectID, true, false)
}

func (s *Service) Explain(ctx context.Context, projectID string) (Report, error) {
	return s.run(ctx, projectID, false, true)
}

func (s *Service) run(ctx context.Context, projectID string, write, explain bool) (Report, error) {
	mappings, err := s.Store.ListMappings(ctx, projectID)
	if err != nil {
		return Report{}, err
	}
	rep := Report{Enabled: len(mappings) > 0}
	if len(mappings) == 0 {
		return rep, nil
	}
	p, err := s.Store.GetProject(ctx, projectID)
	if err != nil {
		return Report{}, err
	}
	b, err := s.Store.GetBinding(ctx, projectID)
	if err != nil {
		return Report{}, err
	}
	tree, err := s.WS.Tree(p, b)
	if err != nil {
		return Report{}, err
	}
	var paths []string
	for _, e := range tree {
		if !e.Dir {
			paths = append(paths, e.Path)
		}
	}
	rep.Coverage.Mappings = len(mappings)
	for _, m := range mappings {
		matches := matchPaths(paths, m.SourceMatch)
		if len(matches) == 0 {
			rep.Findings = append(rep.Findings, Finding{Level: "warning", Mapping: m.ID, Message: "no sources matched " + m.SourceMatch})
			continue
		}
		for _, src := range matches {
			raw, err := s.WS.ReadOwned(p, b, src)
			if err != nil {
				rep.Findings = append(rep.Findings, Finding{Level: "error", Mapping: m.ID, Message: err.Error(), Path: src})
				continue
			}
			rep.Coverage.Sources++
			ir, err := Extract(m.Extractor, src, raw)
			if err != nil {
				rep.Findings = append(rep.Findings, Finding{Level: "error", Mapping: m.ID, Message: err.Error(), Path: src})
				continue
			}
			sum := sha256.Sum256(raw)
			irJSON, _ := json.Marshal(ir)
			_ = s.Store.UpsertSnapshot(ctx, store.MaintainerSnapshot{
				ProjectID:  projectID,
				SourcePath: src,
				SourceSHA:  hex.EncodeToString(sum[:]),
				IRJSON:     irJSON,
			})
			body := RenderIR(ir)
			outPath := expandOutput(m.Output, src)
			existing, readErr := s.WS.ReadOwned(p, b, outPath)
			current := ""
			if readErr == nil {
				current = string(existing)
			}
			next := loremark.ReplaceGenerated(current, slugID(src), body)
			if current != next {
				rep.Coverage.Drift++
				rep.Findings = append(rep.Findings, Finding{Level: "info", Mapping: m.ID, Message: "generated region drifted", Path: outPath})
				if write {
					if err := s.WS.WriteOwned(p, b, outPath, []byte(next)); err != nil {
						rep.Findings = append(rep.Findings, Finding{Level: "error", Mapping: m.ID, Message: err.Error(), Path: outPath})
					} else {
						rep.Coverage.Outputs++
					}
				}
			} else {
				rep.Coverage.Outputs++
			}
			if explain {
				rep.Explain = append(rep.Explain, Explain{Output: outPath, Source: src, Excerpt: trimExcerpt(body)})
			}
		}
	}
	return rep, nil
}

func Extract(kind, path string, raw []byte) (IR, error) {
	switch strings.ToLower(kind) {
	case "openapi":
		return extractOpenAPI(path, raw)
	case "jsonschema", "json-schema":
		return extractJSONSchema(path, raw)
	case "cli", "cli-help":
		return extractCLI(path, raw)
	case "go", "go-symbols":
		return extractGo(path, raw)
	default:
		return IR{}, fmt.Errorf("unknown extractor %q", kind)
	}
}

func extractOpenAPI(path string, raw []byte) (IR, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return extractOpenAPILoose(path, string(raw)), nil
	}
	ir := IR{Kind: "openapi", Title: stringVal(doc["info"], "title"), Source: path}
	if ir.Title == "" {
		ir.Title = filepath.Base(path)
	}
	if paths, ok := doc["paths"].(map[string]any); ok {
		keys := keysOf(paths)
		sort.Strings(keys)
		for _, p := range keys {
			methods, _ := paths[p].(map[string]any)
			mk := keysOf(methods)
			sort.Strings(mk)
			item := IRItem{Name: p, Kind: "path"}
			for _, method := range mk {
				if method == "parameters" || method == "summary" {
					continue
				}
				op, _ := methods[method].(map[string]any)
				item.Children = append(item.Children, IRItem{
					Name:        strings.ToUpper(method),
					Kind:        "operation",
					Description: asString(op["summary"]),
				})
			}
			ir.Items = append(ir.Items, item)
		}
	}
	return ir, nil
}

func extractOpenAPILoose(path, src string) IR {
	ir := IR{Kind: "openapi", Title: filepath.Base(path), Source: path}
	for _, line := range strings.Split(src, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/") && strings.HasSuffix(line, ":") {
			ir.Items = append(ir.Items, IRItem{Name: strings.TrimSuffix(line, ":"), Kind: "path"})
		}
	}
	return ir
}

func extractJSONSchema(path string, raw []byte) (IR, error) {
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	ir := IR{Kind: "jsonschema", Title: firstNonEmpty(asString(doc["title"]), filepath.Base(path)), Source: path}
	if props, ok := doc["properties"].(map[string]any); ok {
		keys := keysOf(props)
		sort.Strings(keys)
		for _, k := range keys {
			prop, _ := props[k].(map[string]any)
			ir.Items = append(ir.Items, IRItem{Name: k, Kind: asString(prop["type"]), Description: asString(prop["description"])})
		}
	}
	return ir, nil
}

func extractCLI(path string, raw []byte) (IR, error) {
	ir := IR{Kind: "cli", Title: filepath.Base(path), Source: path}
	for _, line := range strings.Split(string(raw), "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "-") || strings.HasPrefix(trim, "Commands:") {
			ir.Items = append(ir.Items, IRItem{Name: trim, Kind: "flag"})
		}
	}
	return ir, nil
}

func extractGo(path string, raw []byte) (IR, error) {
	ir := IR{Kind: "go", Title: filepath.Base(path), Source: path}
	for _, line := range strings.Split(string(raw), "\n") {
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "func "):
			name := strings.TrimPrefix(trim, "func ")
			if i := strings.IndexAny(name, "({"); i > 0 {
				name = strings.TrimSpace(name[:i])
			}
			ir.Items = append(ir.Items, IRItem{Name: name, Kind: "func"})
		case strings.HasPrefix(trim, "type "):
			parts := strings.Fields(trim)
			if len(parts) >= 2 {
				ir.Items = append(ir.Items, IRItem{Name: parts[1], Kind: "type"})
			}
		}
	}
	return ir, nil
}

func RenderIR(ir IR) string {
	var b strings.Builder
	b.WriteString("## ")
	b.WriteString(ir.Title)
	b.WriteString("\n\n")
	if len(ir.Items) == 0 {
		b.WriteString("No extracted symbols.\n")
		return b.String()
	}
	b.WriteString("| Name | Kind | Description |\n| --- | --- | --- |\n")
	var walk func(items []IRItem, prefix string)
	walk = func(items []IRItem, prefix string) {
		for _, item := range items {
			name := prefix + item.Name
			b.WriteString("| `")
			b.WriteString(strings.ReplaceAll(name, "|", "\\|"))
			b.WriteString("` | ")
			b.WriteString(item.Kind)
			b.WriteString(" | ")
			b.WriteString(strings.ReplaceAll(item.Description, "|", "\\|"))
			b.WriteString(" |\n")
			if len(item.Children) > 0 {
				walk(item.Children, name+" ")
			}
		}
	}
	walk(ir.Items, "")
	return b.String()
}

func matchPaths(paths []string, pattern string) []string {
	pattern = strings.ReplaceAll(pattern, "\\", "/")
	var out []string
	for _, p := range paths {
		slash := strings.ReplaceAll(p, "\\", "/")
		ok, _ := filepath.Match(pattern, slash)
		if !ok {
			ok, _ = filepath.Match(pattern, filepath.Base(slash))
		}
		if ok || strings.HasSuffix(slash, strings.TrimPrefix(pattern, "**/")) {
			out = append(out, p)
		}
	}
	return out
}

func expandOutput(tpl, src string) string {
	base := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	out := strings.ReplaceAll(tpl, "{stem}", base)
	out = strings.ReplaceAll(out, "{name}", filepath.Base(src))
	out = strings.ReplaceAll(out, "{path}", src)
	return out
}

func slugID(src string) string {
	src = strings.ReplaceAll(src, "/", "-")
	src = strings.ReplaceAll(src, "\\", "-")
	src = strings.ReplaceAll(src, ".", "-")
	return src
}

func trimExcerpt(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func stringVal(v any, key string) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	return asString(m[key])
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
