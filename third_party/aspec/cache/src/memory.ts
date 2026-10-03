import type { Clock } from './ports.js';
import type { CacheStore, StoreEntry } from './store.js';

export interface MemoryStoreOptions {
  /** Maximum entries (LRU). Default 1000. */
  maxEntries?: number;
  /** Optional approximate max serialized bytes. */
  maxBytes?: number;
  /** Sweep interval for expired entries. Default 30000. 0 disables. */
  sweepIntervalMs?: number;
  clock?: Clock;
  onEvict?: () => void;
}

interface Node {
  key: string;
  entry: StoreEntry;
  bytes: number;
  prev: Node | undefined;
  next: Node | undefined;
}

function estimateBytes(entry: StoreEntry): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry.value), 'utf8') + 64;
  } catch {
    return 256;
  }
}

function cloneEntry(entry: StoreEntry): StoreEntry {
  const out: StoreEntry = { value: entry.value };
  if (entry.expiresAt !== undefined) out.expiresAt = entry.expiresAt;
  if (entry.tags !== undefined) out.tags = [...entry.tags];
  return out;
}

/** In-process LRU store with lazy TTL expiry and an unref'd sweep timer. */
export function createMemoryStore(options: MemoryStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? 1000;
  const maxBytes = options.maxBytes;
  const clock = options.clock ?? { now: () => Date.now() };
  const map = new Map<string, Node>();
  const tags = new Map<string, Set<string>>();
  const generations = new Map<string, number>();
  let head: Node | undefined;
  let tail: Node | undefined;
  let totalBytes = 0;
  let closed = false;

  const touch = (node: Node): void => {
    if (head === node) return;
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (tail === node) tail = node.prev;
    node.prev = undefined;
    node.next = head;
    if (head) head.prev = node;
    head = node;
    if (!tail) tail = node;
  };

  const detach = (node: Node): void => {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (head === node) head = node.next;
    if (tail === node) tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  };

  const untag = (key: string, entryTags?: readonly string[]): void => {
    if (!entryTags) return;
    for (const tag of entryTags) {
      const set = tags.get(tag);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) tags.delete(tag);
    }
  };

  const removeNode = (node: Node, evict: boolean): void => {
    map.delete(node.key);
    detach(node);
    totalBytes -= node.bytes;
    untag(node.key, node.entry.tags);
    if (evict) options.onEvict?.();
  };

  const expired = (entry: StoreEntry): boolean =>
    entry.expiresAt !== undefined && entry.expiresAt <= clock.now();

  const enforce = (): void => {
    while (map.size > maxEntries || (maxBytes !== undefined && totalBytes > maxBytes)) {
      if (!tail) break;
      removeNode(tail, true);
    }
  };

  const sweep = (): void => {
    for (const node of [...map.values()]) {
      if (expired(node.entry)) removeNode(node, false);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
  if (sweepIntervalMs > 0) {
    timer = setInterval(sweep, sweepIntervalMs);
    timer.unref?.();
  }

  const store: CacheStore = {
    name: 'memory',

    async get(key) {
      if (closed) return undefined;
      const node = map.get(key);
      if (!node) return undefined;
      if (expired(node.entry)) {
        removeNode(node, false);
        return undefined;
      }
      touch(node);
      return cloneEntry(node.entry);
    },

    async set(key, entry) {
      if (closed) return;
      const existing = map.get(key);
      if (existing) removeNode(existing, false);
      const cloned = cloneEntry(entry);
      const node: Node = {
        key,
        entry: cloned,
        bytes: estimateBytes(cloned),
        prev: undefined,
        next: undefined,
      };
      map.set(key, node);
      totalBytes += node.bytes;
      touch(node);
      if (cloned.tags) {
        for (const tag of cloned.tags) {
          let set = tags.get(tag);
          if (!set) {
            set = new Set();
            tags.set(tag, set);
          }
          set.add(key);
        }
      }
      enforce();
    },

    async delete(key) {
      const node = map.get(key);
      if (!node) return false;
      removeNode(node, false);
      return true;
    },

    async deleteMany(keys) {
      let n = 0;
      for (const key of keys) if (await store.delete(key)) n++;
      return n;
    },

    async invalidateTag(tag) {
      const set = tags.get(tag);
      if (!set) return 0;
      const keys = [...set];
      let n = 0;
      for (const key of keys) if (await store.delete(key)) n++;
      return n;
    },

    async bumpGeneration(namespace) {
      const next = (generations.get(namespace) ?? 0) + 1;
      generations.set(namespace, next);
      return next;
    },

    async getGeneration(namespace) {
      return generations.get(namespace) ?? 0;
    },

    async ttl(key) {
      const node = map.get(key);
      if (!node || expired(node.entry)) return undefined;
      if (node.entry.expiresAt === undefined) return undefined;
      return Math.max(0, node.entry.expiresAt - clock.now());
    },

    async ping() {},

    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      map.clear();
      tags.clear();
      generations.clear();
      head = undefined;
      tail = undefined;
      totalBytes = 0;
    },
  };

  return store;
}
