# AI integration

## Purpose

Provide `CacheLike` with memory/Redis stores, namespaces, tags and cache-aside helpers that fail open by default.

## Use when

- Modules need optional caching (rbac, flags, api-keys).
- You need LRU, Redis, tags or `getOrSet` single-flight.

## Avoid when

- You need durable storage or exactly-once delivery.

## Prerequisites

Node 22.13+. Redis client package only when using Redis/tiered stores.

## Integration steps

1. `pnpm add @aspec/cache`.
2. `const cache = createCache({ store: 'memory', failOpen: true })`.
3. Use `key('user', id)` for keys.
4. Prefer `getOrSet(key, loader, { ttlMs })` for cache-aside.
5. Pass `cache` where `CacheLike` is accepted.
6. `await cache.close()` on shutdown if you own the client.

## Configuration

See [configure.md](configure.md).

## Verification

```bash
node -e "import('@aspec/cache').then(async m => { const c=m.createCache(); console.log(await c.checkHealth()); await c.close(); })"
```

Expect `{ ok: true, ... }`.

## Common mistakes

- Caching secrets.
- Setting `failOpen: false` without handling `CACHE_UNAVAILABLE`.
- Using `KEYS` in custom Redis code (this module uses `SCAN`).

## Uninstall

See [uninstall.md](uninstall.md).
