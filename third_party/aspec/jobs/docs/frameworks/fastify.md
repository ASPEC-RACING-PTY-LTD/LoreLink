# Fastify

```ts
import { jobsAdminFastifyPlugin } from '@aspec/jobs/fastify';
await app.register(jobsAdminFastifyPlugin, { prefix: '/admin/jobs', queue, authorize: async () => true });
```
