package loremark

import (
	"bytes"
	"encoding/json"
	"html"
	"path"
	"regexp"
	"strings"
	"unicode"
)

var (
	reHeading    = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
	reFence      = regexp.MustCompile("^```([a-zA-Z0-9_-]*)\\s*$")
	reUL         = regexp.MustCompile(`^[-*+]\s+(.+)$`)
	reOL         = regexp.MustCompile(`^\d+\.\s+(.+)$`)
	reCallout    = regexp.MustCompile(`^:::(note|tip|warning|danger|info)\s*(.*)$`)
	reTableRow   = regexp.MustCompile(`^\|(.+)\|$`)
	reFrontMatter = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---\r?\n`)
	reGeneratedStart = regexp.MustCompile(`<!--\s*lorelink:generated:start:([a-zA-Z0-9._-]+)\s*-->`)
	reGeneratedEnd   = regexp.MustCompile(`<!--\s*lorelink:generated:end:([a-zA-Z0-9._-]+)\s*-->`)
	reLink       = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	reImage      = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
	reCode       = regexp.MustCompile("`([^`]+)`")
	reBold       = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reItalic     = regexp.MustCompile(`\*([^*]+)\*`)
	reHTML       = regexp.MustCompile(`(?i)<(script|iframe|object|embed|link|style|meta)`)
)

type Doc struct {
	Title       string            `json:"title"`
	Description string            `json:"description"`
	FrontMatter map[string]string `json:"front_matter,omitempty"`
	HTML        string            `json:"html"`
	Text        string            `json:"text"`
	Headings    []Heading         `json:"headings"`
	Blocks      []Block           `json:"blocks"`
	Raw         string            `json:"-"`
}

type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

type Block struct {
	Type    string   `json:"type"`
	Level   int      `json:"level,omitempty"`
	Lang    string   `json:"lang,omitempty"`
	Text    string   `json:"text,omitempty"`
	Items   []string `json:"items,omitempty"`
	Kind    string   `json:"kind,omitempty"`
	Rows    [][]string `json:"rows,omitempty"`
	ID      string   `json:"id,omitempty"`
}

func Parse(src string) Doc {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	fm := map[string]string{}
	if m := reFrontMatter.FindStringSubmatch(src); m != nil {
		for _, line := range strings.Split(m[1], "\n") {
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			fm[strings.TrimSpace(k)] = strings.TrimSpace(strings.Trim(v, `"'`))
		}
		src = src[len(m[0]):]
	}
	lines := strings.Split(src, "\n")
	var blocks []Block
	var headings []Heading
	var textParts []string
	var out bytes.Buffer
	i := 0
	for i < len(lines) {
		line := lines[i]
		trim := strings.TrimSpace(line)
		if trim == "" {
			i++
			continue
		}
		if reHTML.MatchString(line) {
			i++
			continue
		}
		if m := reCallout.FindStringSubmatch(trim); m != nil {
			kind := m[1]
			var body []string
			i++
			for i < len(lines) && strings.TrimSpace(lines[i]) != ":::" {
				body = append(body, lines[i])
				i++
			}
			if i < len(lines) {
				i++
			}
			content := strings.Join(body, "\n")
			blocks = append(blocks, Block{Type: "callout", Kind: kind, Text: content})
			textParts = append(textParts, content)
			out.WriteString(`<aside class="callout callout-` + kind + `"><p class="callout-label">` + html.EscapeString(strings.ToUpper(kind)) + `</p>` + inline(content) + `</aside>`)
			continue
		}
		if m := reFence.FindStringSubmatch(trim); m != nil {
			lang := m[1]
			var body []string
			i++
			for i < len(lines) && !reFence.MatchString(strings.TrimSpace(lines[i])) {
				body = append(body, lines[i])
				i++
			}
			if i < len(lines) {
				i++
			}
			code := strings.Join(body, "\n")
			blocks = append(blocks, Block{Type: "code", Lang: lang, Text: code})
			textParts = append(textParts, code)
			out.WriteString(`<pre><code class="language-` + html.EscapeString(lang) + `">` + html.EscapeString(code) + `</code></pre>`)
			continue
		}
		if m := reHeading.FindStringSubmatch(trim); m != nil {
			level := len(m[1])
			text := strings.TrimSpace(m[2])
			id := slug(text)
			blocks = append(blocks, Block{Type: "heading", Level: level, Text: text, ID: id})
			headings = append(headings, Heading{Level: level, Text: text, ID: id})
			textParts = append(textParts, text)
			out.WriteString(`<h` + itoa(level) + ` id="` + html.EscapeString(id) + `">` + inline(text) + `</h` + itoa(level) + `>`)
			i++
			continue
		}
		if reTableRow.MatchString(trim) {
			var rows [][]string
			for i < len(lines) && reTableRow.MatchString(strings.TrimSpace(lines[i])) {
				row := parseRow(strings.TrimSpace(lines[i]))
				if !isDivider(row) {
					rows = append(rows, row)
				}
				i++
			}
			blocks = append(blocks, Block{Type: "table", Rows: rows})
			out.WriteString(renderTable(rows))
			continue
		}
		if reUL.MatchString(trim) {
			var items []string
			for i < len(lines) && reUL.MatchString(strings.TrimSpace(lines[i])) {
				items = append(items, reUL.FindStringSubmatch(strings.TrimSpace(lines[i]))[1])
				i++
			}
			blocks = append(blocks, Block{Type: "ul", Items: items})
			textParts = append(textParts, strings.Join(items, " "))
			out.WriteString("<ul>")
			for _, item := range items {
				out.WriteString("<li>" + inline(item) + "</li>")
			}
			out.WriteString("</ul>")
			continue
		}
		if reOL.MatchString(trim) {
			var items []string
			for i < len(lines) && reOL.MatchString(strings.TrimSpace(lines[i])) {
				items = append(items, reOL.FindStringSubmatch(strings.TrimSpace(lines[i]))[1])
				i++
			}
			blocks = append(blocks, Block{Type: "ol", Items: items})
			textParts = append(textParts, strings.Join(items, " "))
			out.WriteString("<ol>")
			for _, item := range items {
				out.WriteString("<li>" + inline(item) + "</li>")
			}
			out.WriteString("</ol>")
			continue
		}
		var para []string
		for i < len(lines) && strings.TrimSpace(lines[i]) != "" && !strings.HasPrefix(strings.TrimSpace(lines[i]), "#") && !reFence.MatchString(strings.TrimSpace(lines[i])) && !reCallout.MatchString(strings.TrimSpace(lines[i])) {
			para = append(para, strings.TrimSpace(lines[i]))
			i++
		}
		text := strings.Join(para, " ")
		blocks = append(blocks, Block{Type: "paragraph", Text: text})
		textParts = append(textParts, text)
		out.WriteString("<p>" + inline(text) + "</p>")
	}
	title := fm["title"]
	if title == "" {
		for _, h := range headings {
			if h.Level == 1 {
				title = h.Text
				break
			}
		}
	}
	return Doc{
		Title:       title,
		Description: fm["description"],
		FrontMatter: fm,
		HTML:        out.String(),
		Text:        strings.Join(textParts, "\n"),
		Headings:    headings,
		Blocks:      blocks,
		Raw:         src,
	}
}

func Render(src string) Doc { return Parse(src) }

func Serialize(blocks []Block) string {
	var b strings.Builder
	for i, block := range blocks {
		if i > 0 {
			b.WriteByte('\n')
		}
		switch block.Type {
		case "heading":
			b.WriteString(strings.Repeat("#", max(block.Level, 1)))
			b.WriteString(" ")
			b.WriteString(block.Text)
			b.WriteByte('\n')
		case "paragraph":
			b.WriteString(block.Text)
			b.WriteByte('\n')
		case "code":
			b.WriteString("```")
			b.WriteString(block.Lang)
			b.WriteByte('\n')
			b.WriteString(block.Text)
			if !strings.HasSuffix(block.Text, "\n") {
				b.WriteByte('\n')
			}
			b.WriteString("```\n")
		case "ul":
			for _, item := range block.Items {
				b.WriteString("- ")
				b.WriteString(item)
				b.WriteByte('\n')
			}
		case "ol":
			for n, item := range block.Items {
				b.WriteString(itoa(n + 1))
				b.WriteString(". ")
				b.WriteString(item)
				b.WriteByte('\n')
			}
		case "callout":
			b.WriteString(":::")
			b.WriteString(firstNonEmpty(block.Kind, "note"))
			b.WriteByte('\n')
			b.WriteString(block.Text)
			if !strings.HasSuffix(block.Text, "\n") {
				b.WriteByte('\n')
			}
			b.WriteString(":::\n")
		case "table":
			for _, row := range block.Rows {
				b.WriteString("| ")
				b.WriteString(strings.Join(row, " | "))
				b.WriteString(" |\n")
			}
		default:
			if block.Text != "" {
				b.WriteString(block.Text)
				b.WriteByte('\n')
			}
		}
	}
	return b.String()
}

func ReplaceGenerated(src, id, inner string) string {
	start := "<!-- lorelink:generated:start:" + id + " -->"
	end := "<!-- lorelink:generated:end:" + id + " -->"
	block := start + "\n" + strings.TrimSpace(inner) + "\n" + end
	starts := reGeneratedStart.FindAllStringSubmatchIndex(src, -1)
	for _, loc := range starts {
		if len(loc) < 4 {
			continue
		}
		foundID := src[loc[2]:loc[3]]
		if foundID != id {
			continue
		}
		rest := src[loc[1]:]
		endLoc := reGeneratedEnd.FindStringSubmatchIndex(rest)
		if endLoc == nil || rest[endLoc[2]:endLoc[3]] != id {
			return src[:loc[0]] + block + rest
		}
		return src[:loc[0]] + block + rest[endLoc[1]:]
	}
	if strings.TrimSpace(src) == "" {
		return block + "\n"
	}
	return strings.TrimRight(src, "\n") + "\n\n" + block + "\n"
}

func GeneratedIDs(src string) []string {
	matches := reGeneratedStart.FindAllStringSubmatch(src, -1)
	var out []string
	for _, m := range matches {
		out = append(out, m[1])
	}
	return out
}

func PageSlug(rel string) string {
	rel = strings.TrimSuffix(filepathToSlash(rel), ".md")
	rel = strings.TrimSuffix(rel, "/index")
	if rel == "index" || rel == "" {
		return ""
	}
	return rel
}

func NavFromTree(paths []string, docsRoot string) []NavItem {
	docsRoot = strings.Trim(filepathToSlash(docsRoot), "/")
	var pages []string
	for _, p := range paths {
		p = filepathToSlash(p)
		if docsRoot != "" && !strings.HasPrefix(p, docsRoot+"/") && p != docsRoot {
			continue
		}
		if !strings.HasSuffix(p, ".md") {
			continue
		}
		pages = append(pages, p)
	}
	var out []NavItem
	for _, p := range pages {
		rel := p
		if docsRoot != "" {
			rel = strings.TrimPrefix(p, docsRoot+"/")
		}
		title := strings.TrimSuffix(path.Base(rel), ".md")
		title = strings.ReplaceAll(title, "-", " ")
		out = append(out, NavItem{Title: title, Path: rel, Slug: PageSlug(rel)})
	}
	return out
}

type NavItem struct {
	Title string `json:"title"`
	Path  string `json:"path"`
	Slug  string `json:"slug"`
}

func ConfigFromYAML(raw string) map[string]any {
	out := map[string]any{}
	if raw == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	if len(out) > 0 {
		return out
	}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(strings.Trim(v, `"'`))
	}
	return out
}

func inline(s string) string {
	s = html.EscapeString(s)
	s = reImage.ReplaceAllStringFunc(s, func(m string) string {
		sub := reImage.FindStringSubmatch(m)
		if !safeURL(html.UnescapeString(sub[2])) {
			return html.EscapeString(sub[1])
		}
		return `<img src="` + html.EscapeString(html.UnescapeString(sub[2])) + `" alt="` + sub[1] + `">`
	})
	s = reLink.ReplaceAllStringFunc(s, func(m string) string {
		sub := reLink.FindStringSubmatch(m)
		href := html.UnescapeString(sub[2])
		if !safeURL(href) {
			return sub[1]
		}
		return `<a href="` + html.EscapeString(href) + `">` + sub[1] + `</a>`
	})
	s = reCode.ReplaceAllString(s, "<code>$1</code>")
	s = reBold.ReplaceAllString(s, "<strong>$1</strong>")
	s = reItalic.ReplaceAllString(s, "<em>$1</em>")
	return s
}

func safeURL(u string) bool {
	u = strings.TrimSpace(u)
	if u == "" {
		return false
	}
	lu := strings.ToLower(u)
	if strings.Contains(lu, "javascript:") || strings.Contains(lu, "data:") {
		return false
	}
	return strings.HasPrefix(lu, "/") || strings.HasPrefix(lu, "#") || strings.HasPrefix(lu, "https://") || strings.HasPrefix(lu, "http://") || !strings.Contains(lu, ":")
}

func parseRow(line string) []string {
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func isDivider(row []string) bool {
	if len(row) == 0 {
		return false
	}
	for _, c := range row {
		c = strings.TrimSpace(strings.ReplaceAll(c, ":", ""))
		c = strings.ReplaceAll(c, "-", "")
		if c != "" {
			return false
		}
	}
	return true
}

func renderTable(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<table><thead><tr>")
	for _, c := range rows[0] {
		b.WriteString("<th>" + inline(c) + "</th>")
	}
	b.WriteString("</tr></thead><tbody>")
	for _, row := range rows[1:] {
		b.WriteString("<tr>")
		for _, c := range row {
			b.WriteString("<td>" + inline(c) + "</td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return b.String()
}

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevDash = false
			continue
		}
		if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func filepathToSlash(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}
