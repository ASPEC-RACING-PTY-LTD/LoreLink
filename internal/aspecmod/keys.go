// Package aspecmod ports the copied ASPEC module contracts (api-keys, rbac, auth, users)
// into LoreLink's Go control plane. The TypeScript sources live in third_party/aspec.
package aspecmod

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"hash/crc32"
	"math/big"
	"strings"
)

const (
	DefaultKeyPrefix = "ak_live_"
	base62Alphabet   = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

// KeyParts matches @aspec/api-keys generateKey().
type KeyParts struct {
	Key           string
	Prefix        string
	PublicID      string
	Secret        string
	Checksum      string
	DisplayPrefix string
}

func GenerateKey() (KeyParts, error) {
	return GenerateKeyWithPrefix(DefaultKeyPrefix)
}

func GenerateKeyWithPrefix(prefix string) (KeyParts, error) {
	if prefix == "" {
		prefix = DefaultKeyPrefix
	}
	pub, err := randomBase62(6)
	if err != nil {
		return KeyParts{}, err
	}
	secret, err := randomBase62(32)
	if err != nil {
		return KeyParts{}, err
	}
	body := prefix + pub + "_" + secret
	sum := checksumSuffix(body)
	key := body + sum
	disp := prefix + pub
	if len(pub) >= 4 {
		disp = prefix + pub[:4] + "..."
	}
	return KeyParts{
		Key:           key,
		Prefix:        prefix,
		PublicID:      pub,
		Secret:        secret,
		Checksum:      sum,
		DisplayPrefix: disp,
	}, nil
}

func HashKey(pepper []byte, key string) string {
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write([]byte(key))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func HashesEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

func PepperFromInstanceKey(instanceKey []byte) []byte {
	mac := hmac.New(sha256.New, instanceKey)
	_, _ = mac.Write([]byte("aspec/api-keys"))
	return mac.Sum(nil)
}

func ParsePublicID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, " \t\n\x00") {
		return ""
	}
	last := strings.LastIndex(raw, "_")
	if last <= 0 {
		return ""
	}
	before := raw[:last]
	pubSep := strings.LastIndex(before, "_")
	if pubSep < 0 || pubSep+1 >= len(before) {
		return ""
	}
	return before[pubSep+1:]
}

func randomBase62(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return toBase62(buf), nil
}

func toBase62(b []byte) string {
	n := new(big.Int).SetBytes(b)
	if n.Sign() == 0 {
		return "0"
	}
	base := big.NewInt(62)
	zero := big.NewInt(0)
	mod := new(big.Int)
	var out []byte
	for n.Cmp(zero) > 0 {
		n.DivMod(n, base, mod)
		out = append(out, base62Alphabet[mod.Int64()])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func checksumSuffix(body string) string {
	n := crc32.ChecksumIEEE([]byte(body))
	bytes := []byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}
	s := toBase62(bytes)
	if len(s) < 6 {
		s = strings.Repeat("0", 6-len(s)) + s
	}
	if len(s) > 6 {
		s = s[len(s)-6:]
	}
	return s
}
