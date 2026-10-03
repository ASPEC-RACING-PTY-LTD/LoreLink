# Migration

## SQL tables

Default prefix `notifications_`:

- `notifications_items` (in-app)
- `notifications_deliveries`
- `notifications_delivery_attempts`
- `notifications_preferences`
- `notifications_schema_migrations`

```ts
import { migrate } from '@aspec/notifications/sql';
await migrate(sqlClient, { tablePrefix: 'notifications_' });
```

Migrations are idempotent. The memory store needs no migration.

## Upgrades

Version 1.0.0 is the first release. Future schema changes ship as additional migration
IDs in `migrations`.
