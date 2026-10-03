# Uninstall

1. Remove setup imports and stop injecting the cache.
2. `pnpm remove @aspec/cache` (and unused Redis clients).
3. Optionally `SCAN`/`DEL` keys under your prefix in Redis.
