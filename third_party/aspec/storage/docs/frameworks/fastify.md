# Fastify

```ts
import { storageFastifyPlugin } from '@aspec/storage/fastify';
await storageFastifyPlugin(app, { storage, publicBaseUrl: 'https://app.example/files' });
// or register with a prefix after wiring routes for '/' and '/*'
```
