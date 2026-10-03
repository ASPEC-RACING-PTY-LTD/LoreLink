# Express

```ts
import { createStorageMiddleware } from '@aspec/storage/express';
app.use('/files', createStorageMiddleware({ storage, publicBaseUrl: 'https://app.example/files' }));
```

Do not mount a body parser ahead of this middleware for upload routes. Tested with Express 5.2.1 and Express 4.22.3 (`express4` package).
