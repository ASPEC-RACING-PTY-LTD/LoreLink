# Integrate

1. Install `@aspec/cache` (and `ioredis` or `redis` if needed).
2. Generate setup with `aspec add aspec/cache` or copy the generic template.
3. Use the cache:

```ts
import { cache } from './aspec/cache.setup.js';
import { key } from '@aspec/cache';

await cache.set(key('flag', 'x'), true, { ttlMs: 30_000 });
const value = await cache.getOrSet(key('user', id), () => loadUser(id), { ttlMs: 60_000 });
```

4. Pass `cache` into modules that accept `CacheLike`. Treat failures as misses (default `failOpen: true`).
5. Call `await cache.close()` on shutdown when you own the Redis client.
