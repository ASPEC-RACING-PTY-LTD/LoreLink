# Changelog

## [1.0.0] - 2026-09-29

### Added

- Notification service with email, in-app, console, HTTP webhook and Slack channels
- SMTP transport via Nodemailer with pooling, TLS, auth, DKIM and health checks
- Template registry with HTML escaping, layouts, partials and locale fallback
- Preference resolution with mandatory categories
- Delivery tracking, retries with backoff and jitter, and history queries
- JobQueue integration (`notifications.deliver`) and inline delivery fallback
- Memory and SQL stores (PostgreSQL and SQLite)
- Express 4/5, Fastify, Hono and Fetch routers for in-app and preferences APIs
