import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCache, key } from '../src/index.js';

describe('memory cache', () => {
  const caches: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    while (caches.length) await caches.pop()?.close();
  });

  function make(opts: Parameters<typeof createCache>[0] = {}) {
    const cache = createCache({
      store: 'memory',
      memory: { sweepIntervalMs: 0, ...opts?.memory },
      ...opts,
    });
    caches.push(cache);
    return cache;
  }

  it('gets, sets, deletes and tracks stats', async () => {
    const cache = make();
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('a', { n: 1 }, { ttlMs: 60_000 });
    expect(await cache.get('a')).toEqual({ n: 1 });
    await cache.delete('a');
    expect(await cache.get('a')).toBeUndefined();
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.sets).toBe(1);
    expect(stats.deletes).toBe(1);
    expect(stats.hitRatio).toBeCloseTo(1 / 3);
  });

  it('evicts LRU when maxEntries is exceeded', async () => {
    let evictions = 0;
    const cache = make({
      memory: { maxEntries: 2, onEvict: () => evictions++, sweepIntervalMs: 0 },
    });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a');
    await cache.set('c', 3);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(evictions).toBeGreaterThanOrEqual(1);
  });

  it('expires entries with fake timers', async () => {
    vi.useFakeTimers();
    try {
      const clock = { now: () => Date.now() };
      const cache = make({ clock, memory: { clock, sweepIntervalMs: 0 } });
      await cache.set('k', 'v', { ttlMs: 1000 });
      expect(await cache.get('k')).toBe('v');
      await vi.advanceTimersByTimeAsync(1001);
      expect(await cache.get('k')).toBeUndefined();
      expect(await cache.ttl('k')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports tags and namespaces', async () => {
    const cache = make();
    const users = cache.namespace('users');
    await users.set('1', { id: 1 }, { tags: ['user'] });
    await users.set('2', { id: 2 }, { tags: ['user'] });
    expect(await users.get('1')).toEqual({ id: 1 });
    await users.invalidateTag('user');
    expect(await users.get('1')).toBeUndefined();
    await users.set('3', { id: 3 });
    await users.invalidateNamespace();
    expect(await users.get('3')).toBeUndefined();
  });

  it('single-flights getOrSet and supports wrap', async () => {
    const cache = make();
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return 'value';
    };
    const [a, b] = await Promise.all([cache.getOrSet('k', loader), cache.getOrSet('k', loader)]);
    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(loads).toBe(1);
    const wrapped = cache.wrap(
      async (id: number) => `u:${id}`,
      (id) => key('user', id),
    );
    expect(await wrapped(7)).toBe('u:7');
    expect(await wrapped(7)).toBe('u:7');
  });

  it('revalidates in the background with SWR', async () => {
    vi.useFakeTimers();
    try {
      const clock = { now: () => Date.now() };
      const cache = make({ clock, memory: { clock, sweepIntervalMs: 0 } });
      let n = 0;
      const loader = async () => ++n;
      expect(await cache.getOrSet('k', loader, { ttlMs: 1000, staleWhileRevalidateMs: 500 })).toBe(
        1,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(await cache.getOrSet('k', loader, { ttlMs: 1000, staleWhileRevalidateMs: 500 })).toBe(
        1,
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await cache.get('k')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds and hashes long keys', () => {
    expect(key('user', 1)).toBe('user:1');
    const long = key('x'.repeat(600));
    expect(long.length).toBeLessThan(600);
    expect(long).toContain('#');
  });
});
