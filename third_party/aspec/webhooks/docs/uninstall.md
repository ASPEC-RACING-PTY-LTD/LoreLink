# Uninstall

1. Unmount admin routers and unregister `webhooks.deliver`.
2. Remove `WEBHOOKS_ENCRYPTION_KEY`.
3. `pnpm remove @aspec/webhooks`.
4. Drop `webhooks_*` tables if using SQL. Data is not removed automatically.
