package gitbound

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCleanOwnedRejectsEscape(t *testing.T) {
	root := t.TempDir()
	if _, err := CleanOwned(root, "../secret"); err != ErrEscape {
		t.Fatalf("want escape, got %v", err)
	}
	if _, err := CleanOwned(root, "/etc/passwd"); err != ErrAbsolute {
		t.Fatalf("want absolute, got %v", err)
	}
	ok, err := CleanOwned(root, "docs/index.md")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(ok) != "index.md" {
		t.Fatalf("got %s", ok)
	}
}

func TestSymlinkRejected(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "docs")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks not available")
	}
	if _, err := AssertOwnedFile(root, "docs/secret"); err != ErrSymlink {
		t.Fatalf("want symlink, got %v", err)
	}
}

func TestWithinAny(t *testing.T) {
	root := t.TempDir()
	if err := WithinAny(root, "docs/a.md", []string{"docs", "generated"}); err != nil {
		t.Fatal(err)
	}
	if err := WithinAny(root, "src/main.go", []string{"docs"}); err != ErrEscape {
		t.Fatalf("want escape, got %v", err)
	}
}
