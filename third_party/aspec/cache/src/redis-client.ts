/** Loose structural client accepted from ioredis or node-redis. */
export type RedisCommandClient = {
  get(key: string): Promise<string | null>;
  // Overloaded across clients; we call it carefully inside the adapter.
  set: (...args: never[]) => Promise<unknown>;
  del: (...args: never[]) => Promise<number>;
  pttl?: (key: string) => Promise<number>;
  ping: (...args: never[]) => Promise<unknown>;
  quit?: (...args: never[]) => Promise<unknown>;
  disconnect?: (...args: never[]) => unknown;
  duplicate?: (...args: never[]) => RedisCommandClient & RedisPubSubClient;
  scan?: (...args: never[]) => Promise<[string, string[]]>;
  sAdd?: (...args: never[]) => Promise<number>;
  sRem?: (...args: never[]) => Promise<number>;
  sMembers?: (...args: never[]) => Promise<string[]>;
  incr?: (...args: never[]) => Promise<number>;
  setex?: (...args: never[]) => Promise<unknown>;
  psetex?: (...args: never[]) => Promise<unknown>;
  sadd?: (...args: never[]) => Promise<number>;
  srem?: (...args: never[]) => Promise<number>;
  smembers?: (...args: never[]) => Promise<string[]>;
  call?: (...args: never[]) => Promise<unknown>;
  publish?: (...args: never[]) => Promise<number>;
  subscribe?: (...args: never[]) => Promise<unknown>;
  unsubscribe?: (...args: never[]) => Promise<unknown>;
  on?: (...args: never[]) => unknown;
};

