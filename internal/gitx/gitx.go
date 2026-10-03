package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Result struct {
	Stdout string
	Stderr string
}

func Run(ctx context.Context, dir string, args ...string) (Result, error) {
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GCM_INTERACTIVE=never",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := Result{Stdout: strings.TrimSpace(stdout.String()), Stderr: strings.TrimSpace(stderr.String())}
	if err != nil {
		return res, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, res.Stderr)
	}
	return res, nil
}

func EnsureRepo(ctx context.Context, workspace, remote, branch, token string) error {
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return err
	}
	gitDir := filepath.Join(workspace, ".git")
	if _, err := os.Stat(gitDir); err != nil {
		cloneURL := remote
		if token != "" {
			cloneURL = injectToken(remote, token)
		}
		parent := filepath.Dir(workspace)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		tmp := workspace + ".clone-tmp"
		_ = os.RemoveAll(tmp)
		args := []string{"clone", "--branch", branch, "--single-branch", cloneURL, tmp}
		if _, err := Run(ctx, parent, args...); err != nil {
			_ = os.RemoveAll(tmp)
			// branch may not exist yet; clone default then checkout
			if _, err2 := Run(ctx, parent, "clone", cloneURL, tmp); err2 != nil {
				_ = os.RemoveAll(tmp)
				return err
			}
		}
		if err := os.RemoveAll(workspace); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		if err := os.Rename(tmp, workspace); err != nil {
			return err
		}
	}
	if token != "" {
		if _, err := Run(ctx, workspace, "remote", "set-url", "origin", injectToken(remote, token)); err != nil {
			return err
		}
	}
	if _, err := Run(ctx, workspace, "fetch", "origin", branch); err != nil {
		_, _ = Run(ctx, workspace, "fetch", "origin")
	}
	if _, err := Run(ctx, workspace, "checkout", branch); err != nil {
		_, _ = Run(ctx, workspace, "checkout", "-B", branch)
	}
	if _, err := Run(ctx, workspace, "reset", "--hard", "origin/"+branch); err != nil {
		_, _ = Run(ctx, workspace, "reset", "--hard", "HEAD")
	}
	return nil
}

func HeadSHA(ctx context.Context, workspace string) (string, error) {
	res, err := Run(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return res.Stdout, nil
}

func CommitAll(ctx context.Context, workspace, message, authorName, authorEmail string) (string, error) {
	if _, err := Run(ctx, workspace, "add", "-A"); err != nil {
		return "", err
	}
	status, err := Run(ctx, workspace, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(status.Stdout) == "" {
		return HeadSHA(ctx, workspace)
	}
	envAuthor := []string{
		"GIT_AUTHOR_NAME=" + authorName,
		"GIT_AUTHOR_EMAIL=" + authorEmail,
		"GIT_COMMITTER_NAME=" + authorName,
		"GIT_COMMITTER_EMAIL=" + authorEmail,
	}
	cmd := exec.CommandContext(ctx, "git", "commit", "-m", message)
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(), envAuthor...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git commit: %w: %s", err, stderr.String())
	}
	return HeadSHA(ctx, workspace)
}

func Push(ctx context.Context, workspace, branch string) error {
	_, err := Run(ctx, workspace, "push", "origin", "HEAD:"+branch)
	return err
}

func injectToken(remote, token string) string {
	if token == "" || !strings.HasPrefix(remote, "https://") {
		return remote
	}
	rest := strings.TrimPrefix(remote, "https://")
	if strings.Contains(rest, "@") {
		return remote
	}
	return "https://x-access-token:" + token + "@" + rest
}
