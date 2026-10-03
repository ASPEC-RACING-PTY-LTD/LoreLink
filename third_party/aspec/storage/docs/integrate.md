# Integrate

```ts
import { createStorage } from '@aspec/storage';
import { createLocalDriver } from '@aspec/storage/local';
import { createMemoryMetadataStore } from '@aspec/storage/memory';

const storage = createStorage({
  driver: createLocalDriver({ root: process.env.STORAGE_ROOT! }),
  metadata: createMemoryMetadataStore(),
  signingSecret: process.env.STORAGE_SIGNING_SECRET!,
});
```

SQL metadata:

```ts
import { createSqlMetadataStore, migrate } from '@aspec/storage/sql';
await migrate(sqlClient);
const metadata = createSqlMetadataStore(sqlClient);
```

S3:

```ts
import { createS3Driver } from '@aspec/storage/s3';
const driver = createS3Driver({
  bucket: process.env.STORAGE_S3_BUCKET!,
  endpoint: process.env.STORAGE_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_S3_ACCESS_KEY!,
    secretAccessKey: process.env.STORAGE_S3_SECRET_KEY!,
  },
});
```
