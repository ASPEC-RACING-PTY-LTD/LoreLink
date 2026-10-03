import { DEFAULT_BACKOFF, validateBackoff } from './backoff.js';
import { invalidOption, JobsError, JobsErrorCode } from './errors.js';
import {
  assertJobId,
  assertJobName,
  decodeCursor,
  encodeCursor,
  errorInfo,
  noopLogger,
  positiveInt,
  systemClock,
  toJob,
  toJson,
  uuidv7,
} from './internal.js';
import type {
  Clock,
  HealthCheckable,
  HealthCheckResult,
  IdGenerator,
  JobQueue,
  LoggerLike,
} from './ports.js';
import {
  type AddOptions,
  type BackendEvent,
  type BackoffPolicy,
  JOB_STATES,
  type Job,
  type JobCounts,
  type JobPage,
  type JobRecord,
  type JobState,
  type JobsBackend,
  type ListJobsOptions,
  type SerializableBackoff,
} from './types.js';

export interface RetryOptions {
  /** Default maximum attempts per job (including the first). Default 3. */
  maxAttempts?: number;
  /** Default backoff policy. Default exponential, base 1s, factor 2, max 1h, full jitter. */
  backoff?: BackoffPolicy;
}

export interface LimitOptions {
  /** Maximum serialised payload size in bytes. Default 262144 (256 KiB). */
  maxPayloadBytes?: number;
  /** Maximum serialised handler result size in bytes. Default 65536. */
  maxResultBytes?: number;
  /** Maximum serialised progress data size in bytes. Default 16384. */
  maxProgressBytes?: number;
}

export interface RetentionOptions {
  /** Completed jobs older than this are removed by `cleanup()`. Default 7 days. */
  completedMs?: number;
  /** Cancelled jobs older than this are removed by `cleanup()`. Default 7 days. */
  cancelledMs?: number;
  /** Failed jobs older than this are removed by `cleanup()`. Default: kept. */
  failedMs?: number;
  /** Dead jobs older than this are removed by `cleanup()`. Default: kept. */
  deadMs?: number;
}

export interface QueueOptions {
  backend: JobsBackend;
  logger?: LoggerLike;
  clock?: Clock;
  /** Generates job IDs when `jobId` is not given. Default UUID v7. */
  generateId?: IdGenerator;
  retry?: RetryOptions;
  limits?: LimitOptions;
  retention?: RetentionOptions;
}

export interface ResolvedQueueConfig {
  maxAttempts: number;
  backoff: BackoffPolicy;
  maxPayloadBytes: number;
  maxResultBytes: number;
  maxProgressBytes: number;
  retention: {
    completedMs?: number;
    cancelledMs?: number;
    failedMs?: number;
    deadMs?: number;
  };
}

export interface CleanupOptions {
  completedOlderThanMs?: number;
  cancelledOlderThanMs?: number;
  failedOlderThanMs?: number;
  deadOlderThanMs?: number;
}

export interface Queue extends JobQueue, HealthCheckable {
  readonly backend: JobsBackend;
  readonly clock: Clock;
  readonly logger: LoggerLike;
  readonly config: Readonly<ResolvedQueueConfig>;
  /** Enqueues a job. With `jobId`, a duplicate add returns the existing job unchanged. */
  add(name: string, payload: unknown, options?: AddOptions): Promise<Job>;
  getJob(id: string): Promise<Job | undefined>;
  listJobs(options?: ListJobsOptions): Promise<JobPage>;
  counts(options?: { name?: string }): Promise<JobCounts>;
  /**
   * Cancels a waiting or scheduled job immediately. For an active job, requests cooperative
   * cancellation: the worker aborts the handler signal and marks the job cancelled.
   */
  cancel(id: string): Promise<Job>;
  /** Moves a failed or dead job back to waiting with a fresh attempt budget. */
  retry(id: string): Promise<Job>;
  listDead(options?: Omit<ListJobsOptions, 'state'>): Promise<JobPage>;
  retryDead(options?: { name?: string; limit?: number }): Promise<{ count: number }>;
  purgeDead(options?: { name?: string; olderThanMs?: number }): Promise<{ count: number }>;
  /** Deletes finished jobs past their retention window. */
  cleanup(options?: CleanupOptions): Promise<{ deleted: number }>;
  /** Re-queues active jobs whose lease expired (the attempt counts). Returns the affected jobs. */
  recoverStalled(): Promise<Job[]>;
  /** Receives enqueue and cancel events from this process and, when supported, the backend. */
  subscribe(listener: (event: BackendEvent) => void): Promise<() => Promise<void>>;
}

