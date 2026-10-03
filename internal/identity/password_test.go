package identity

import "testing"

func TestPasswordRoundTrip(t *testing.T) {
	t.Parallel()
	hash, salt, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse", hash, salt) {
		t.Fatal("expected match")
	}
	if VerifyPassword("wrong", hash, salt) {
		t.Fatal("expected mismatch")
	}
}
