# Express

```ts
import { createJobsAdminMiddleware } from '@aspec/jobs/express';
app.use('/admin/jobs', createJobsAdminMiddleware({ queue, authorize: async () => true }));
```
