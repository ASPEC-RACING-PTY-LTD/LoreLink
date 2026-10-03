# Migration

Tables (prefix `webhooks_`): `subscriptions`, `events`, `deliveries`, `delivery_attempts`,
`seen_ids`, `schema_migrations`.

```ts
import { migrate } from '@aspec/webhooks/sql';
await migrate(sql);
```

Memory store needs no migration. First release is 1.0.0.
