# Install

```bash
aspec add aspec/jobs
pnpm add @aspec/jobs
```

Optional peers for admin HTTP adapters: `express` (^4.18 || ^5), `fastify` (^5), `hono` (^4). Runtime dependency: `croner`. For PostgreSQL, provide a `SqlClient`.
