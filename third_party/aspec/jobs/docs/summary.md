# @aspec/jobs

Background task processing for Node.js. Provides job queues, delayed and cron scheduling, retries with backoff, cooperative cancellation, progress tracking, dead-letter queues, priorities, worker lifecycle and graceful shutdown. Local development uses an in-memory backend; production uses SQLite or PostgreSQL over the SqlClient port (`FOR UPDATE SKIP LOCKED`).
