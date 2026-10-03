# Caching

`@aspec/cache` provides a `CacheLike` facade over in-memory LRU and Redis-compatible stores (ioredis or node-redis), with optional L1/L2 tiering and pub/sub invalidation. It supports TTLs with jitter, tags, O(1) namespace invalidation via generation counters, statistics, health checks, `getOrSet`/`wrap` cache-aside helpers with single-flight and SWR, and fail-open behaviour with a circuit breaker so an unavailable optional cache cannot crash the application.
