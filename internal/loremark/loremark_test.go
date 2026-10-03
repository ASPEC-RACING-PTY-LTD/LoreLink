package loremark

import "testing"

func TestParseBasics(t *testing.T) {
	doc := Parse("---\ntitle: Hello\n---\n# Hello\n\nA **bold** paragraph.\n\n- one\n- two\n\n:::note\nCareful\n:::\n\n```go\nfmt.Println(1)\n```\n")
	if doc.Title != "Hello" {
		t.Fatalf("title %q", doc.Title)
	}
	if len(doc.Headings) != 1 || doc.Headings[0].ID != "hello" {
		t.Fatalf("headings %+v", doc.Headings)
	}
	if !contains(doc.HTML, "<strong>bold</strong>") {
		t.Fatalf("html %s", doc.HTML)
	}
	if !contains(doc.HTML, "callout-note") {
		t.Fatalf("missing callout: %s", doc.HTML)
	}
	if contains(doc.HTML, "<script") {
		t.Fatal("script leaked")
	}
}

func TestRejectsJavascript(t *testing.T) {
	doc := Parse("[x](javascript:alert(1))")
	if contains(doc.HTML, "javascript") {
		t.Fatalf("unsafe url: %s", doc.HTML)
	}
}

func TestGeneratedReplace(t *testing.T) {
	src := "# API\n\n<!-- lorelink:generated:start:openapi -->\nold\n<!-- lorelink:generated:end:openapi -->\n"
	out := ReplaceGenerated(src, "openapi", "new body")
	if !contains(out, "new body") || contains(out, "old") {
		t.Fatalf("%s", out)
	}
}

func TestSerializeRoundTrip(t *testing.T) {
	src := "# Title\n\nHello world.\n\n- a\n- b\n"
	doc := Parse(src)
	again := Parse(Serialize(doc.Blocks))
	if again.Title != "Title" {
		t.Fatalf("round trip title %q", again.Title)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || (len(s) > 0 && (indexOf(s, sub) >= 0)))
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
