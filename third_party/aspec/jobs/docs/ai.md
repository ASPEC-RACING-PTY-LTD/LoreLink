# AI agent notes

## Purpose
Background jobs with memory/SQL backends and optional admin HTTP.

## Use when
Queues, cron, retries, DLQ, cancellation are required.

## Avoid when
Simple in-process timers without inspection are enough.

## Prerequisites
Node >= 22.13. Optional SqlClient for PostgreSQL/SQLite.

## Integration steps
1. Create backend (`createMemoryBackend` or migrate + `createSqlBackend`)
2. `createQueue({ backend })`
3. `createWorker({ queue, handlers }).start()`
4. Optional `installShutdownHandlers(worker)`
5. Optional admin adapter with required `authorize`

## Configuration
See configure.md. Env: `JOBS_DATABASE_URL`.

## Verification
`pnpm --filter @aspec/jobs test` with Postgres URL set.

## Common mistakes
Missing admin `authorize`; non-serialisable per-job backoff; forgetting migrations.

## Uninstall
See uninstall.md.
