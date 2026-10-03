package connector

import "testing"

func TestEqualMAC(t *testing.T) {
	secret := []byte("whsec")
	body := []byte(`{"ref":"refs/heads/main"}`)
	sig := HMACSHA256Hex(secret, body)
	if !EqualMAC(secret, body, sig) {
		t.Fatal("plain hex should verify")
	}
	if !EqualMAC(secret, body, "sha256="+sig) {
		t.Fatal("sha256 prefix should verify")
	}
	if EqualMAC(secret, body, "deadbeef") {
		t.Fatal("wrong signature accepted")
	}
}
