export {
  type Cache,
  type CreateCacheOptions,
  createCache,
  type GetOrSetOptions,
  type SetOptions,
} from './cache.js';
export { CircuitBreaker, type CircuitBreakerOptions } from './circuit.js';
export {
  CacheError,
  CacheErrorCode,
  CacheUnavailableError,
  isCacheError,
} from './errors.js';
export { key, normaliseKey, versionedKey } from './keys.js';
export { createMemoryStore, type MemoryStoreOptions } from './memory.js';
export type {
  CacheLike,
  Clock,
  HealthCheckable,
  HealthCheckResult,
  LoggerLike,
} from './ports.js';
export {
  adaptRedisClient,
  createRedisStore,
  type RedisAdapter,
  type RedisCommandClient,
  type RedisStoreOptions,
  redisAdapterOf,
} from './redis.js';
export { type CacheSerializer, jsonSerializer } from './serializer.js';
export type { CacheStatsSnapshot } from './stats.js';
export type { CacheStore, StoreEntry } from './store.js';
export { createTieredStore, type TieredStoreOptions } from './tiered.js';
