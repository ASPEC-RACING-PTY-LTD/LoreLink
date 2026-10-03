package secrets

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOrCreateInstanceKey(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateInstanceKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != InstanceKeySize {
		t.Fatalf("len=%d", len(first))
	}
	second, err := LoadOrCreateInstanceKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("instance key changed on second load")
	}
	info, err := os.Stat(filepath.Join(dir, InstanceKeyName))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("instance key permissions too open: %v", info.Mode())
	}
}

func TestCipherRoundTrip(t *testing.T) {
	key, err := GenerateInstanceKey()
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("provider-token")
	aad := []byte("secret-id")
	blob, err := c.Encrypt(plain, aad)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Decrypt(blob, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("round trip mismatch")
	}
	if _, err := c.Decrypt(blob, []byte("other")); err == nil {
		t.Fatal("expected aad mismatch")
	}
}
