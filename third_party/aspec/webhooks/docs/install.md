# Install

```bash
aspec add aspec/webhooks
# or
pnpm add @aspec/webhooks
```

Optional peers: `express`, `fastify`, `hono` for HTTP adapters. Requires Node.js `>=22.13.0`
and `WEBHOOKS_ENCRYPTION_KEY` (32-byte key as base64 or 64-char hex).
