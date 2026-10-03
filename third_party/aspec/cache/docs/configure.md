# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | for Redis/tiered | Redis-compatible URL |
| `CACHE_NAMESPACE` | no | Default namespace for generated setup |

## `createCache` options

`store` (`'memory'` or a `CacheStore`), `memory` (maxEntries, maxBytes, sweepIntervalMs), `namespace`, `defaultTtlMs`, `defaultJitterMs`, `failOpen` (default true), `timeoutMs` (default 2000), `circuitBreaker` (`threshold`, `coolDownMs`), `logger`, `serializer`, `clock`.

Redis store: `createRedisStore({ client, prefix, ownsClient })`. Tiered: `createTieredStore({ l1, l2, pubSubInvalidation })`.
