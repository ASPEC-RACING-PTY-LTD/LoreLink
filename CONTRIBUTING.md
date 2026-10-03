# Contributing to LoreLink

Thank you for considering a contribution.

## Principles

- Documentation content stays Git-native. Do not store canonical page bodies in PostgreSQL.
- The Maintainer is deterministic. Do not introduce AI or LLM dependencies.
- LoreLink must remain useful without CodeHold or any other single Git provider.
- Use the shared LoreLink themes only.

## Development

1. Install Go 1.26+, Node 22+, pnpm, and Docker.
2. Start PostgreSQL with `docker compose up postgres -d`.
3. Run `go test ./...` from the repository root.
4. Run `pnpm install` in `web/`, then `pnpm --filter @lorelink/portal typecheck` and `pnpm --filter @lorelink/docs-site typecheck`.

## Pull requests

- Keep changes focused.
- Include tests for capability, setup, and authentication changes.
- Do not add a second visual system.
- Do not commit `instance.key`, `.env` files, or credentials.
