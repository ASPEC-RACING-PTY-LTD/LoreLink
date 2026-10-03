# Migration

Prefix `storage_`: `storage_files`, `storage_upload_sessions`, `storage_quota_usage`, `storage_schema_migrations`.

```ts
import { migrate } from '@aspec/storage/sql';
await migrate(client);
```
