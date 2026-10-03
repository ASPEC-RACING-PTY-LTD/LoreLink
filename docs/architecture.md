# LoreLink architecture (Phase 0)

LoreLink is a Go control plane with two React surfaces that share one design system.

- **Canonical documentation content** lives in Git. PostgreSQL stores platform metadata only.
- **Portal** (`/`): setup, authentication, organisations, projects, members, activity, instance admin.
- **Docs site** (`/view/`): public reading chrome. The LoreMark renderer is not in Phase 0.
- **Design system**: `web/shared` with `lorelink` and `lorelink-dark` themes only.

See the approved implementation plan for later phases (Git connectors, LoreMark, Maintainer).
