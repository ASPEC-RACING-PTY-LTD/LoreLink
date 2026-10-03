import type { Clock } from './ports.js';
import {
  adaptRedisClient,
  isRedisAdapter,
  type RedisAdapter,
  type RedisCommandClient,
} from './redis-client.js';
import type { CacheSerializer } from './serializer.js';
import { jsonSerializer } from './serializer.js';
import type { CacheStore, StoreEntry } from './store.js';

export interface RedisStoreOptions {
  client: RedisCommandClient | RedisAdapter;
  /** Key prefix. Default `aspec:cache:`. */
  prefix?: string;
  serializer?: CacheSerializer;
  clock?: Clock;
  ownsClient?: boolean;
}

/** Redis-compatible store using SCAN (never KEYS), SET PX, and tag sets. */
export function createRedisStore(options: RedisStoreOptions): CacheStore {
  const prefix = options.prefix ?? 'aspec:cache:';
  const serializer = options.serializer ?? jsonSerializer;
  const clock = options.clock ?? { now: () => Date.now() };
  const adaptOptions = options.ownsClient === undefined ? {} : { ownsClient: options.ownsClient };
  const redis = isRedisAdapter(options.client)
    ? options.client
    : adaptRedisClient(options.client, adaptOptions);

  const dataKey = (key: string) => `${prefix}d:${key}`;
  const tagKey = (tag: string) => `${prefix}t:${tag}`;
  const genKey = (namespace: string) => `${prefix}g:${namespace}`;

  const decode = (raw: string | null): StoreEntry | undefined => {
    if (raw === null) return undefined;
    const parsed = serializer.decode<{ v: unknown; tags?: string[] }>(raw);
    const entry: StoreEntry = { value: parsed.v };
    if (parsed.tags !== undefined) entry.tags = parsed.tags;
    return entry;
  };

  const store: CacheStore = {
    name: 'redis',

    async get(key) {
      return decode(await redis.get(dataKey(key)));
    },

    async set(key, entry) {
      const payload = serializer.encode({ v: entry.value, tags: entry.tags });
      const ttlMs =
        entry.expiresAt === undefined ? undefined : Math.max(1, entry.expiresAt - clock.now());
      await redis.set(dataKey(key), payload, ttlMs);
      if (entry.tags) {
        for (const tag of entry.tags) await redis.sadd(tagKey(tag), [key]);
      }
    },

    async delete(key) {
      const existing = await store.get(key);
      const removed = (await redis.del([dataKey(key)])) > 0;
      if (existing?.tags) {
        for (const tag of existing.tags) await redis.srem(tagKey(tag), [key]);
      }
      return removed;
    },

    async deleteMany(keys) {
      let n = 0;
      for (const key of keys) if (await store.delete(key)) n++;
      return n;
    },

    async invalidateTag(tag) {
      const members = await redis.smembers(tagKey(tag));
      let n = 0;
      for (const key of members) if (await store.delete(key)) n++;
      await redis.del([tagKey(tag)]);
      return n;
    },

    async bumpGeneration(namespace) {
      return redis.incr(genKey(namespace));
    },

    async getGeneration(namespace) {
      const raw = await redis.get(genKey(namespace));
      return raw ? Number(raw) : 0;
    },

    async ttl(key) {
      const ms = await redis.pttl(dataKey(key));
      if (ms < 0) return undefined;
      return ms;
    },

    async ping() {
      await redis.ping();
    },

    async close() {
      await redis.close();
    },
  };

  // Expose adapter for tiered pub/sub wiring.
  Object.defineProperty(store, Symbol.for('@aspec/cache.redisAdapter'), { value: redis });
  return store;
}

export function redisAdapterOf(store: CacheStore): RedisAdapter | undefined {
  return (store as unknown as Record<symbol, RedisAdapter | undefined>)[
    Symbol.for('@aspec/cache.redisAdapter')
  ];
}

export { adaptRedisClient, isRedisAdapter } from './redis-client.js';
export type { RedisAdapter, RedisCommandClient };
