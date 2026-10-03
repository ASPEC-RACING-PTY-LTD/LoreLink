# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOKS_ENCRYPTION_KEY` | yes | AES-256-GCM key for secret ciphertext (32 bytes) |

## Factory

`createWebhooks({ store, jobs?, logger, clock, generateId, security, retry, onSubscriptionDisabled })`

`security.encryptionKey` or `WEBHOOKS_ENCRYPTION_KEY`. `security.ssrf.requireHttps` defaults
true. `security.ssrf.allowHosts` is a development allowlist for private destinations.
`security.disableAfterFailures` defaults to 10. Delivery timeouts and max response size are
under `security.delivery`.

SQL: `migrate(client)` then `createSqlStore(client, { tablePrefix })`.
