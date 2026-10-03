# Examples

## Memory with tags

```ts
const cache = createCache({ store: 'memory', defaultTtlMs: 60_000 });
await cache.set('u:1', user, { tags: ['user'] });
await cache.invalidateTag('user');
```

## Redis (ioredis)

```ts
import { Redis } from 'ioredis';
import { createCache, createRedisStore } from '@aspec/cache';

const redis = new Redis(process.env.REDIS_URL!);
const cache = createCache({
  store: createRedisStore({ client: redis, ownsClient: true }),
  failOpen: true,
});
```

## Cache-aside with SWR

```ts
const profile = await cache.getOrSet(
  key('profile', id),
  () => db.loadProfile(id),
  { ttlMs: 30_000, staleWhileRevalidateMs: 5_000 },
);
```
