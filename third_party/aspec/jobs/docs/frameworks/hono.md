# Hono

```ts
import { createJobsAdminHonoHandler } from '@aspec/jobs/hono';
app.all('/admin/jobs/*', createJobsAdminHonoHandler({ basePath: '/admin/jobs', queue, authorize: async () => true }));
```
