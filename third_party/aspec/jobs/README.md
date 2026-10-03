# @aspec/jobs

Background job queues with scheduling, retries, cancellation, progress, dead-letter queues, priorities, workers and graceful shutdown.

## Install

```bash
aspec add aspec/jobs
pnpm add @aspec/jobs
```

## Quick start

```ts
import { createQueue, createWorker, createMemoryBackend } from '@aspec/jobs';

const queue = createQueue({ backend: createMemoryBackend() });
const worker = createWorker({
  queue,
  handlers: {
    'email.send': async (payload, ctx) => {
      ctx.logger.info({ attempt: ctx.attempt }, 'sending');
    },
  },
});
await worker.start();
await queue.add('email.send', { to: 'user@example.com' });
```

Docs live under `docs/` and are referenced from `aspec.module.json`.
