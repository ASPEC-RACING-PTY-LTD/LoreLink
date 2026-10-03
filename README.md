# LoreLink

Your projects. Their lore. All connected.

LoreLink is an open-source, self-hosted, Git-native documentation control plane. Documentation stays in your repositories. LoreLink binds those repos, edits LoreMark under path bounds, publishes hosted or downloadable sites, searches them, and can keep generated API pages in sync with OpenAPI, JSON Schema, CLI help, or Go symbols.

## Requirements

- Go 1.26+
- Node 22+ and pnpm 10+
- Docker and Docker Compose (for PostgreSQL and the full stack)
- PostgreSQL 16
- `git` on the PATH for clone, fetch, commit, and push

## Quick start (Docker Compose)

```bash
docker compose up --build
```

Then open http://127.0.0.1:8080 and complete first-time setup.

Published docs are at http://127.0.0.1:8080/view/{org}/{project}/.

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
pnpm --filter @lorelink/docs-site dev
```

The portal Vite server proxies `/api` to `:8080`.

`lol` is the same CLI as `lorelink`:

```bash
go run ./cmd/lol version
go run ./cmd/lorelink login --url http://127.0.0.1:8080 --email you@example.com --password ...
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LORELINK_DATABASE_URL` | yes | | PostgreSQL connection string |
| `LORELINK_DATA_DIR` | no | `./data` | Instance key, workspaces, published sites, artifacts |
| `LORELINK_HTTP_ADDR` | no | `:8080` | Listen address |
| `LORELINK_PUBLIC_URL` | no | | Public base URL used for webhook callbacks |

The instance encryption key is created at `$LORELINK_DATA_DIR/instance.key` on first start. API keys use HMAC-SHA256 with a pepper derived from that key (`X-Api-Key` or `Authorization: Bearer ak_live_...`).

Copied ASPEC Dev Modules live in `third_party/aspec/` (auth, users, rbac, api-keys, api, orgs, audit, jobs, webhooks, and supporting ports). They were copied from `D:/ASPEC Dev Modules/modules/`, not moved. LoreLink implements those contracts in Go.

## Git connectors

| Provider | Webhooks | Listing | Notes |
|---|---|---|---|
| `generic` | incoming HMAC optional | single clone URL | Polls `git ls-remote`. |
| `codehold` | first | yes | CodeHold/Gitea-style `/api/v1` REST. Registration failure enables poll fallback. |
| `github` | first | yes | GitHub REST. Registration failure enables poll fallback. |

Webhook endpoint: `POST /api/v1/webhooks/{provider}/{connectionID}`.

## CLI

`lorelink` and `lol` accept the same commands: `serve`, `version`, `doctor`, `login`, `logout`, `whoami`, `status`, `orgs`, `projects`, `connect`, `bind`, `sync`, `docs`, `check`, `build`, `publish`, `maintain`.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