const DEFAULT_LIMITS = {
  maxPayloadBytes: 256 * 1024,
  maxResultBytes: 64 * 1024,
  maxProgressBytes: 16 * 1024,
};
const DAY = 86_400_000;
const MAX_PRIORITY = 1_000_000;
const MAX_ATTEMPTS = 1000;
const PURGE_BATCH = 1000;

function limitOption(value: number | undefined, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 64 * 1024 * 1024) {
    throw invalidOption(option, 'must be an integer from 1 to 67108864');
  }
  return value;
}

function retentionOption(value: number | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidOption(option, 'must be a non-negative number of milliseconds');
  }
  return value;
}

function assertBackend(backend: unknown): asserts backend is JobsBackend {
  const b = backend as Partial<JobsBackend> | undefined;
  const required: (keyof JobsBackend)[] = [
    'insert',
    'get',
    'list',
    'counts',
    'claim',
    'renewLease',
    'updateProgress',
    'finish',
    'reschedule',
    'cancel',
    'retry',
    'retryDead',
    'purge',
    'recoverStalled',
    'ping',
  ];
  if (!b || typeof b !== 'object' || required.some((k) => typeof b[k] !== 'function')) {
    throw invalidOption('backend', 'must implement the JobsBackend interface');
  }
}

export function createQueue(options: QueueOptions): Queue {
  if (!options || typeof options !== 'object') throw invalidOption('options', 'must be an object');
  assertBackend(options.backend);
  const backend = options.backend;
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? (() => uuidv7(clock.now()));
  if (typeof generateId !== 'function') throw invalidOption('generateId', 'must be a function');

  const maxAttempts = options.retry?.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw invalidOption('retry.maxAttempts', `must be an integer from 1 to ${MAX_ATTEMPTS}`);
  }
  const backoff = validateBackoff(options.retry?.backoff ?? DEFAULT_BACKOFF, 'retry.backoff');
  const limits = options.limits ?? {};
  const retentionIn = options.retention ?? {};
  const config: ResolvedQueueConfig = {
    maxAttempts,
    backoff,
    maxPayloadBytes: limitOption(
      limits.maxPayloadBytes,
      'limits.maxPayloadBytes',
      DEFAULT_LIMITS.maxPayloadBytes,
    ),
    maxResultBytes: limitOption(
      limits.maxResultBytes,
      'limits.maxResultBytes',
      DEFAULT_LIMITS.maxResultBytes,
    ),
    maxProgressBytes: limitOption(
      limits.maxProgressBytes,
      'limits.maxProgressBytes',
      DEFAULT_LIMITS.maxProgressBytes,
    ),
    retention: {},
  };
  const completedMs = retentionOption(retentionIn.completedMs, 'retention.completedMs') ?? 7 * DAY;
  const cancelledMs = retentionOption(retentionIn.cancelledMs, 'retention.cancelledMs') ?? 7 * DAY;
  const failedMs = retentionOption(retentionIn.failedMs, 'retention.failedMs');
  const deadMs = retentionOption(retentionIn.deadMs, 'retention.deadMs');
  config.retention.completedMs = completedMs;
  config.retention.cancelledMs = cancelledMs;
  if (failedMs !== undefined) config.retention.failedMs = failedMs;
  if (deadMs !== undefined) config.retention.deadMs = deadMs;
  Object.freeze(config.retention);
  Object.freeze(config);

  const listeners = new Set<(event: BackendEvent) => void>();
  let backendUnsubscribe: Promise<() => Promise<void>> | undefined;

  const emitLocal = (event: BackendEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err: errorInfo(err) }, 'jobs: event listener threw');
      }
    }
  };

  const publish = async (event: BackendEvent): Promise<void> => {
    emitLocal(event);
    if (!backend.publish) return;
    try {
      await backend.publish(event);
    } catch (err) {
      // Notifications are an optimisation; workers still find jobs by polling.
      logger.warn({ err: errorInfo(err), event: event.type }, 'jobs: backend publish failed');
    }
  };

  const notFound = (id: string): JobsError =>
    new JobsError(JobsErrorCode.NotFound, `Job "${id}" was not found`, {
      status: 404,
      expose: true,
    });

  const requireId = (id: unknown): string => {
    assertJobId(id, 'id');
    return id;
  };

  const validateState = (state: unknown): JobState | undefined => {
    if (state === undefined) return undefined;
    if (typeof state !== 'string' || !(JOB_STATES as readonly string[]).includes(state)) {
      throw new JobsError(
        JobsErrorCode.InvalidOption,
        `Invalid option "state": must be one of ${JOB_STATES.join(', ')}`,
        { status: 400, expose: true },
      );
    }
    return state as JobState;
  };

  const validateNameFilter = (name: unknown): string | undefined => {
    if (name === undefined) return undefined;
    assertJobName(name);
    return name;
  };

  const purgeAll = async (query: {
    states: readonly JobState[];
    name?: string;
    finishedBefore?: number;
  }): Promise<number> => {
    let total = 0;
    for (;;) {
      const n = await backend.purge({ ...query, limit: PURGE_BATCH });
      total += n;
      if (n < PURGE_BATCH) return total;
    }
  };

  const list = async (opts: ListJobsOptions): Promise<JobPage> => {
    const state = validateState(opts.state);
    const name = validateNameFilter(opts.name);
    const limit = opts.limit === undefined ? 50 : positiveInt(opts.limit, 'limit', 1, 1000);
    const query: Parameters<JobsBackend['list']>[0] = { limit: limit + 1, now: clock.now() };
    if (state) query.state = state;
    if (name) query.name = name;
    if (opts.cursor !== undefined) query.beforeSeq = decodeCursor(opts.cursor);
    const rows = await backend.list(query);
    const page: JobPage = { jobs: rows.slice(0, limit).map((r) => toJob(r, query.now)) };
    const last = rows[limit - 1];
    if (rows.length > limit && last) page.nextCursor = encodeCursor(last.seq);
    return page;
  };

  const queue: Queue = {
    backend,
    clock,
    logger,
    config,

    async add(name, payload, addOptions = {}) {
      assertJobName(name);
      const now = clock.now();
      const opts = addOptions ?? {};
      const payloadJson = toJson(payload, config.maxPayloadBytes, 'payload');
      let runAt = now;
      if (opts.runAt !== undefined) {
        if (!(opts.runAt instanceof Date) || Number.isNaN(opts.runAt.getTime())) {
          throw new JobsError(JobsErrorCode.InvalidOption, 'Invalid option "runAt": invalid date', {
            status: 400,
            expose: true,
          });
        }
        runAt = opts.runAt.getTime();
      }
      if (opts.delayMs !== undefined) {
        if (
          typeof opts.delayMs !== 'number' ||
          !Number.isFinite(opts.delayMs) ||
          opts.delayMs < 0
        ) {
          throw new JobsError(
            JobsErrorCode.InvalidOption,
            'Invalid option "delayMs": must be a non-negative number',
            { status: 400, expose: true },
          );
        }
        runAt = Math.max(runAt, now + Math.floor(opts.delayMs));
      }
      const priority =
        opts.priority === undefined
          ? 0
          : positiveInt(opts.priority, 'priority', -MAX_PRIORITY, MAX_PRIORITY);
      const jobMaxAttempts =
        opts.maxAttempts === undefined
          ? config.maxAttempts
          : positiveInt(opts.maxAttempts, 'maxAttempts', 1, MAX_ATTEMPTS);
      let jobBackoff: SerializableBackoff | null = null;
      if (opts.backoff !== undefined) {
        if (typeof opts.backoff === 'function') {
          throw new JobsError(
            JobsErrorCode.InvalidOption,
            'Invalid option "backoff": per-job backoff must be a serialisable policy; use a handler or queue level function instead',
            { status: 400, expose: true },
          );
        }
        jobBackoff = validateBackoff(opts.backoff, 'backoff') as SerializableBackoff;
      }
      let id: string;
      if (opts.jobId !== undefined) {
        assertJobId(opts.jobId);
        id = opts.jobId;
      } else {
        id = generateId();
        assertJobId(id, 'generateId()');
      }
      const { record, created } = await backend.insert({
        id,
        name,
        payloadJson,
        state: runAt > now ? 'scheduled' : 'waiting',
        priority,
        runAt,
        maxAttempts: jobMaxAttempts,
        backoff: jobBackoff,
        now,
      });
      if (created) {
        logger.debug({ jobId: id, name, runAt, priority }, 'jobs: enqueued');
        await publish({ type: 'enqueued', name });
      }
      return toJob(record, now);
    },

    async getJob(id) {
      const record = await backend.get(requireId(id));
      return record ? toJob(record, clock.now()) : undefined;
    },

    listJobs(opts = {}) {
      return list(opts);
    },

    async counts(opts = {}) {
      const name = validateNameFilter(opts.name);
      const query: { name?: string; now: number } = { now: clock.now() };
      if (name) query.name = name;
      const partial = await backend.counts(query);
      const out = {} as JobCounts;
      for (const state of JOB_STATES) out[state] = partial[state] ?? 0;
      return out;
    },

    async cancel(id) {
      const jobId = requireId(id);
      const now = clock.now();
      const { outcome, record } = await backend.cancel(jobId, now);
      if (outcome === 'not_found' || !record) throw notFound(jobId);
      if (outcome === 'invalid_state') {
        throw new JobsError(
          JobsErrorCode.InvalidState,
          `Job "${jobId}" is ${record.state} and cannot be cancelled`,
          { status: 409, expose: true },
        );
      }
      logger.info({ jobId, outcome }, 'jobs: cancel');
      if (outcome === 'requested') await publish({ type: 'cancel', id: jobId });
      return toJob(record, now);
    },

    async retry(id) {
      const jobId = requireId(id);
      const now = clock.now();
      const record: JobRecord | undefined = await backend.retry(jobId, now);
      if (!record) {
        const existing = await backend.get(jobId);
        if (!existing) throw notFound(jobId);
        throw new JobsError(
          JobsErrorCode.InvalidState,
          `Job "${jobId}" is ${existing.state}; only failed or dead jobs can be retried`,
          { status: 409, expose: true },
        );
      }
      logger.info({ jobId }, 'jobs: retried');
      await publish({ type: 'enqueued', name: record.name });
      return toJob(record, now);
    },

    listDead(opts = {}) {
      return list({ ...opts, state: 'dead' });
    },

    async retryDead(opts = {}) {
      const name = validateNameFilter(opts.name);
      const limit = opts.limit === undefined ? 1000 : positiveInt(opts.limit, 'limit', 1, 100_000);
      const query: { name?: string; limit: number; now: number } = { limit, now: clock.now() };
      if (name) query.name = name;
      const count = await backend.retryDead(query);
      if (count > 0) {
        logger.info({ count, name }, 'jobs: dead jobs retried');
        await publish({ type: 'enqueued', name: name ?? '*' });
      }
      return { count };
    },

    async purgeDead(opts = {}) {
      const name = validateNameFilter(opts.name);
      const query: { states: JobState[]; name?: string; finishedBefore?: number } = {
        states: ['dead'],
      };
      if (name) query.name = name;
      if (opts.olderThanMs !== undefined) {
        const ms = retentionOption(opts.olderThanMs, 'olderThanMs') ?? 0;
        query.finishedBefore = clock.now() - ms;
      }
      const count = await purgeAll(query);
      logger.info({ count, name }, 'jobs: dead jobs purged');
      return { count };
    },

    async cleanup(opts = {}) {
      const now = clock.now();
      const windows: [JobState, number | undefined][] = [
        ['completed', opts.completedOlderThanMs ?? config.retention.completedMs],
        ['cancelled', opts.cancelledOlderThanMs ?? config.retention.cancelledMs],
        ['failed', opts.failedOlderThanMs ?? config.retention.failedMs],
        ['dead', opts.deadOlderThanMs ?? config.retention.deadMs],
      ];
      let deleted = 0;
      for (const [state, ms] of windows) {
        if (ms === undefined) continue;
        const window = retentionOption(ms, `cleanup.${state}`) ?? 0;
        deleted += await purgeAll({ states: [state], finishedBefore: now - window });
      }
      if (deleted > 0) logger.info({ deleted }, 'jobs: cleanup');
      return { deleted };
    },

    async recoverStalled() {
      const now = clock.now();
      const records = await backend.recoverStalled(now, {
        message: 'Job lease expired before the attempt finished',
        code: JobsErrorCode.Stalled,
      });
      for (const r of records) {
        logger.warn({ jobId: r.id, name: r.name, state: r.state }, 'jobs: stalled job recovered');
        if (r.state === 'waiting') await publish({ type: 'enqueued', name: r.name });
      }
      return records.map((r) => toJob(r, now));
    },

    async subscribe(listener) {
      listeners.add(listener);
      if (backend.subscribe && !backendUnsubscribe) {
        backendUnsubscribe = backend.subscribe(emitLocal);
        backendUnsubscribe.catch((err: unknown) => {
          logger.warn({ err: errorInfo(err) }, 'jobs: backend subscription failed');
          backendUnsubscribe = undefined;
        });
      }
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        listeners.delete(listener);
        if (listeners.size === 0 && backendUnsubscribe) {
          const pending = backendUnsubscribe;
          backendUnsubscribe = undefined;
          try {
            const unsubscribe = await pending;
            await unsubscribe();
          } catch (err) {
            logger.warn({ err: errorInfo(err) }, 'jobs: backend unsubscribe failed');
          }
        }
      };
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const started = clock.now();
      try {
        await backend.ping();
        return { ok: true, latencyMs: clock.now() - started, details: { backend: backend.kind } };
      } catch (err) {
        logger.error({ err: errorInfo(err) }, 'jobs: health check failed');
        return {
          ok: false,
          latencyMs: clock.now() - started,
          details: { backend: backend.kind, error: 'backend unavailable' },
        };
      }
    },
  };
  return queue;
}
