# Fetch

```ts
import { createJobsAdminFetchHandler } from '@aspec/jobs/fetch';
export default createJobsAdminFetchHandler({ queue, authorize: async () => true, basePath: '/admin/jobs' });
```
