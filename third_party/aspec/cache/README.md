# @aspec/cache

Caching abstraction with in-memory and Redis-compatible stores, TTLs, namespaces, tags, invalidation, statistics, health checks and cache-aside helpers.

## Install

```bash
pnpm add @aspec/cache
# optional Redis clients:
pnpm add ioredis
# or
pnpm add redis
```

## Quick start

```ts
import { createCache, key } from '@aspec/cache';

const cache = createCache({ store: 'memory', defaultTtlMs: 60_000 });
await cache.set(key('user', 1), { id: 1 });
const user = await cache.getOrSet(key('user', 2), async () => loadUser(2));
```

## Docs

See [docs/summary.md](docs/summary.md), [docs/integrate.md](docs/integrate.md), [docs/api.md](docs/api.md) and [docs/ai.md](docs/ai.md).
