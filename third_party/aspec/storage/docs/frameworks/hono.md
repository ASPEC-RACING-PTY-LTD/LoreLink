# Hono

```ts
import { createStorageHonoHandler } from '@aspec/storage/hono';
app.all('/files/*', createStorageHonoHandler({ storage, basePath: '/files', publicBaseUrl: 'https://app.example/files' }));
```
