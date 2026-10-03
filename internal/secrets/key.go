package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	InstanceKeySize   = 32
	InstanceKeyName   = "instance.key"
	cipherVersionV1   = 1
	nonceSize         = 12
)

var ErrInvalidKey = errors.New("secrets: invalid instance key")

type Cipher struct {
	aead cipher.AEAD
}

func GenerateInstanceKey() ([]byte, error) {
	key := make([]byte, InstanceKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("secrets: generate instance key: %w", err)
	}
	return key, nil
}

func LoadOrCreateInstanceKey(dataDir string) ([]byte, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("secrets: data dir: %w", err)
	}
	path := filepath.Join(dataDir, InstanceKeyName)
	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != InstanceKeySize {
			return nil, fmt.Errorf("%w: want %d bytes, got %d", ErrInvalidKey, InstanceKeySize, len(raw))
		}
		return raw, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("secrets: read instance key: %w", err)
	}
	key, err := GenerateInstanceKey()
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, fmt.Errorf("secrets: write instance key: %w", err)
	}
	return key, nil
}

func NewCipher(instanceKey []byte) (*Cipher, error) {
	if len(instanceKey) != InstanceKeySize {
		return nil, fmt.Errorf("%w: want %d bytes, got %d", ErrInvalidKey, InstanceKeySize, len(instanceKey))
	}
	block, err := aes.NewCipher(instanceKey)
	if err != nil {
		return nil, fmt.Errorf("secrets: aes: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secrets: gcm: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Encrypt(plaintext, aad []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, ErrInvalidKey
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("secrets: nonce: %w", err)
	}
	sealed := c.aead.Seal(nil, nonce, plaintext, aad)
	out := make([]byte, 1+nonceSize+len(sealed))
	out[0] = cipherVersionV1
	copy(out[1:], nonce)
	copy(out[1+nonceSize:], sealed)
	return out, nil
}

func (c *Cipher) Decrypt(blob, aad []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, ErrInvalidKey
	}
	if len(blob) < 1+nonceSize+c.aead.Overhead() {
		return nil, errors.New("secrets: ciphertext too short")
	}
	if blob[0] != cipherVersionV1 {
		return nil, errors.New("secrets: unsupported cipher version")
	}
	nonce := blob[1 : 1+nonceSize]
	return c.aead.Open(nil, nonce, blob[1+nonceSize:], aad)
}
