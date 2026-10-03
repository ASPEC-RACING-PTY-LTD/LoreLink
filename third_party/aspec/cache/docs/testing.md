# Testing

```powershell
$env:ASPEC_TEST_REDIS_URL='redis://127.0.0.1:56379'
pnpm --filter @aspec/cache test
```

Memory tests always run. Redis, node-redis and tiered pub/sub tests run when `ASPEC_TEST_REDIS_URL` is set (Valkey-compatible). Unreachable Redis fail-open tests do not need a server. Without the variable, Redis cases are skipped.
