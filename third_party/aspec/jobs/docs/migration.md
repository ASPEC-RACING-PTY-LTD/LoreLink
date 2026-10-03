# Migration

Prefix `jobs_` (configurable): tables `jobs_jobs`, `jobs_schema_migrations`.

```ts
import { migrate } from '@aspec/jobs/sql';
await migrate(client);
```
