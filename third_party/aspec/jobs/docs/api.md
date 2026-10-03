# API

- `createQueue` / `Queue` (JobQueue port plus inspection, cancel, retry, DLQ, cleanup, health)
- `createWorker` / `Worker` (start, pause, resume, stop, poll)
- `createScheduler` (croner + intervals, deterministic job IDs)
- `installShutdownHandlers`
- `NonRetryableError`, `JobsError`
- `createAdminCore`
- Subpaths: `/memory`, `/sql`, `/express`, `/fastify`, `/hono`, `/fetch`
