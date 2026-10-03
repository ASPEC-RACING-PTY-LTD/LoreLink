package aspecmod

import (
	"strings"
	"testing"
)

func TestGenerateAndHashKey(t *testing.T) {
	parts, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parts.Key, DefaultKeyPrefix) {
		t.Fatalf("prefix: %s", parts.Key)
	}
	if parts.PublicID == "" || parts.Secret == "" || len(parts.Checksum) != 6 {
		t.Fatalf("incomplete key parts: %+v", parts)
	}
	pepper := PepperFromInstanceKey([]byte("0123456789abcdef0123456789abcdef"))
	a := HashKey(pepper, parts.Key)
	b := HashKey(pepper, parts.Key)
	if a != b || !HashesEqual(a, b) {
		t.Fatal("hash must be deterministic")
	}
	if HashesEqual(a, HashKey(pepper, "other")) {
		t.Fatal("different keys must not hash equal")
	}
	if got := ParsePublicID(parts.Key); got != parts.PublicID {
		t.Fatalf("public id: got %s want %s", got, parts.PublicID)
	}
}
