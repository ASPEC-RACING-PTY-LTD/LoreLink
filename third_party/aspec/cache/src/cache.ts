import { CircuitBreaker } from './circuit.js';
import { CacheError, CacheErrorCode, CacheUnavailableError } from './errors.js';
import { normaliseKey } from './keys.js';
import { createMemoryStore, type MemoryStoreOptions } from './memory.js';
import type { Clock, HealthCheckable, HealthCheckResult, LoggerLike } from './ports.js';
import type { CacheSerializer } from './serializer.js';
import { type CacheStatsSnapshot, StatsCounter } from './stats.js';
import type { CacheStore } from './store.js';

export interface SetOptions {
  ttlMs?: number;
  /** Random jitter added to TTL (0..jitterMs). Reduces stampedes. */
  jitterMs?: number;
  tags?: readonly string[];
}

export interface GetOrSetOptions extends SetOptions {
  staleWhileRevalidateMs?: number;
  /** Cache undefined/null loader results. Default false. */
  cacheNull?: boolean;
}

export interface Cache extends HealthCheckable {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<number>;
  invalidateTag(tag: string): Promise<number>;
  /** O(1) namespace invalidation via generation counter. */
  invalidateNamespace(): Promise<void>;
  ttl(key: string): Promise<number | undefined>;
  namespace(name: string): Cache;
  getOrSet<T>(key: string, loader: () => Promise<T>, options?: GetOrSetOptions): Promise<T>;
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    keyFn: (...args: TArgs) => string,
    options?: GetOrSetOptions,
  ): (...args: TArgs) => Promise<TResult>;
  stats(): CacheStatsSnapshot;
  resetStats(): void;
  checkHealth(): Promise<HealthCheckResult>;
  close(): Promise<void>;
}

