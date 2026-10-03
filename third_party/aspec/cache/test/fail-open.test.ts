import { describe, expect, it } from 'vitest';
import { CacheUnavailableError, createCache, createRedisStore } from '../src/index.js';
import type { RedisCommandClient } from '../src/redis-client.js';

function unreachableClient(): RedisCommandClient {
  const url = 'redis://127.0.0.1:1';
  // Minimal client that fails immediately without long reconnect loops.
  return {
    async get() {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
    async set() {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
    async del() {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
    async ping() {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
  };
}

describe('fail-open and circuit breaker', () => {
  it('does not crash when Redis is unreachable and failOpen is true', async () => {
    const store = createRedisStore({ client: unreachableClient(), prefix: 'aspec:dead:' });
    const cache = createCache({
      store,
      failOpen: true,
      timeoutMs: 50,
      circuitBreaker: { threshold: 2, coolDownMs: 10_000 },
    });
    try {
      expect(await cache.get('k')).toBeUndefined();
      expect(await cache.get('k')).toBeUndefined();
      const started = performance.now();
      // Breaker open: should not add remote latency.
      expect(await cache.get('k')).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(30);
      expect(await cache.getOrSet('k', async () => 'fallback')).toBe('fallback');
      expect(cache.stats().errors).toBeGreaterThanOrEqual(2);
    } finally {
      await cache.close();
    }
  });

  it('throws CACHE_UNAVAILABLE when failOpen is false', async () => {
    const store = createRedisStore({ client: unreachableClient(), prefix: 'aspec:dead2:' });
    const cache = createCache({
      store,
      failOpen: false,
      timeoutMs: 50,
      circuitBreaker: { threshold: 1, coolDownMs: 10_000 },
    });
    try {
      await expect(cache.get('k')).rejects.toBeInstanceOf(CacheUnavailableError);
      await expect(cache.get('k')).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE' });
      // getOrSet still falls back to the loader even when the cache is unavailable.
      await expect(cache.getOrSet('k', async () => 'ok')).resolves.toBe('ok');
    } finally {
      await cache.close();
    }
  });
});