export interface RedisPubSubClient {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(keys: string[]): Promise<number>;
  pttl(key: string): Promise<number>;
  ping(): Promise<void>;
  scan(match: string, count?: number): AsyncGenerator<string[], void, void>;
  sadd(key: string, members: string[]): Promise<void>;
  srem(key: string, members: string[]): Promise<void>;
  smembers(key: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export const REDIS_ADAPTER = Symbol.for('@aspec/cache.isRedisAdapter');

export function isRedisAdapter(value: unknown): value is RedisAdapter {
  return Boolean(value && typeof value === 'object' && REDIS_ADAPTER in (value as object));
}

/** Adapts an ioredis or node-redis client to a uniform RedisAdapter. */
export function adaptRedisClient(
  client: RedisCommandClient,
  options: { ownsClient?: boolean } = {},
): RedisAdapter {
  if (isRedisAdapter(client)) return client;
  const owns = options.ownsClient ?? false;
  const c = client as RedisCommandClient & Record<string, (...args: never[]) => Promise<unknown>>;

  const del = async (keys: string[]): Promise<number> => {
    if (keys.length === 0) return 0;
    return Number(await (c.del as (...a: string[]) => Promise<number>)(...keys));
  };

  const sadd = async (key: string, members: string[]): Promise<void> => {
    if (members.length === 0) return;
    if (typeof c.sAdd === 'function')
      await (c.sAdd as (...a: string[]) => Promise<number>)(key, ...members);
    else if (typeof c.sadd === 'function')
      await (c.sadd as (...a: string[]) => Promise<number>)(key, ...members);
    else if (typeof c.call === 'function')
      await (c.call as (...a: (string | number)[]) => Promise<unknown>)('SADD', key, ...members);
  };

  const srem = async (key: string, members: string[]): Promise<void> => {
    if (members.length === 0) return;
    if (typeof c.sRem === 'function')
      await (c.sRem as (...a: string[]) => Promise<number>)(key, ...members);
    else if (typeof c.srem === 'function')
      await (c.srem as (...a: string[]) => Promise<number>)(key, ...members);
    else if (typeof c.call === 'function')
      await (c.call as (...a: (string | number)[]) => Promise<unknown>)('SREM', key, ...members);
  };

  const smembers = async (key: string): Promise<string[]> => {
    if (typeof c.sMembers === 'function')
      return (c.sMembers as (k: string) => Promise<string[]>)(key);
    if (typeof c.smembers === 'function')
      return (c.smembers as (k: string) => Promise<string[]>)(key);
    if (typeof c.call === 'function')
      return (await (c.call as (...a: string[]) => Promise<unknown>)('SMEMBERS', key)) as string[];
    return [];
  };

  const incr = async (key: string): Promise<number> => {
    if (typeof c.incr === 'function') return (c.incr as (k: string) => Promise<number>)(key);
    if (typeof c.call === 'function')
      return Number(await (c.call as (...a: string[]) => Promise<unknown>)('INCR', key));
    throw new Error('Redis client does not support INCR');
  };

  async function* scan(match: string, count = 100): AsyncGenerator<string[], void, void> {
    let cursor: string | number = '0';
    do {
      let next: string;
      let keys: string[];
      if (typeof c.scan === 'function') {
        const result = (await (
          c.scan as (cursor: string | number, ...a: unknown[]) => Promise<[string, string[]]>
        )(cursor, 'MATCH', match, 'COUNT', count)) as [string, string[]];
        next = String(result[0]);
        keys = result[1] ?? [];
      } else if (typeof c.call === 'function') {
        const result = (await (c.call as (...a: (string | number)[]) => Promise<unknown>)(
          'SCAN',
          String(cursor),
          'MATCH',
          match,
          'COUNT',
          count,
        )) as [string, string[]];
        next = String(result[0]);
        keys = result[1] ?? [];
      } else {
        return;
      }
      cursor = next;
      if (keys.length > 0) yield keys;
    } while (String(cursor) !== '0');
  }

  const adapter: RedisAdapter = {
    async get(key) {
      const value = await (c.get as (k: string) => Promise<string | null>)(key);
      return value === undefined ? null : value;
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined && ttlMs > 0) {
        if (typeof c.psetex === 'function') {
          await (c.psetex as (...a: (string | number)[]) => Promise<unknown>)(
            key,
            Math.ceil(ttlMs),
            value,
          );
          return;
        }
        // Prefer ioredis token form; node-redis accepts an options object.
        try {
          await (c.set as (...a: unknown[]) => Promise<unknown>)(
            key,
            value,
            'PX',
            Math.ceil(ttlMs),
          );
          return;
        } catch {
          await (c.set as (...a: unknown[]) => Promise<unknown>)(key, value, {
            PX: Math.ceil(ttlMs),
          });
          return;
        }
      }
      await (c.set as (...a: unknown[]) => Promise<unknown>)(key, value);
    },
    del,
    async pttl(key) {
      if (typeof c.pttl === 'function') return (c.pttl as (k: string) => Promise<number>)(key);
      if (typeof c.call === 'function')
        return Number(await (c.call as (...a: string[]) => Promise<unknown>)('PTTL', key));
      return -1;
    },
    async ping() {
      await (c.ping as () => Promise<unknown>)();
    },
    scan,
    sadd,
    srem,
    smembers,
    incr,
    async publish(channel, message) {
      if (typeof c.publish === 'function')
        await (c.publish as (...a: string[]) => Promise<number>)(channel, message);
    },
    async subscribe(channel, onMessage) {
      const base = c as RedisCommandClient & RedisPubSubClient;
      const sub =
        typeof base.duplicate === 'function'
          ? (base.duplicate as () => RedisCommandClient & RedisPubSubClient)()
          : base;
      const maybeConnect = (sub as unknown as { connect?: () => Promise<unknown> }).connect;
      if (typeof maybeConnect === 'function') await maybeConnect.call(sub);
      const handler = (...args: unknown[]) => {
        if (args.length >= 2 && typeof args[1] === 'string') onMessage(args[1] as string);
        else if (typeof args[0] === 'string') onMessage(args[0] as string);
      };
      if (typeof sub.on === 'function')
        (sub.on as (e: string, l: (...a: unknown[]) => void) => unknown)('message', handler);
      await (sub.subscribe as (...a: string[]) => Promise<unknown>)(channel);
      return async () => {
        try {
          await (sub.unsubscribe as (...a: string[]) => Promise<unknown>)(channel);
        } finally {
          if (sub !== base) {
            if (typeof sub.quit === 'function') await sub.quit();
            else sub.disconnect?.();
          }
        }
      };
    },
    async close() {
      if (!owns) return;
      if (typeof c.quit === 'function') await (c.quit as () => Promise<unknown>)();
      else c.disconnect?.();
    },
  };
  Object.defineProperty(adapter, REDIS_ADAPTER, { value: true });
  return adapter;
}
