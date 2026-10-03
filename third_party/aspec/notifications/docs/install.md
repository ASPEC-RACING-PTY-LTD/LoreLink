# Install

## CLI

```bash
aspec add aspec/notifications
```

Package mode installs `@aspec/notifications`. Vendor mode copies sources under your
project vendor directory.

## Manual

```bash
pnpm add @aspec/notifications
pnpm add nodemailer            # required for @aspec/notifications/smtp
pnpm add express               # optional, for @aspec/notifications/express
pnpm add fastify               # optional, for @aspec/notifications/fastify
pnpm add hono                  # optional, for @aspec/notifications/hono
```

Node.js `>=22.13.0` is required. For SQL persistence, provide a `SqlClient` from
`@aspec/db` or your own adapter implementing the port.
