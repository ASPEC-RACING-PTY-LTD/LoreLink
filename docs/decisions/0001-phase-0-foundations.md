# ADR-001: Phase 0 foundations

## Status

Accepted

## Date

2026-10-03

## Context

LoreLink needed a self-hosted control-plane foundation before Git connectors or the documentation renderer.

## Decision

- Go 1.26 platform with Chi, PostgreSQL 16, and goose migrations.
- AES-256 instance key at `$DATA/instance.key`.
- Capability-based RBAC with seeded role presets.
- React 19 + Vite + Tailwind CSS 4, custom `lorelink` and `lorelink-dark` themes only.
- Shared design tokens in `web/shared`. Distinct portal and docs-site shells.

## Alternatives considered

- Node-only platform: weaker Git, CLI, and credential isolation story.
- SQLite dual dialect: extra storage complexity for Phase 0.
