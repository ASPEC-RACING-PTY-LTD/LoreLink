# ASPEC Dev Modules (copied)

These packages were **copied** from `D:/ASPEC Dev Modules/modules/`. The originals were not moved or deleted.

LoreLink is a Go control plane. The TypeScript modules stay here as the contract source (schemas, HTTP surfaces, key format, RBAC engine). The Go packages under `internal/aspecmod` and `internal/store` implement those contracts and persist to the same table shapes.

## Copied modules

| Module | Why it is here |
| --- | --- |
| `auth` | Sessions, lockout, password reset |
| `users` | Account lifecycle, suspension, invitations, activity |
| `rbac` | Roles, permissions, org and team assignments |
| `api-keys` | HMAC keys, scopes, rotation, revocation |
| `api` | Error and pagination conventions |
| `orgs` | Organisations, teams, memberships |
| `audit` | Security and admin event recording |
| `jobs` | Durable background work |
| `webhooks` | Signature verification contracts |
| `validation` / `errors` | Request and problem shapes |
| `db` / `config` / `rate-limit` | Ports used by the modules above |
| `observability` / `cache` / `storage` / `notifications` | Optional ports already used by those modules |

`flags` and `testing` were not copied. They are not part of LoreLink's runtime.

Do not edit these trees to change LoreLink behaviour. Change the Go wiring instead, then refresh the copy from `D:/ASPEC Dev Modules` when the upstream modules change.
