import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCache,
  createMemoryStore,
  createRedisStore,
  createTieredStore,
} from '../src/index.js';

const REDIS_URL = process.env.ASPEC_TEST_REDIS_URL;

function prefix(): string {
  return `aspec:test:${randomBytes(6).toString('hex')}:`;
}

describe.skipIf(!REDIS_URL)('redis cache (ioredis)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  it('stores values with PX expiry, tags and namespaces', async () => {
    const client = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    const store = createRedisStore({ client, prefix: prefix(), ownsClient: true });
    const cache = createCache({ store, defaultTtlMs: 30_000 });
    closers.push(async () => {
      await cache.close();
    });
    await cache.set('a', { ok: true }, { tags: ['t1'] });
    expect(await cache.get('a')).toEqual({ ok: true });
    expect(await cache.ttl('a')).toBeGreaterThan(0);
    const ns = cache.namespace('orders');
    await ns.set('1', 1);
    await ns.invalidateNamespace();
    expect(await ns.get('1')).toBeUndefined();
    await cache.set('b', 2, { tags: ['t1'] });
    await cache.invalidateTag('t1');
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    const health = await cache.checkHealth();
    expect(health.ok).toBe(true);
    const info = await client.info('server');
    expect(info).toMatch(/redis_version|valkey/i);
  });
});

describe.skipIf(!REDIS_URL)('redis cache (node-redis)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  it('works with the node-redis client', async () => {
    const client = createClient({ url: REDIS_URL as string });
    await client.connect();
    const store = createRedisStore({
      client: client as never,
      prefix: prefix(),
      ownsClient: false,
    });
    const cache = createCache({ store });
    closers.push(async () => {
      await cache.close();
      await client.quit();
    });
    await cache.set('n', 'v');
    expect(await cache.get('n')).toBe('v');
    await cache.deleteMany(['n']);
    expect(await cache.get('n')).toBeUndefined();
  });
});

describe.skipIf(!REDIS_URL)('tiered cache pub/sub invalidation', () => {
  it('invalidates L1 across two instances', async () => {
    const p = prefix();
    const clientA = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const clientB = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await clientA.connect();
    await clientB.connect();
    const l2a = createRedisStore({ client: clientA, prefix: p, ownsClient: true });
    const l2b = createRedisStore({ client: clientB, prefix: p, ownsClient: true });
    const tieredA = createTieredStore({ l1: createMemoryStore({ sweepIntervalMs: 0 }), l2: l2a });
    const tieredB = createTieredStore({ l1: createMemoryStore({ sweepIntervalMs: 0 }), l2: l2b });
    await Promise.all([tieredA.ready, tieredB.ready]);
    const cacheA = createCache({ store: tieredA });
    const cacheB = createCache({ store: tieredB });
    try {
      await cacheA.set('shared', 'one');
      expect(await cacheB.get('shared')).toBe('one');
      await cacheA.set('shared', 'two');
      await new Promise((r) => setTimeout(r, 200));
      // B's L1 should drop via pub/sub then refill from L2.
      expect(await cacheB.get('shared')).toBe('two');
    } finally {
      await cacheA.close();
      await cacheB.close();
    }
  });
});
