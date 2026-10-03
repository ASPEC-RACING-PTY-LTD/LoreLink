# LoreLink architecture

LoreLink is a Go control plane with two React surfaces that share one design system.

- **Canonical documentation content** lives in Git. PostgreSQL stores platform metadata only: users, orgs, bindings, jobs, search documents, publish runs, maintainer mappings.
- **Portal** (`/`): setup, authentication, organisations, projects, Git connections, teams, members, roles, API keys, editor, publish, search, maintainer, jobs, instance admin.
- **ASPEC modules** are copied into `third_party/aspec/` (auth, users, rbac, api-keys, api, orgs, audit, jobs, webhooks, and supporting ports). LoreLink implements those contracts in Go: capability RBAC tables, HMAC API keys, user lifecycle, lockout, and password reset.
- **Docs site** (`/view/{org}/{project}/{version}/...`): LoreMark reader with nav, TOC, versions, and search.
- **CLI**: `lorelink` and `lol` are the same command set. `serve`, `doctor`, `login`, project, docs, publish, and maintainer commands talk to the HTTP API.
- **Connectors** stay inside this repository: Generic Git (poll first), CodeHold (webhook first, poll fallback), GitHub (webhook first, poll fallback).
- **Writes** are path-bounded to the project docs root and configured generated roots. Symlinks and `..` escapes are rejected.
- **Jobs** are durable Postgres rows claimed with `FOR UPDATE SKIP LOCKED`.
- **PublishTarget** implementations: hosted (`$DATA_DIR/published/...`), filesystem (`$DATA_DIR/exports/...`), download (zip artifact).
- **Search** is PostgreSQL full-text search. No Algolia.
- **Maintainer** is deterministic and off until mappings exist. Extractors: OpenAPI, JSON Schema, CLI help text, Go symbols. Generated regions use HTML comments, not AI.
- **Design system**: `web/shared` with `lorelink` and `lorelink-dark` themes. No daisyUI.

Secrets for Git providers are AES-256-GCM sealed with `$DATA_DIR/instance.key`.
