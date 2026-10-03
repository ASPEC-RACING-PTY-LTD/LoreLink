package gitbound

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrEscape   = errors.New("gitbound: path escapes owned root")
	ErrSymlink  = errors.New("gitbound: symlink not allowed")
	ErrAbsolute = errors.New("gitbound: absolute path not allowed")
)

func CleanOwned(root, rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "" || rel == "." {
		return filepath.Clean(root), nil
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return "", ErrAbsolute
	}
	cleaned := filepath.Clean(rel)
	if strings.HasPrefix(cleaned, "..") {
		return "", ErrEscape
	}
	full := filepath.Join(root, cleaned)
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	sep := string(os.PathSeparator)
	if absFull != absRoot && !strings.HasPrefix(absFull, absRoot+sep) {
		return "", ErrEscape
	}
	return absFull, nil
}

func AssertOwnedFile(root, rel string) (string, error) {
	full, err := CleanOwned(root, rel)
	if err != nil {
		return "", err
	}
	if err := rejectSymlinkChain(root, full); err != nil {
		return "", err
	}
	return full, nil
}

func rejectSymlinkChain(root, full string) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(absRoot, full)
	if err != nil {
		return ErrEscape
	}
	cur := absRoot
	parts := strings.Split(rel, string(os.PathSeparator))
	for _, part := range parts {
		if part == "." || part == "" {
			continue
		}
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrSymlink
		}
	}
	return nil
}

func WithinAny(root string, rel string, owned []string) error {
	full, err := AssertOwnedFile(root, rel)
	if err != nil {
		return err
	}
	absRoot, _ := filepath.Abs(root)
	relFromRepo, err := filepath.Rel(absRoot, full)
	if err != nil {
		return ErrEscape
	}
	relFromRepo = filepath.ToSlash(relFromRepo)
	for _, prefix := range owned {
		p := strings.Trim(strings.ReplaceAll(prefix, "\\", "/"), "/")
		if p == "" {
			continue
		}
		if relFromRepo == p || strings.HasPrefix(relFromRepo, p+"/") {
			return nil
		}
	}
	return ErrEscape
}
