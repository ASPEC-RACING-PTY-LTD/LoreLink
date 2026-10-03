import type { Clock } from './ports.js';
import { redisAdapterOf } from './redis.js';
import type { CacheStore, StoreEntry } from './store.js';

export interface TieredStoreOptions {
  l1: CacheStore;
  l2: CacheStore;
  /** When true, publishes invalidations so other L1 instances drop keys. Default true when L2 is Redis. */
  pubSubInvalidation?: boolean;
  /** Channel name for invalidation messages. Default `aspec:cache:invalidate`. */
  channel?: string;
  clock?: Clock;
}

/**
 * L1 memory + L2 Redis store. Reads fill L1; writes and deletes update both and optionally
 * publish invalidation events for other process L1 caches.
 */
export function createTieredStore(
  options: TieredStoreOptions,
): CacheStore & { ready: Promise<void> } {
  const { l1, l2 } = options;
  const channel = options.channel ?? 'aspec:cache:invalidate';
  const adapter = redisAdapterOf(l2);
  const enablePubSub = options.pubSubInvalidation ?? Boolean(adapter?.subscribe && adapter.publish);
  let unsubscribe: (() => Promise<void>) | undefined;
  let closed = false;

  const publish = async (message: string): Promise<void> => {
    if (!enablePubSub || !adapter?.publish) return;
    await adapter.publish(channel, message);
  };

  const ready = (async () => {
    if (!enablePubSub || !adapter?.subscribe) return;
    unsubscribe = await adapter.subscribe(channel, (message) => {
      void (async () => {
        try {
          const parsed = JSON.parse(message) as {
            op: string;
            key?: string;
            keys?: string[];
            tag?: string;
            ns?: string;
          };
          if (parsed.op === 'del' && parsed.key) await l1.delete(parsed.key);
          else if (parsed.op === 'delMany' && parsed.keys) await l1.deleteMany(parsed.keys);
          else if (parsed.op === 'tag' && parsed.tag) await l1.invalidateTag(parsed.tag);
          else if (parsed.op === 'ns' && parsed.ns) await l1.bumpGeneration(parsed.ns);
        } catch {
          // Ignore malformed invalidation messages.
        }
      })();
    });
  })();

  const store: CacheStore & { ready: Promise<void> } = {
    name: 'tiered',
    ready,

    async get(key) {
      const local = await l1.get(key);
      if (local) return local;
      const remote = await l2.get(key);
      if (!remote) return undefined;
      await l1.set(key, remote);
      return remote;
    },

    async set(key, entry: StoreEntry) {
      await Promise.all([l1.set(key, entry), l2.set(key, entry)]);
      await publish(JSON.stringify({ op: 'del', key }));
    },

    async delete(key) {
      const [a, b] = await Promise.all([l1.delete(key), l2.delete(key)]);
      await publish(JSON.stringify({ op: 'del', key }));
      return a || b;
    },

    async deleteMany(keys) {
      const [a, b] = await Promise.all([l1.deleteMany(keys), l2.deleteMany(keys)]);
      await publish(JSON.stringify({ op: 'delMany', keys }));
      return Math.max(a, b);
    },

    async invalidateTag(tag) {
      const [a, b] = await Promise.all([l1.invalidateTag(tag), l2.invalidateTag(tag)]);
      await publish(JSON.stringify({ op: 'tag', tag }));
      return Math.max(a, b);
    },

    async bumpGeneration(namespace) {
      const next = await l2.bumpGeneration(namespace);
      await l1.bumpGeneration(namespace);
      // Align L1 to L2 value by bumping until match is unnecessary; store generation on L2 as source of truth.
      await publish(JSON.stringify({ op: 'ns', ns: namespace }));
      return next;
    },

    async getGeneration(namespace) {
      return l2.getGeneration(namespace);
    },

    async ttl(key) {
      const remote = await l2.ttl(key);
      if (remote !== undefined) return remote;
      return l1.ttl(key);
    },

    async ping() {
      await Promise.all([l1.ping(), l2.ping()]);
    },

    async close() {
      closed = true;
      if (typeof unsubscribe === 'function') await unsubscribe();
      await Promise.all([l1.close(), l2.close()]);
      void closed;
    },
  };

  return store;
}
