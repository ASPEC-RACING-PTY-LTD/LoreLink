import { afterAll, describe, expect, it } from 'vitest';
import { createJobsAdminFetchHandler } from '../src/adapters/fetch.js';
import { createQueue } from '../src/queue.js';
import { createMemoryBackend } from '../src/stores/memory.js';
import { createSqlBackend, migrate } from '../src/stores/sql.js';
import { createWorker } from '../src/worker.js';
import { createPostgresClient, POSTGRES_URL } from './helpers/sql.js';
import { waitFor } from './helpers/util.js';

describe('admin fetch adapter', () => {
  it('lists, retries and cancels with authorisation', async () => {
    const queue = createQueue({ backend: createMemoryBackend() });
    const allow = new Set(['jobs:read', 'jobs:retry', 'jobs:cancel']);
    const handler = createJobsAdminFetchHandler({
      queue,
      authorize: ({ action }) => allow.has(action),
      includePayload: true,
      basePath: '/admin/jobs',
    });
    const job = await queue.add('demo', { n: 1 });
    const list = await handler(new Request('http://localhost/admin/jobs/jobs'));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { jobs: { id: string }[] };
    expect(listed.jobs.some((j) => j.id === job.id)).toBe(true);

    allow.delete('jobs:cancel');
    const denied = await handler(
      new Request(`http://localhost/admin/jobs/jobs/${job.id}/cancel`, { method: 'POST' }),
    );
    expect(denied.status).toBe(403);

    allow.add('jobs:cancel');
    const cancelled = await handler(
      new Request(`http://localhost/admin/jobs/jobs/${job.id}/cancel`, { method: 'POST' }),
    );
    expect(cancelled.status).toBe(200);
    expect((await queue.getJob(job.id))?.state).toBe('cancelled');
  });
});

describe.skipIf(!POSTGRES_URL)('postgres multi-worker exactly-once', () => {
  let close: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await close?.();
  });

  it('claims each job once across two workers', async () => {
    const url = POSTGRES_URL;
    if (!url) throw new Error('POSTGRES_URL unset');
    const client = await createPostgresClient(url);
    close = () => client.close();
    await migrate(client);
    const backend = createSqlBackend(client);
    const queue = createQueue({ backend });
    const seen: string[] = [];
    const handlers = {
      once: async (payload: unknown) => {
        seen.push((payload as { id: string }).id);
        await new Promise((r) => setTimeout(r, 30));
      },
    };
    const w1 = createWorker({
      queue,
      handlers,
      concurrency: 2,
      pollIntervalMs: 20,
      workerId: 'w1',
    });
    const w2 = createWorker({
      queue,
      handlers,
      concurrency: 2,
      pollIntervalMs: 20,
      workerId: 'w2',
    });
    await w1.start();
    await w2.start();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const job = await queue.add('once', { id: `j${i}` });
      ids.push(job.id);
    }
    await waitFor(() => seen.length === 20, 10_000);
    await w1.stop();
    await w2.stop();
    expect(seen.sort()).toEqual(ids.map((_, i) => `j${i}`).sort());
    expect(new Set(seen).size).toBe(20);
    expect((await queue.counts()).completed).toBe(20);
  });
});
