# LoreLink

Your projects. Their lore. All connected.

LoreLink is an open-source, self-hosted, Git-native documentation management platform. Documentation stays in your repositories. LoreLink is the control plane: organisations, projects, editing, publishing, search, and an optional deterministic maintainer.

This repository is at Phase 0: instance setup, local authentication, organisations, capability-based RBAC, audit, and the design-system shells for the management portal and public docs site.

## Requirements

- Go 1.26+
- Node 22+ and pnpm 10+
- Docker and Docker Compose (for PostgreSQL and the full stack)
- PostgreSQL 16

## Quick start (Docker Compose)

```bash
docker compose up --build
```

Then open http://127.0.0.1:8080 and complete first-time setup.

The docs reading shell is at http://127.0.0.1:8080/view/.

## Local development

```bash
docker compose up postgres -d
export LORELINK_DATABASE_URL=postgres://lorelink:lorelink@127.0.0.1:5432/lorelink?sslmode=disable
export LORELINK_DATA_DIR=./data
export LORELINK_HTTP_ADDR=:8080
export LORELINK_PUBLIC_URL=http://127.0.0.1:8080
go run ./cmd/lorelink serve
```

In another terminal:

```bash
cd web
pnpm install
pnpm --filter @lorelink/portal dev
```

The portal Vite server proxies `/api` to `:8080`. Docs shell:

```bash
pnpm --filter @lorelink/docs-site dev
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LORELINK_DATABASE_URL` | yes | | PostgreSQL connection string |
| `LORELINK_DATA_DIR` | no | `./data` | Instance key and rebuildable caches |
| `LORELINK_HTTP_ADDR` | no | `:8080` | Listen address |
| `LORELINK_PUBLIC_URL` | no | | Public base URL (also set during setup) |

The instance encryption key is created at `$LORELINK_DATA_DIR/instance.key` on first start.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
