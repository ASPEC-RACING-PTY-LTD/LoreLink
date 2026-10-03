import { hostname } from 'node:os';
import { computeBackoff, validateBackoff } from './backoff.js';
import { invalidOption, isNonRetryable, JobsError, JobsErrorCode } from './errors.js';
import { assertJobName, errorInfo, randomToken, toJob, toJson } from './internal.js';
import type { HealthCheckable, HealthCheckResult, LoggerLike } from './ports.js';
import type { Queue } from './queue.js';
import type { BackendEvent, BackoffPolicy, Job, JobRecord } from './types.js';

/** Context passed to handlers. Compatible with `{ signal: AbortSignal; attempt: number }`. */
export interface JobContext {
  /** Aborted when the job is cancelled, the lease is lost or the worker shuts down. */
  signal: AbortSignal;
  /** 1-based attempt number. */
  attempt: number;
  job: {
    id: string;
    name: string;
    priority: number;
    maxAttempts: number;
    createdAt: Date;
    runAt: Date;
  };
  /** Reports progress (0 to 100) with optional JSON data. Writes are coalesced. */
  progress(percent: number, data?: unknown): Promise<void>;
  logger: LoggerLike;
}

/** Handler signature. The resolved value is stored as the job result (JSON, size limited). */
export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<unknown>;

export interface JobHandlerDefinition {
  handler: JobHandler;
  /** Backoff for this job name. Per-job `backoff` wins; the queue default applies otherwise. */
  backoff?: BackoffPolicy;
}

export type JobHandlers = Record<string, JobHandler | JobHandlerDefinition>;

export interface FailureInfo {
  willRetry: boolean;
  retryAt?: Date;
}

export interface WorkerOptions {
  queue: Queue;
  handlers: JobHandlers;
  /** Jobs processed in parallel by this worker. Default 1. */
  concurrency?: number;
  /** Delay between polls when idle, in milliseconds. Default 1000. */
  pollIntervalMs?: number;
  /** Lease duration in milliseconds. Renewed by heartbeats while a job runs. Default 30000. */
  leaseMs?: number;
  /** Heartbeat interval in milliseconds. Default leaseMs / 3. */
  heartbeatIntervalMs?: number;
  /** Interval for stalled job recovery in milliseconds. 0 disables. Default leaseMs. */
  stalledCheckIntervalMs?: number;
  /** Identifier stored on claimed jobs. Default hostname, pid and a random suffix. */
  workerId?: string;
  onCompleted?(job: Job, result: unknown): void | Promise<void>;
  onFailed?(job: Job, error: unknown, info: FailureInfo): void | Promise<void>;
  onDead?(job: Job, error: unknown): void | Promise<void>;
  onCancelled?(job: Job): void | Promise<void>;
}

export type WorkerState = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';

export interface StopOptions {
  /** How long to wait for running jobs before aborting them. Default 30000. */
  timeoutMs?: number;
}

export interface Worker extends HealthCheckable {
  readonly id: string;
  readonly state: WorkerState;
  /** Number of jobs currently running on this worker. */
  readonly activeCount: number;
  /** Starts polling, heartbeats and stalled job recovery. */
  start(): Promise<void>;
  /** Stops claiming new jobs. Running jobs continue. */
  pause(): void;
  /** Resumes claiming after `pause()`. */
  resume(): void;
  /**
   * Graceful shutdown: stops claiming, waits up to `timeoutMs` for running jobs, then aborts
   * the remaining ones and releases their leases (the interrupted attempt is not counted).
   */
  stop(options?: StopOptions): Promise<{ aborted: number }>;
  /** Claims and starts up to the free capacity once. Returns the number of jobs started. */
  poll(): Promise<number>;
  /** Resolves when no job is running on this worker. */
  idle(): Promise<void>;
}

type AbortCause = 'cancel' | 'shutdown' | 'lease-lost';

