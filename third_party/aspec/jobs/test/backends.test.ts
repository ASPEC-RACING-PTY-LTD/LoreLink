import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsError, NonRetryableError } from '../src/errors.js';
import type { JobQueue } from '../src/ports.js';
import { createQueue, type Queue, type QueueOptions } from '../src/queue.js';
import { createScheduler } from '../src/scheduler.js';
import type { Job, JobsBackend } from '../src/types.js';
import { createWorker, type JobHandlers, type Worker, type WorkerOptions } from '../src/worker.js';
import { backendFixtures } from './helpers/backends.js';
import { deferred, type FakeClock, fakeClock, memoryLogger, waitFor } from './helpers/util.js';

async function drain(worker: Worker): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const n = await worker.poll();
    await worker.idle();
    total += n;
    if (n === 0) return total;
  }
  throw new Error('drain did not settle');
}

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  await expect(p).rejects.toMatchObject({ code });
};

for (const fixture of backendFixtures()) {
  describe.skipIf(fixture.skip)(`${fixture.name} backend`, () => {
    beforeAll(() => fixture.setup());
    afterAll(() => fixture.teardown());

    let clock: FakeClock;
    let backend: JobsBackend;

    const setup = async (
      extra: Partial<QueueOptions> = {},
      useFakeClock = true,
    ): Promise<Queue> => {
      backend = await fixture.create();
      clock = fakeClock();
      return createQueue({
        backend,
        ...(useFakeClock ? { clock } : {}),
        retry: { maxAttempts: 3, backoff: { type: 'fixed', delayMs: 1000 } },
        ...extra,
      });
    };

    const worker = (
      queue: Queue,
      handlers: JobHandlers,
      extra: Partial<WorkerOptions> = {},
    ): Worker => createWorker({ queue, handlers, pollIntervalMs: 20, ...extra });

    it('adds jobs and returns them with normalised fields', async () => {
      const queue = await setup();
      const job = await queue.add('email.send', { to: 'a@example.com', n: [1, 2] });
      expect(job.state).toBe('waiting');
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.priority).toBe(0);
      expect(job.progress).toEqual({ percent: 0 });
      const loaded = await queue.getJob(job.id);
      expect(loaded?.payload).toEqual({ to: 'a@example.com', n: [1, 2] });
      expect(loaded?.createdAt.getTime()).toBe(clock.now());
      expect(await queue.getJob('missing')).toBeUndefined();
    });

    it('is idempotent by jobId', async () => {
      const queue = await setup();
      const first = await queue.add('report', { v: 1 }, { jobId: 'report-2026-01' });
      const second = await queue.add('report', { v: 2 }, { jobId: 'report-2026-01' });
      expect(second.id).toBe(first.id);
      expect(second.payload).toEqual({ v: 1 });
      expect((await queue.counts()).waiting).toBe(1);
    });

    it('validates names, payload size and options', async () => {
      const queue = await setup({ limits: { maxPayloadBytes: 64 } });
      await expectCode(queue.add('bad name!', {}), 'JOBS_INVALID_NAME');
      await expectCode(queue.add('ok', { big: 'x'.repeat(100) }), 'JOBS_PAYLOAD_TOO_LARGE');
      await expectCode(queue.add('ok', {}, { priority: 1.5 }), 'JOBS_INVALID_OPTION');
      await expectCode(queue.add('ok', {}, { delayMs: -1 }), 'JOBS_INVALID_OPTION');
      await expectCode(queue.add('ok', {}, { jobId: 'has space' }), 'JOBS_INVALID_OPTION');
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      await expectCode(queue.add('ok', cyclic), 'JOBS_INVALID_PAYLOAD');
      expect((await queue.counts()).waiting).toBe(0);
    });

    it('runs lower priorities first and FIFO within a priority', async () => {
      const queue = await setup();
      const order: string[] = [];
      const specs: [string, number][] = [
        ['p5-a', 5],
        ['p0-a', 0],
        ['p0-b', 0],
        ['pm1', -1],
        ['p5-b', 5],
        ['p0-c', 0],
      ];
      for (const [label, priority] of specs) {
        await queue.add('ordered', { label }, { priority });
        clock.advance(1);
      }
      const w = worker(queue, {
        ordered: async (payload) => {
          order.push((payload as { label: string }).label);
        },
      });
      expect(await drain(w)).toBe(6);
      expect(order).toEqual(['pm1', 'p0-a', 'p0-b', 'p0-c', 'p5-a', 'p5-b']);
    });

    it('holds delayed and runAt jobs until their time', async () => {
      const queue = await setup();
      const ran: string[] = [];
      const delayed = await queue.add('later', { k: 'delay' }, { delayMs: 5000 });
      await queue.add('later', { k: 'runAt' }, { runAt: new Date(clock.now() + 10_000) });
      expect(delayed.state).toBe('scheduled');
      expect((await queue.counts()).scheduled).toBe(2);
      const w = worker(queue, {
        later: async (p) => {
          ran.push((p as { k: string }).k);
        },
      });
      expect(await drain(w)).toBe(0);
      clock.advance(5000);
      expect((await queue.getJob(delayed.id))?.state).toBe('waiting');
      expect(await queue.counts()).toMatchObject({ waiting: 1, scheduled: 1 });
      expect(await drain(w)).toBe(1);
      clock.advance(5000);
      expect(await drain(w)).toBe(1);
      expect(ran).toEqual(['delay', 'runAt']);
    });

    it('retries with fixed backoff and completes', async () => {
      const queue = await setup();
      const failures: { attempt: number; willRetry: boolean; retryAt?: number }[] = [];
      let calls = 0;
      const w = worker(
        queue,
        {
          flaky: async (_p, ctx) => {
            calls += 1;
            expect(ctx.attempt).toBe(calls);
            if (calls < 3) throw Object.assign(new Error(`boom ${calls}`), { code: 'E_FLAKY' });
            return { ok: true };
          },
        },
        {
          onFailed: (job, _err, info) => {
            const entry: { attempt: number; willRetry: boolean; retryAt?: number } = {
              attempt: job.attempts,
              willRetry: info.willRetry,
            };
            if (info.retryAt) entry.retryAt = info.retryAt.getTime();
            failures.push(entry);
          },
        },
      );
      const job = await queue.add('flaky', {});
      await drain(w);
      let current = await queue.getJob(job.id);
      expect(current?.state).toBe('scheduled');
      expect(current?.lastError).toEqual({ message: 'boom 1', code: 'E_FLAKY', name: 'Error' });
      expect(current?.runAt.getTime()).toBe(clock.now() + 1000);
      clock.advance(999);
      expect(await drain(w)).toBe(0);
      clock.advance(1);
      await drain(w);
      clock.advance(1000);
      await drain(w);
      current = await queue.getJob(job.id);
      expect(current?.state).toBe('completed');
      expect(current?.attempts).toBe(3);
      expect(current?.result).toEqual({ ok: true });
      expect(current?.progress.percent).toBe(100);
      expect(failures.map((f) => [f.attempt, f.willRetry])).toEqual([
        [1, true],
        [2, true],
      ]);
    });

    it('applies exponential per-job backoff and custom handler backoff', async () => {
      const queue = await setup();
      const w = worker(queue, {
        expo: async () => {
          throw new Error('expo');
        },
        custom: {
          handler: async () => {
            throw new Error('custom');
          },
          backoff: (attempt, error) =>
            attempt * 7000 + ((error as Error).message === 'custom' ? 1 : 0),
        },
      });
      const expo = await queue.add(
        'expo',
        {},
        {
          maxAttempts: 4,
          backoff: { type: 'exponential', baseMs: 100, factor: 3, maxMs: 500, jitter: 'none' },
        },
      );
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        await drain(w);
        const j = await queue.getJob(expo.id);
        delays.push((j?.runAt.getTime() ?? 0) - clock.now());
        clock.advance(10_000);
      }
      expect(delays).toEqual([100, 300, 500]);
      await drain(w);
      expect((await queue.getJob(expo.id))?.state).toBe('dead');

      const custom = await queue.add('custom', {});
      await drain(w);
      const c = await queue.getJob(custom.id);
      expect((c?.runAt.getTime() ?? 0) - clock.now()).toBe(7001);
    });

    it('fails immediately on NonRetryableError and structural retryable=false', async () => {
      const queue = await setup();
      const dead: string[] = [];
      const failed: boolean[] = [];
      const w = worker(
        queue,
        {
          fatal: async () => {
            throw new NonRetryableError('invalid input', { code: 'E_INPUT' });
          },
          fatal2: async () => {
            throw Object.assign(new Error('no'), { retryable: false });
          },
        },
        {
          onDead: (job) => {
            dead.push(job.id);
          },
          onFailed: (_job, _err, info) => {
            failed.push(info.willRetry);
          },
        },
      );
      const a = await queue.add('fatal', {});
      const b = await queue.add('fatal2', {});
      await drain(w);
      const ja = await queue.getJob(a.id);
      expect(ja?.state).toBe('failed');
      expect(ja?.attempts).toBe(1);
      expect(ja?.lastError).toEqual({
        message: 'invalid input',
        code: 'E_INPUT',
        name: 'NonRetryableError',
      });
      expect((await queue.getJob(b.id))?.state).toBe('failed');
      expect(dead).toEqual([]);
      expect(failed).toEqual([false, false]);
      const retried = await queue.retry(a.id);
      expect(retried.state).toBe('waiting');
      expect(retried.attempts).toBe(0);
    });

    it('moves exhausted jobs to the dead-letter queue and supports retry and purge', async () => {
      const queue = await setup({
        retry: { maxAttempts: 2, backoff: { type: 'fixed', delayMs: 0 } },
      });
      let succeed = false;
      const deadIds: string[] = [];
      const w = worker(
        queue,
        {
          poison: async () => {
            if (!succeed) throw new Error('always');
          },
        },
        { onDead: (job) => void deadIds.push(job.id) },
      );
      const jobs: Job[] = [];
      for (let i = 0; i < 4; i++) jobs.push(await queue.add('poison', { i }));
      await drain(w);
      expect((await queue.counts()).dead).toBe(4);
      expect(deadIds.sort()).toEqual(jobs.map((j) => j.id).sort());
      const dead = await queue.listDead({ limit: 10 });
      expect(dead.jobs).toHaveLength(4);
      expect(dead.jobs[0]?.lastError?.message).toBe('always');
      expect(dead.jobs.every((j) => j.attempts === 2)).toBe(true);

      await expectCode(queue.retry('missing'), 'JOBS_JOB_NOT_FOUND');
      succeed = true;
      const single = await queue.retry(jobs[0]?.id ?? '');
      expect(single.state).toBe('waiting');
      await drain(w);
      expect((await queue.getJob(single.id))?.state).toBe('completed');
      await expectCode(queue.retry(single.id), 'JOBS_INVALID_STATE');

      expect(await queue.retryDead({ limit: 2 })).toEqual({ count: 2 });
      await drain(w);
      expect(await queue.counts()).toMatchObject({ completed: 3, dead: 1 });
      expect(await queue.purgeDead()).toEqual({ count: 1 });
      expect((await queue.counts()).dead).toBe(0);
    });

    it('cancels waiting and scheduled jobs and rejects invalid cancellations', async () => {
      const queue = await setup();
      const a = await queue.add('c', {});
      const b = await queue.add('c', {}, { delayMs: 60_000 });
      expect((await queue.cancel(a.id)).state).toBe('cancelled');
      expect((await queue.cancel(b.id)).state).toBe('cancelled');
      const w = worker(queue, { c: async () => {} });
      expect(await drain(w)).toBe(0);
      await expectCode(queue.cancel(a.id), 'JOBS_INVALID_STATE');
      await expectCode(queue.cancel('nope'), 'JOBS_JOB_NOT_FOUND');
      const done = await queue.add('c', {});
      await drain(w);
      await expectCode(queue.cancel(done.id), 'JOBS_INVALID_STATE');
    });

    it('aborts running jobs cooperatively on cancel and marks them cancelled', async () => {
      const queue = await setup({}, false);
      const started = deferred();
      let reason: unknown;
      const cancelled: string[] = [];
      const w = worker(
        queue,
        {
          long: (_p, ctx) =>
            new Promise((_resolve, reject) => {
              started.resolve();
              ctx.signal.addEventListener('abort', () => {
                reason = ctx.signal.reason;
                reject(ctx.signal.reason);
              });
            }),
        },
        { leaseMs: 5000, onCancelled: (job) => void cancelled.push(job.id) },
      );
      await w.start();
      const job = await queue.add('long', {});
      await started.promise;
      const requested = await queue.cancel(job.id);
      expect(requested.state).toBe('active');
      expect(requested.cancelRequested).toBe(true);
      await waitFor(async () => (await queue.getJob(job.id))?.state === 'cancelled');
      expect(reason).toBeInstanceOf(JobsError);
      expect((reason as JobsError).code).toBe('JOBS_CANCELLED');
      await waitFor(() => cancelled.length === 1);
      await w.stop({ timeoutMs: 1000 });
    });

    it('detects cancellation through heartbeats when no event arrives', async () => {
      const queue = await setup({}, false);
      const started = deferred();
      const w = worker(
        queue,
        {
          long: (_p, ctx) =>
            new Promise((_resolve, reject) => {
              started.resolve();
              ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
            }),
        },
        { leaseMs: 300, heartbeatIntervalMs: 30 },
      );
      await w.start();
      const job = await queue.add('long', {});
      await started.promise;
      // Request cancellation directly in the backend, bypassing the in-process event.
      await backend.cancel(job.id, Date.now());
      await waitFor(async () => (await queue.getJob(job.id))?.state === 'cancelled');
      await w.stop({ timeoutMs: 1000 });
    });

    it('tracks progress with data and stores results', async () => {
      const queue = await setup();
      const reported = deferred();
      const release = deferred();
      const w = worker(queue, {
        work: async (_p, ctx) => {
          await ctx.progress(10);
          await ctx.progress(50, { step: 'half', items: 5 });
          reported.resolve();
          await release.promise;
          await expect(ctx.progress(101)).rejects.toMatchObject({ code: 'JOBS_INVALID_OPTION' });
          return { total: 10 };
        },
      });
      const job = await queue.add('work', {});
      await w.poll();
      await reported.promise;
      const mid = await queue.getJob(job.id);
      expect(mid?.state).toBe('active');
      expect(mid?.progress).toEqual({ percent: 50, data: { step: 'half', items: 5 } });
      expect(mid?.workerId).toBe(w.id);
      release.resolve();
      await w.idle();
      const done = await queue.getJob(job.id);
      expect(done?.state).toBe('completed');
      expect(done?.progress).toEqual({ percent: 100, data: { step: 'half', items: 5 } });
      expect(done?.result).toEqual({ total: 10 });
      expect(done?.finishedAt?.getTime()).toBe(clock.now());
    });

    it('recovers stalled jobs whose lease expired and counts the attempt', async () => {
      const queue = await setup();
      const hang = deferred();
      let aborted: unknown;
      const a = worker(
        queue,
        {
          stuck: async (_p, ctx) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = ctx.signal.reason;
            });
            await hang.promise;
            return 'late result';
          },
        },
        { leaseMs: 1000, heartbeatIntervalMs: 20, stalledCheckIntervalMs: 0 },
      );
      const job = await queue.add('stuck', {});
      expect(await a.poll()).toBe(1);
      clock.advance(5000);
      const recovered = await queue.recoverStalled();
      expect(recovered.map((j) => [j.id, j.state, j.attempts])).toEqual([[job.id, 'waiting', 1]]);
      expect(recovered[0]?.lastError?.code).toBe('JOBS_STALLED');
      await waitFor(() => aborted !== undefined);
      expect((aborted as JobsError).code).toBe('JOBS_LEASE_LOST');

      const b = worker(queue, { stuck: async (_p, ctx) => `attempt ${ctx.attempt}` });
      await drain(b);
      hang.resolve();
      await a.idle();
      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('completed');
      expect(final?.attempts).toBe(2);
      expect(final?.result).toBe('attempt 2');

      const once = await queue.add('stuck', {}, { maxAttempts: 1 });
      const hang2 = deferred();
      const c = worker(
        queue,
        { stuck: () => hang2.promise },
        { leaseMs: 1000, stalledCheckIntervalMs: 0 },
      );
      await c.poll();
      clock.advance(5000);
      const again = await queue.recoverStalled();
      expect(again.map((j) => [j.id, j.state])).toEqual([[once.id, 'dead']]);
      hang2.resolve();
      await c.idle();
      expect((await queue.getJob(once.id))?.state).toBe('dead');
    });

    it('stops gracefully: waits for jobs, aborts after the timeout and releases leases', async () => {
      const queue = await setup({}, false);
      const quickStarted = deferred();
      const slowStarted = deferred();
      let slowReason: unknown;
      const w = worker(
        queue,
        {
          quick: async () => {
            quickStarted.resolve();
            await new Promise((r) => setTimeout(r, 50));
            return 'done';
          },
          slow: (_p, ctx) =>
            new Promise(() => {
              slowStarted.resolve();
              ctx.signal.addEventListener('abort', () => {
                slowReason = ctx.signal.reason;
              });
            }),
        },
        { concurrency: 2, leaseMs: 5000 },
      );
      const quick = await queue.add('quick', {});
      const slow = await queue.add('slow', {});
      await w.start();
      await Promise.all([quickStarted.promise, slowStarted.promise]);
      const startedAt = Date.now();
      const result = await w.stop({ timeoutMs: 300 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(result).toEqual({ aborted: 1 });
      expect(w.state).toBe('stopped');
      expect((slowReason as JobsError).code).toBe('JOBS_SHUTDOWN');
      expect((await queue.getJob(quick.id))?.state).toBe('completed');
      const released = await queue.getJob(slow.id);
      expect(released?.state).toBe('waiting');
      expect(released?.attempts).toBe(0);
      expect(released?.workerId).toBeUndefined();
      await expect(w.start()).rejects.toMatchObject({ code: 'JOBS_WORKER_STATE' });

      const idleWorker = worker(queue, { quick: async () => 'x' });
      await idleWorker.start();
      expect(await idleWorker.stop({ timeoutMs: 1000 })).toEqual({ aborted: 0 });
    });

    it('pauses and resumes a running worker', async () => {
      const queue = await setup({}, false);
      const seen: number[] = [];
      const w = worker(queue, { t: async (p) => void seen.push((p as { n: number }).n) });
      await w.start();
      await queue.add('t', { n: 1 });
      await waitFor(() => seen.length === 1);
      w.pause();
      expect(w.state).toBe('paused');
      await queue.add('t', { n: 2 });
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([1]);
      w.resume();
      await waitFor(() => seen.length === 2);
      await w.stop();
      expect((await w.checkHealth()).ok).toBe(false);
    });

    it('lists jobs by state and name with pagination and counts', async () => {
      const queue = await setup();
      for (let i = 0; i < 5; i++) await queue.add('a', { i });
      for (let i = 0; i < 3; i++) await queue.add('b', { i }, { delayMs: 1000 });
      const page1 = await queue.listJobs({ name: 'a', limit: 2 });
      expect(page1.jobs.map((j) => (j.payload as { i: number }).i)).toEqual([4, 3]);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await queue.listJobs({ name: 'a', limit: 2, cursor: page1.nextCursor ?? '' });
      expect(page2.jobs.map((j) => (j.payload as { i: number }).i)).toEqual([2, 1]);
      const page3 = await queue.listJobs({ name: 'a', limit: 2, cursor: page2.nextCursor ?? '' });
      expect(page3.jobs).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();
      expect((await queue.listJobs({ state: 'scheduled' })).jobs).toHaveLength(3);
      expect((await queue.listJobs({ state: 'waiting' })).jobs).toHaveLength(5);
      expect(await queue.counts()).toEqual({
        waiting: 5,
        scheduled: 3,
        active: 0,
        completed: 0,
        failed: 0,
        dead: 0,
        cancelled: 0,
      });
      expect((await queue.counts({ name: 'b' })).scheduled).toBe(3);
      await expectCode(queue.listJobs({ cursor: 'garbage' }), 'JOBS_INVALID_OPTION');
      await expectCode(queue.listJobs({ state: 'bogus' as never }), 'JOBS_INVALID_OPTION');
    });

    it('cleans up finished jobs past their retention', async () => {
      const queue = await setup({ retention: { completedMs: 1000, cancelledMs: 1000 } });
      const w = worker(queue, { r: async () => {} });
      await queue.add('r', {});
      await queue.add('r', {});
      await drain(w);
      const cancelled = await queue.add('r', {}, { delayMs: 10 });
      await queue.cancel(cancelled.id);
      const keep = await queue.add('r', {}, { delayMs: 100_000 });
      expect((await queue.cleanup()).deleted).toBe(0);
      clock.advance(1001);
      expect((await queue.cleanup()).deleted).toBe(3);
      expect((await queue.listJobs()).jobs.map((j) => j.id)).toEqual([keep.id]);
    });

    it('enqueues exactly once per tick across two schedulers', async () => {
      const queue = await setup();
      clock.set(Date.UTC(2026, 0, 1, 0, 0, 0));
      const schedules = [
        { id: 'minutely', name: 'tick', cron: '* * * * *', payload: { kind: 'cron' } },
        { id: 'every-30s', name: 'tick', every: 30_000, payload: { kind: 'every' } },
      ];
      const s1 = createScheduler({ queue, schedules, clock });
      const s2 = createScheduler({ queue, schedules, clock });
      for (let i = 0; i < 12; i++) {
        clock.advance(15_000);
        await Promise.all([s1.tick(), s2.tick()]);
        await s2.tick();
      }
      // 3 minutes: 3 cron ticks, 6 interval ticks.
      const counts = await queue.counts({ name: 'tick' });
      expect(counts.waiting).toBe(9);
      const jobs = (await queue.listJobs({ name: 'tick', limit: 100 })).jobs;
      expect(new Set(jobs.map((j) => j.id)).size).toBe(9);
      expect(jobs.filter((j) => (j.payload as { kind: string }).kind === 'cron')).toHaveLength(3);
    });

    it('satisfies the JobQueue port and runs handlers of the documented signature', async () => {
      const queue = await setup();
      const port: JobQueue = queue;
      const seen: { payload: unknown; attempt: number; aborted: boolean }[] = [];
      // The handler factory shape exported by notifications, webhooks and users.
      const createDeliveryJobHandler =
        () =>
        async (payload: unknown, ctx: { signal: AbortSignal; attempt: number }): Promise<void> => {
          seen.push({ payload, attempt: ctx.attempt, aborted: ctx.signal.aborted });
        };
      const { id } = await port.add(
        'notifications.delivery',
        { messageId: 'm1' },
        {
          priority: 1,
          maxAttempts: 5,
          jobId: 'delivery-m1',
        },
      );
      expect(id).toBe('delivery-m1');
      const w = worker(queue, { 'notifications.delivery': createDeliveryJobHandler() });
      await drain(w);
      expect(seen).toEqual([{ payload: { messageId: 'm1' }, attempt: 1, aborted: false }]);
      expect((await queue.getJob(id))?.maxAttempts).toBe(5);
    });

    it('reports health and logs failures without stacks in stored errors', async () => {
      const logger = memoryLogger();
      const queue = await setup({ logger, retry: { maxAttempts: 1 } });
      expect(await queue.checkHealth()).toMatchObject({
        ok: true,
        details: { backend: backend.kind },
      });
      const w = worker(queue, {
        s: async () => {
          throw new Error('with stack');
        },
      });
      const job = await queue.add('s', {});
      await drain(w);
      const stored = await queue.getJob(job.id);
      expect(stored?.lastError).toEqual({ message: 'with stack', name: 'Error' });
      expect(JSON.stringify(stored)).not.toContain('at ');
      const failure = logger.entries.find((e) => e.msg === 'jobs: attempt failed');
      expect(String(failure?.obj.stack)).toContain('with stack');
    });
  });
}
