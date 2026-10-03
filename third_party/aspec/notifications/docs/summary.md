# Summary

`@aspec/notifications` delivers transactional email and in-app notifications without
paid providers. It renders safe templates, respects per-user preferences (with mandatory
security and account categories), tracks every delivery attempt, retries transient SMTP
and network failures, and can enqueue work on a JobQueue. Optional adapters add Slack
and generic HTTP webhook channels. HTTP routers expose inbox and preference APIs for
Express, Fastify, Hono and the Fetch API. Persistence uses an in-memory store or SQL
(PostgreSQL or SQLite) with the `notifications_` table prefix.