interface ActiveJob {
  record: JobRecord;
  controller: AbortController;
  cause?: AbortCause;
  settled: Promise<void>;
}

interface ResolvedHandler {
  handler: JobHandler;
  backoff?: BackoffPolicy;
}

function intOption(value: number | undefined, option: string, fallback: number, min: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > 2_147_483_647) {
    throw invalidOption(option, `must be an integer of at least ${min}`);
  }
  return value;
}

const abortError = (cause: AbortCause): JobsError => {
  if (cause === 'cancel') {
    return new JobsError(JobsErrorCode.Cancelled, 'Job was cancelled', { status: 409 });
  }
  if (cause === 'shutdown') {
    return new JobsError(JobsErrorCode.Shutdown, 'Worker is shutting down', { status: 503 });
  }
  return new JobsError(JobsErrorCode.LeaseLost, 'Job lease was lost', { status: 409 });
};

export function createWorker(options: WorkerOptions): Worker {
  if (!options || typeof options !== 'object') throw invalidOption('options', 'must be an object');
  const { queue } = options;
  if (!queue || typeof queue.add !== 'function' || !queue.backend) {
    throw invalidOption('queue', 'must be a queue created with createQueue()');
  }
  if (!options.handlers || typeof options.handlers !== 'object') {
    throw invalidOption('handlers', 'must be an object mapping job names to handlers');
  }
  const handlers = new Map<string, ResolvedHandler>();
  for (const [name, value] of Object.entries(options.handlers)) {
    assertJobName(name);
    if (typeof value === 'function') {
      handlers.set(name, { handler: value });
    } else if (value && typeof value === 'object' && typeof value.handler === 'function') {
      const resolved: ResolvedHandler = { handler: value.handler };
      if (value.backoff !== undefined) {
        resolved.backoff = validateBackoff(value.backoff, `handlers.${name}.backoff`);
      }
      handlers.set(name, resolved);
    } else {
      throw invalidOption(`handlers.${name}`, 'must be a function or { handler }');
    }
  }
  if (handlers.size === 0) throw invalidOption('handlers', 'must register at least one handler');
  const names = [...handlers.keys()];

  const concurrency = intOption(options.concurrency, 'concurrency', 1, 1);
  if (concurrency > 1000) throw invalidOption('concurrency', 'must be at most 1000');
  const pollIntervalMs = intOption(options.pollIntervalMs, 'pollIntervalMs', 1000, 1);
  const leaseMs = intOption(options.leaseMs, 'leaseMs', 30_000, 100);
  const heartbeatMs = intOption(
    options.heartbeatIntervalMs,
    'heartbeatIntervalMs',
    Math.max(50, Math.floor(leaseMs / 3)),
    10,
  );
  if (heartbeatMs >= leaseMs) throw invalidOption('heartbeatIntervalMs', 'must be below leaseMs');
  const stalledMs = intOption(options.stalledCheckIntervalMs, 'stalledCheckIntervalMs', leaseMs, 0);
  const workerId =
    options.workerId ?? `${hostname().slice(0, 64)}:${process.pid}:${randomToken().slice(0, 8)}`;
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 200) {
    throw invalidOption('workerId', 'must be a string of 1 to 200 characters');
  }

  const { backend, clock, logger, config } = queue;
  const active = new Map<string, ActiveJob>();
  let state: WorkerState = 'idle';
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stalledTimer: ReturnType<typeof setInterval> | undefined;
  let pumping: Promise<void> | undefined;
  let pumpAgain = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  let stopping: Promise<{ aborted: number }> | undefined;
  /** Bumped by pause/stop so in-flight claims that finish afterwards are released unused. */
  let claimEpoch = 0;

  const callHook = async (hook: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err: errorInfo(err), hook, workerId }, 'jobs: worker hook threw');
    }
  };

  const schedulePump = (delayMs: number): void => {
    if (state !== 'running') return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void pump();
    }, delayMs);
  };

  const claimAndStart = async (): Promise<number> => {
    const capacity = concurrency - active.size;
    if (capacity <= 0) return 0;
    const epoch = claimEpoch;
    const now = clock.now();
    const records = await backend.claim({
      names,
      limit: capacity,
      now,
      leaseExpiresAt: now + leaseMs,
      leaseToken: randomToken(),
      workerId,
    });
    // Pause/stop may have won a race with an in-flight claim; release without counting the attempt.
    if (epoch !== claimEpoch) {
      for (const record of records) {
        const token = record.leaseToken;
        if (!token) continue;
        try {
          await backend.reschedule(record.id, token, {
            runAt: clock.now(),
            now: clock.now(),
            countAttempt: false,
          });
        } catch (err) {
          logger.error(
            { err: errorInfo(err), jobId: record.id },
            'jobs: release after pause race failed',
          );
        }
      }
      return 0;
    }
    for (const record of records) startJob(record);
    return records.length;
  };

  const pump = (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return pumping;
    }
    pumping = (async () => {
      try {
        do {
          pumpAgain = false;
          if (state !== 'running') break;
          await claimAndStart();
        } while (pumpAgain);
      } catch (err) {
        logger.error({ err: errorInfo(err), workerId }, 'jobs: claim failed');
      } finally {
        pumping = undefined;
      }
      schedulePump(pollIntervalMs);
    })();
    return pumping;
  };

  const verifyLease = async (entry: ActiveJob): Promise<void> => {
    if (entry.cause) return;
    const now = clock.now();
    try {
      const r = await backend.renewLease(
        entry.record.id,
        entry.record.leaseToken ?? '',
        now + leaseMs,
        now,
      );
      if (!r.ok) abortJob(entry, 'lease-lost');
      else if (r.cancelRequested) abortJob(entry, 'cancel');
    } catch (err) {
      logger.warn(
        { err: errorInfo(err), jobId: entry.record.id, workerId },
        'jobs: lease renewal failed',
      );
    }
  };

  const abortJob = (entry: ActiveJob, cause: AbortCause): void => {
    if (entry.cause) return;
    entry.cause = cause;
    logger.info({ jobId: entry.record.id, cause, workerId }, 'jobs: aborting running job');
    entry.controller.abort(abortError(cause));
  };

  const startJob = (record: JobRecord): void => {
    const def = handlers.get(record.name);
    const token = record.leaseToken;
    if (!def || !token) return;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const entry: ActiveJob = {
      record,
      controller,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
    };
    active.set(record.id, entry);
    void runJob(entry, def, token).finally(() => {
      active.delete(record.id);
      resolveSettled();
      if (state === 'running') schedulePump(0);
    });
  };

  const runJob = async (entry: ActiveJob, def: ResolvedHandler, token: string): Promise<void> => {
    const { record } = entry;
    const heartbeat = setInterval(() => void verifyLease(entry), heartbeatMs);

    let pendingProgress: { percent: number; dataJson: string | null } | undefined;
    let writing: Promise<void> | undefined;
    const progress = (percent: number, data?: unknown): Promise<void> => {
      if (
        typeof percent !== 'number' ||
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 100
      ) {
        return Promise.reject(
          new JobsError(JobsErrorCode.InvalidOption, 'progress percent must be from 0 to 100', {
            status: 400,
            expose: true,
          }),
        );
      }
      let dataJson: string | null = null;
      try {
        if (data !== undefined) dataJson = toJson(data, config.maxProgressBytes, 'progress data');
      } catch (err) {
        return Promise.reject(err);
      }
      pendingProgress = { percent, dataJson };
      if (!writing) {
        writing = (async () => {
          while (pendingProgress) {
            const next = pendingProgress;
            pendingProgress = undefined;
            try {
              const ok = await backend.updateProgress(
                record.id,
                token,
                next.percent,
                next.dataJson,
                clock.now(),
              );
              if (!ok) abortJob(entry, 'lease-lost');
            } catch (err) {
              logger.warn({ err: errorInfo(err), jobId: record.id }, 'jobs: progress write failed');
            }
          }
        })().finally(() => {
          writing = undefined;
        });
      }
      return writing;
    };

    const ctx: JobContext = {
      signal: entry.controller.signal,
      attempt: record.attempts,
      job: {
        id: record.id,
        name: record.name,
        priority: record.priority,
        maxAttempts: record.maxAttempts,
        createdAt: new Date(record.createdAt),
        runAt: new Date(record.runAt),
      },
      progress,
      logger,
    };

    let ok = false;
    let result: unknown;
    let failure: unknown;
    try {
      const payload = JSON.parse(record.payloadJson) as unknown;
      result = await def.handler(payload, ctx);
      ok = true;
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(heartbeat);
    }
    if (writing) await writing;

    if (entry.cause === 'shutdown' || entry.cause === 'lease-lost') {
      logger.info({ jobId: record.id, cause: entry.cause }, 'jobs: result discarded');
      return;
    }
    try {
      if (entry.cause === 'cancel') {
        const done = await backend.finish(record.id, token, {
          state: 'cancelled',
          now: clock.now(),
        });
        if (done) {
          const job = toJob(done, clock.now());
          await callHook('onCancelled', () => options.onCancelled?.(job));
        }
        return;
      }
      if (ok) {
        let resultJson: string | null = null;
        try {
          resultJson =
            result === undefined ? null : toJson(result, config.maxResultBytes, 'result');
        } catch (err) {
          logger.warn({ err: errorInfo(err), jobId: record.id }, 'jobs: result not stored');
        }
        const done = await backend.finish(record.id, token, {
          state: 'completed',
          now: clock.now(),
          resultJson,
        });
        if (!done) {
          logger.warn({ jobId: record.id }, 'jobs: lease lost before completion was recorded');
          return;
        }
        logger.debug({ jobId: record.id, name: record.name }, 'jobs: completed');
        const job = toJob(done, clock.now());
        await callHook('onCompleted', () => options.onCompleted?.(job, result));
        return;
      }
      await handleFailure(record, token, def, failure);
    } catch (err) {
      logger.error({ err: errorInfo(err), jobId: record.id }, 'jobs: recording the outcome failed');
    }
  };

  const handleFailure = async (
    record: JobRecord,
    token: string,
    def: ResolvedHandler,
    err: unknown,
  ): Promise<void> => {
    const info = errorInfo(err);
    logger.warn(
      {
        jobId: record.id,
        name: record.name,
        attempt: record.attempts,
        err: info,
        stack: err instanceof Error ? err.stack : undefined,
      },
      'jobs: attempt failed',
    );
    const now = clock.now();
    if (isNonRetryable(err) || record.attempts >= record.maxAttempts) {
      const dead = !isNonRetryable(err);
      const done = await backend.finish(record.id, token, {
        state: dead ? 'dead' : 'failed',
        now,
        lastError: info,
      });
      if (!done) return;
      const job = toJob(done, now);
      await callHook('onFailed', () => options.onFailed?.(job, err, { willRetry: false }));
      if (dead) await callHook('onDead', () => options.onDead?.(job, err));
      return;
    }
    const policy: BackoffPolicy = record.backoff ?? def.backoff ?? config.backoff;
    const delay = computeBackoff(policy, record.attempts, err);
    const runAt = now + delay;
    const done = await backend.reschedule(record.id, token, {
      runAt,
      now,
      countAttempt: true,
      lastError: info,
    });
    if (!done) return;
    const job = toJob(done, now);
    if (done.state === 'cancelled') {
      await callHook('onCancelled', () => options.onCancelled?.(job));
      return;
    }
    await callHook('onFailed', () =>
      options.onFailed?.(job, err, { willRetry: true, retryAt: new Date(runAt) }),
    );
  };

  const onEvent = (event: BackendEvent): void => {
    if (event.type === 'enqueued') {
      if (state === 'running' && (event.name === '*' || handlers.has(event.name))) schedulePump(0);
      return;
    }
    const entry = active.get(event.id);
    if (entry) void verifyLease(entry);
  };

  const recoverStalled = async (): Promise<void> => {
    try {
      const jobs = await queue.recoverStalled();
      for (const job of jobs) {
        if (job.state === 'dead' && handlers.has(job.name)) {
          const err = new JobsError(JobsErrorCode.Stalled, job.lastError?.message ?? 'stalled');
          await callHook('onDead', () => options.onDead?.(job, err));
        }
      }
    } catch (err) {
      logger.error({ err: errorInfo(err), workerId }, 'jobs: stalled job recovery failed');
    }
  };

  const release = async (entry: ActiveJob): Promise<void> => {
    const token = entry.record.leaseToken;
    if (!token) return;
    try {
      const now = clock.now();
      await backend.reschedule(entry.record.id, token, { runAt: now, now, countAttempt: false });
    } catch (err) {
      logger.error({ err: errorInfo(err), jobId: entry.record.id }, 'jobs: lease release failed');
    }
  };

  const worker: Worker = {
    id: workerId,
    get state() {
      return state;
    },
    get activeCount() {
      return active.size;
    },

    async start() {
      if (state === 'running' || state === 'paused') return;
      if (state !== 'idle') {
        throw new JobsError(JobsErrorCode.WorkerState, `Worker is ${state} and cannot start`);
      }
      state = 'running';
      unsubscribe = await queue.subscribe(onEvent);
      if (stalledMs > 0) {
        stalledTimer = setInterval(() => void recoverStalled(), stalledMs);
        void recoverStalled();
      }
      logger.info({ workerId, names, concurrency }, 'jobs: worker started');
      void pump();
    },

    pause() {
      if (state !== 'running') return;
      state = 'paused';
      claimEpoch += 1;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      logger.info({ workerId }, 'jobs: worker paused');
    },

    resume() {
      if (state !== 'paused') return;
      state = 'running';
      logger.info({ workerId }, 'jobs: worker resumed');
      void pump();
    },

    stop(stopOptions = {}) {
      if (stopping) return stopping;
      const timeoutMs = intOption(stopOptions.timeoutMs, 'timeoutMs', 30_000, 0);
      stopping = (async () => {
        state = 'stopping';
        claimEpoch += 1;
        if (pollTimer) clearTimeout(pollTimer);
        if (stalledTimer) clearInterval(stalledTimer);
        pollTimer = undefined;
        stalledTimer = undefined;
        if (pumping) await pumping;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const allSettled = Promise.all([...active.values()].map((e) => e.settled)).then(() => true);
        const timedOut = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        });
        const finished = await Promise.race([allSettled, timedOut]);
        if (timer) clearTimeout(timer);
        let aborted = 0;
        if (!finished) {
          const remaining = [...active.values()].filter((e) => !e.cause);
          for (const entry of remaining) abortJob(entry, 'shutdown');
          await Promise.all(remaining.map(release));
          aborted = remaining.length;
        }
        if (unsubscribe) await unsubscribe();
        unsubscribe = undefined;
        state = 'stopped';
        logger.info({ workerId, aborted }, 'jobs: worker stopped');
        return { aborted };
      })();
      return stopping;
    },

    async poll() {
      if (state === 'stopping' || state === 'stopped') return 0;
      return claimAndStart();
    },

    async idle() {
      while (active.size > 0) {
        await Promise.all([...active.values()].map((e) => e.settled));
      }
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const ok = state === 'running' || state === 'paused';
      return { ok, details: { workerId, state, active: active.size, concurrency } };
    },
  };
  return worker;
}
