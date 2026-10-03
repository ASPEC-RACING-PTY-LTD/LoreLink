# API

## `@aspec/cache`

| Export | Description |
|--------|-------------|
| `createCache(options)` | Cache facade implementing `CacheLike` plus namespaces, tags, stats, health, getOrSet |
| `key(...parts)` / `versionedKey` / `normaliseKey` | Key builders with validation and SHA-256 for long keys |
| `createMemoryStore` / `createRedisStore` / `createTieredStore` | Store factories |
| `adaptRedisClient` | Structural adapter for ioredis and node-redis |
| `jsonSerializer` | Default JSON serializer |
| `CacheUnavailableError` (`CACHE_UNAVAILABLE`) | Thrown when `failOpen` is false |
| Ports: `CacheLike`, `LoggerLike`, `HealthCheckable` | Copied from integration ports |

### Cache methods

`get`, `set`, `delete`, `deleteMany`, `invalidateTag`, `invalidateNamespace`, `ttl`, `namespace`, `getOrSet`, `wrap`, `stats`, `resetStats`, `checkHealth`, `close`.

## Subpaths

`@aspec/cache/memory`, `@aspec/cache/redis`, `@aspec/cache/tiered`.
