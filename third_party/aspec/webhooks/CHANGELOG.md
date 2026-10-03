# Changelog

## [1.0.1] - 2026-09-30

### Security

- The SSRF guard did not block IPv4 addresses carried inside IPv6. `http://[::ffff:127.0.0.1]/` (which URL parsing turns into `::ffff:7f00:1`), IPv4-compatible, NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16`) forms now resolve to their embedded IPv4 address and are checked against the IPv4 list. The previous pattern also missed the dotted `::ffff:a.b.c.d` form that DNS can return.
- Bracketed IPv6 URL hosts such as `http://[::1]/` are treated as addresses instead of being sent to DNS, and `allowHosts` accepts either form.
- Added blocked ranges: 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 240.0.0.0/4, 100::/64, 2001::/32 (Teredo), and fec0::/10.

## [1.0.0] - 2026-09-29

### Added

- Outgoing webhooks with subscriptions, event filters, payload filters and CRUD
- Standard Webhooks signing with multi-secret rotation (AES-256-GCM at rest)
- SSRF protection with DNS pinning, private range blocking and redirect refusal
- Retry schedule, 410 handling, auto-disable, redeliver and ping
- Incoming verification for Standard Webhooks, GitHub, Stripe and generic HMAC
- Replay protection with memory and SQL seen-id stores
- Express 4/5, Fastify, Hono and Fetch admin routers and raw-body helpers
- Memory and SQL stores (PostgreSQL and SQLite)
