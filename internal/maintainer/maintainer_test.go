package maintainer

import "testing"

func TestExtractOpenAPI(t *testing.T) {
	raw := []byte(`{"info":{"title":"Pets"},"paths":{"/pets":{"get":{"summary":"list pets"}}}}`)
	ir, err := Extract("openapi", "openapi.json", raw)
	if err != nil {
		t.Fatal(err)
	}
	if ir.Title != "Pets" || len(ir.Items) != 1 || ir.Items[0].Name != "/pets" {
		t.Fatalf("%+v", ir)
	}
	body := RenderIR(ir)
	if body == "" || !contains(body, "/pets") {
		t.Fatalf("render %s", body)
	}
}

func TestExtractGo(t *testing.T) {
	raw := []byte("package p\nfunc Hello() {}\ntype Thing struct{}\n")
	ir, err := Extract("go", "doc.go", raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ir.Items) < 2 {
		t.Fatalf("%+v", ir)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
