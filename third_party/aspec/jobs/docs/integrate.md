# Integrate

```ts
import { createQueue, createWorker, createMemoryBackend, installShutdownHandlers } from '@aspec/jobs';

const queue = createQueue({ backend: createMemoryBackend() });
const worker = createWorker({
  queue,
  handlers: { 'reports.run': async (payload, ctx) => { await ctx.progress(50); } },
  concurrency: 4,
});
await worker.start();
installShutdownHandlers(worker);
```

SQL:

```ts
import { createSqlBackend, migrate } from '@aspec/jobs/sql';
await migrate(sqlClient);
const queue = createQueue({ backend: createSqlBackend(sqlClient) });
```