export interface CreateCacheOptions {
  store?: CacheStore | 'memory';
  memory?: MemoryStoreOptions;
  namespace?: string;
  defaultTtlMs?: number;
  defaultJitterMs?: number;
  serializer?: CacheSerializer;
  logger?: LoggerLike;
  /** Treat backend errors as misses (default true). */
  failOpen?: boolean;
  /** Remote operation timeout. Default 2000. */
  timeoutMs?: number;
  circuitBreaker?: { threshold?: number; coolDownMs?: number };
  clock?: Clock;
}

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new CacheUnavailableError(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createCache(options: CreateCacheOptions = {}): Cache {
  const store =
    options.store === undefined || options.store === 'memory'
      ? createMemoryStore(options.memory)
      : options.store;
  const rootStats = new StatsCounter();
  const logger = options.logger ?? noopLogger;
  const failOpen = options.failOpen ?? true;
  const timeoutMs = options.timeoutMs ?? 2000;
  const clock = options.clock ?? { now: () => Date.now() };
  const breaker = new CircuitBreaker({ ...options.circuitBreaker, clock });
  const inflight = new Map<string, Promise<unknown>>();
  let closed = false;

  const createNamespaced = (namespace: string | undefined, stats: StatsCounter): Cache => {
    const encode = async (logicalKey: string): Promise<string> => {
      const base = normaliseKey(logicalKey);
      if (!namespace) return base;
      const gen = await runStore(() => store.getGeneration(namespace), 'getGeneration', stats);
      const genValue = typeof gen === 'number' ? gen : 0;
      return normaliseKey(`${namespace}:g${genValue}:${base}`);
    };

    async function runStore<T>(
      fn: () => Promise<T>,
      label: string,
      counter: StatsCounter,
    ): Promise<T | undefined> {
      if (closed) throw new CacheError(CacheErrorCode.CLOSED, 'Cache is closed');
      if (breaker.open) {
        counter.errors++;
        if (failOpen) return undefined;
        throw new CacheUnavailableError('Cache circuit breaker is open');
      }
      try {
        const result = await withTimeout(fn(), timeoutMs, label);
        breaker.success();
        return result;
      } catch (error) {
        breaker.failure();
        counter.errors++;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), op: label },
          'cache operation failed',
        );
        if (failOpen) return undefined;
        throw error instanceof CacheUnavailableError
          ? error
          : new CacheUnavailableError('Cache backend is unavailable', { cause: error });
      }
    }

    const resolveTtlMs = (setOptions?: SetOptions): number | undefined => {
      const ttlMs = setOptions?.ttlMs ?? options.defaultTtlMs;
      if (ttlMs === undefined) return undefined;
      const jitter = setOptions?.jitterMs ?? options.defaultJitterMs ?? 0;
      const j = jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0;
      return ttlMs + j;
    };

    const cache: Cache = {
      async get<T = unknown>(key: string) {
        const full = await encode(key);
        const entry = await runStore(() => store.get(full), 'get', stats);
        if (!entry) {
          stats.misses++;
          return undefined;
        }
        stats.hits++;
        return entry.value as T;
      },

      async set(key, value, setOptions) {
        const full = await encode(key);
        const ttlMs = resolveTtlMs(setOptions);
        const expiresAt = ttlMs === undefined ? undefined : clock.now() + ttlMs;
        const entry: import('./store.js').StoreEntry = { value };
        if (expiresAt !== undefined) entry.expiresAt = expiresAt;
        if (setOptions?.tags) entry.tags = setOptions.tags.map((tag) => normaliseKey(tag));
        await runStore(() => store.set(full, entry), 'set', stats);
        stats.sets++;
      },

      async delete(key) {
        const full = await encode(key);
        await runStore(() => store.delete(full), 'delete', stats);
        stats.deletes++;
      },

      async deleteMany(keys) {
        const fullKeys: string[] = [];
        for (const key of keys) fullKeys.push(await encode(key));
        const n = await runStore(() => store.deleteMany(fullKeys), 'deleteMany', stats);
        stats.deletes += n ?? 0;
        return n ?? 0;
      },

      async invalidateTag(tag) {
        const n = await runStore(
          () => store.invalidateTag(normaliseKey(tag)),
          'invalidateTag',
          stats,
        );
        return n ?? 0;
      },

      async invalidateNamespace() {
        if (!namespace) {
          throw new CacheError(
            CacheErrorCode.KEY_INVALID,
            'Root cache has no namespace to invalidate; use cache.namespace(name)',
          );
        }
        await runStore(() => store.bumpGeneration(namespace), 'bumpGeneration', stats);
      },

      async ttl(key) {
        const full = await encode(key);
        return (await runStore(() => store.ttl(full), 'ttl', stats)) ?? undefined;
      },

      namespace(name: string) {
        const childName = namespace ? `${namespace}:${normaliseKey(name)}` : normaliseKey(name);
        return createNamespaced(childName, stats.child(childName));
      },

      async getOrSet<T>(key: string, loader: () => Promise<T>, getOptions: GetOrSetOptions = {}) {
        let existing: T | null | undefined;
        try {
          existing = await cache.get<T | null>(key);
        } catch {
          existing = undefined;
        }
        if (existing !== undefined) {
          if (getOptions.staleWhileRevalidateMs && getOptions.staleWhileRevalidateMs > 0) {
            try {
              const remaining = await cache.ttl(key);
              if (remaining !== undefined && remaining <= getOptions.staleWhileRevalidateMs) {
                void refresh(key, loader, getOptions);
              }
            } catch {
              // Ignore TTL failures during SWR.
            }
          }
          return existing as T;
        }

        const inflightKey = namespace ? `${namespace}:${key}` : key;
        const pending = inflight.get(inflightKey);
        if (pending) return pending as Promise<T>;

        const run = (async () => {
          try {
            const value = await loader();
            try {
              if (value !== undefined && value !== null) {
                await cache.set(key, value, getOptions);
              } else if (getOptions.cacheNull) {
                await cache.set(key, null, getOptions);
              }
            } catch {
              // Loader result is still returned when the cache cannot store it.
            }
            return value;
          } finally {
            inflight.delete(inflightKey);
          }
        })();
        inflight.set(inflightKey, run);
        return run;
      },

      wrap<TArgs extends unknown[], TResult>(
        fn: (...args: TArgs) => Promise<TResult>,
        keyFn: (...args: TArgs) => string,
        wrapOptions?: GetOrSetOptions,
      ) {
        return (...args: TArgs) => cache.getOrSet(keyFn(...args), () => fn(...args), wrapOptions);
      },

      stats: () => stats.snapshot(),
      resetStats: () => stats.reset(),

      async checkHealth() {
        const started = performance.now();
        try {
          if (breaker.open) {
            return {
              ok: false,
              latencyMs: 0,
              details: { store: store.name, error: 'circuit_open' },
            };
          }
          await withTimeout(store.ping(), timeoutMs, 'ping');
          breaker.success();
          return {
            ok: true,
            latencyMs: Math.round((performance.now() - started) * 100) / 100,
            details: { store: store.name, namespace: namespace ?? null },
          };
        } catch (error) {
          breaker.failure();
          return {
            ok: false,
            latencyMs: Math.round((performance.now() - started) * 100) / 100,
            details: {
              store: store.name,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },

      async close() {
        closed = true;
        inflight.clear();
        await store.close();
      },
    };

    const refresh = (
      key: string,
      loader: () => Promise<unknown>,
      getOptions: GetOrSetOptions,
    ): void => {
      const swrKey = `swr:${namespace ?? ''}:${key}`;
      if (inflight.has(swrKey)) return;
      const run = (async () => {
        try {
          const value = await loader();
          if (value !== undefined && value !== null) await cache.set(key, value, getOptions);
          else if (getOptions.cacheNull) await cache.set(key, null, getOptions);
        } catch (error) {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'stale-while-revalidate refresh failed',
          );
        } finally {
          inflight.delete(swrKey);
        }
      })();
      inflight.set(swrKey, run);
    };

    return cache;
  };

  return createNamespaced(
    options.namespace ? normaliseKey(options.namespace) : undefined,
    rootStats,
  );
}
