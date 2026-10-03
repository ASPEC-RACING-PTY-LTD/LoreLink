import { invalidOption, JobsError, JobsErrorCode } from '../errors.js';
import { effectiveState } from '../internal.js';
import type {
  CancelOutcome,
  ClaimRequest,
  FinishRequest,
  JobErrorInfo,
  JobRecord,
  JobState,
  JobsBackend,
  NewJobRecord,
  RescheduleRequest,
} from '../types.js';

export interface MemoryBackendOptions {
  /**
   * Maximum number of stored jobs. When full, the oldest completed or cancelled jobs are
   * evicted; if none can be evicted, `add()` fails with JOBS_BACKEND_FULL. Default 100000.
   */
  maxJobs?: number;
}

export interface MemoryBackend extends JobsBackend {
  readonly kind: 'memory';
  /** Number of stored jobs (all states). */
  size(): number;
  /** Removes every job. Intended for tests. */
  clear(): void;
}

const READY: ReadonlySet<JobState> = new Set(['waiting', 'scheduled']);
const EVICTABLE: ReadonlySet<JobState> = new Set(['completed', 'cancelled']);

/**
 * In-process backend for local development and tests. State lives in memory and is lost when
 * the process exits. Records are copied on read so callers cannot mutate stored state.
 */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  const maxJobs = options.maxJobs ?? 100_000;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw invalidOption('maxJobs', 'must be a positive integer');
  }
  const jobs = new Map<string, JobRecord>();
  let seq = 0;

  const copy = (r: JobRecord): JobRecord => ({
    ...r,
    backoff: r.backoff ? { ...r.backoff } : null,
    lastError: r.lastError ? { ...r.lastError } : null,
  });

  const evict = (): boolean => {
    let victim: JobRecord | undefined;
    for (const r of jobs.values()) {
      if (!EVICTABLE.has(r.state)) continue;
      if (!victim || (r.finishedAt ?? r.updatedAt) < (victim.finishedAt ?? victim.updatedAt)) {
        victim = r;
      }
    }
    if (!victim) return false;
    jobs.delete(victim.id);
    return true;
  };

  const leased = (id: string, token: string): JobRecord | undefined => {
    const r = jobs.get(id);
    if (!r || r.state !== 'active' || r.leaseToken !== token) return undefined;
    return r;
  };

  const clearLease = (r: JobRecord): void => {
    r.leaseToken = null;
    r.leaseExpiresAt = null;
    r.workerId = null;
  };

  const matchesState = (r: JobRecord, state: JobState | undefined, now: number): boolean =>
    state === undefined || effectiveState(r, now) === state;

  const backend: MemoryBackend = {
    kind: 'memory',

    size: () => jobs.size,
    clear: () => jobs.clear(),

    async insert(job: NewJobRecord) {
      const existing = jobs.get(job.id);
      if (existing) return { record: copy(existing), created: false };
      if (jobs.size >= maxJobs && !evict()) {
        throw new JobsError(
          JobsErrorCode.BackendFull,
          `Memory backend is full (${maxJobs} jobs); finished jobs could not be evicted`,
          { status: 503, expose: false },
        );
      }
      seq += 1;
      const record: JobRecord = {
        seq,
        id: job.id,
        name: job.name,
        payloadJson: job.payloadJson,
        state: job.state,
        priority: job.priority,
        runAt: job.runAt,
        attempts: 0,
        maxAttempts: job.maxAttempts,
        backoff: job.backoff,
        progressPercent: 0,
        progressDataJson: null,
        resultJson: null,
        lastError: null,
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
        cancelRequested: false,
        createdAt: job.now,
        updatedAt: job.now,
        startedAt: null,
        finishedAt: null,
      };
      jobs.set(job.id, record);
      return { record: copy(record), created: true };
    },

    async get(id) {
      const r = jobs.get(id);
      return r ? copy(r) : undefined;
    },

    async list(query) {
      const out: JobRecord[] = [];
      for (const r of jobs.values()) {
        if (query.beforeSeq !== undefined && r.seq >= query.beforeSeq) continue;
        if (query.name !== undefined && r.name !== query.name) continue;
        if (!matchesState(r, query.state, query.now)) continue;
        out.push(r);
      }
      out.sort((a, b) => b.seq - a.seq);
      return out.slice(0, query.limit).map(copy);
    },

    async counts(query) {
      const out: Partial<Record<JobState, number>> = {};
      for (const r of jobs.values()) {
        if (query.name !== undefined && r.name !== query.name) continue;
        const s = effectiveState(r, query.now);
        out[s] = (out[s] ?? 0) + 1;
      }
      return out;
    },

    async claim(req: ClaimRequest) {
      const names = new Set(req.names);
      const ready: JobRecord[] = [];
      for (const r of jobs.values()) {
        if (READY.has(r.state) && r.runAt <= req.now && names.has(r.name)) ready.push(r);
      }
      ready.sort((a, b) => a.priority - b.priority || a.runAt - b.runAt || a.seq - b.seq);
      const claimed = ready.slice(0, req.limit);
      for (const r of claimed) {
        r.state = 'active';
        r.attempts += 1;
        r.leaseToken = req.leaseToken;
        r.leaseExpiresAt = req.leaseExpiresAt;
        r.workerId = req.workerId;
        r.startedAt = req.now;
        r.updatedAt = req.now;
      }
      return claimed.map(copy);
    },

    async renewLease(id, token, leaseExpiresAt, now) {
      const r = leased(id, token);
      if (!r) return { ok: false, cancelRequested: false };
      r.leaseExpiresAt = leaseExpiresAt;
      r.updatedAt = now;
      return { ok: true, cancelRequested: r.cancelRequested };
    },

    async updateProgress(id, token, percent, dataJson, now) {
      const r = leased(id, token);
      if (!r) return false;
      r.progressPercent = percent;
      r.progressDataJson = dataJson;
      r.updatedAt = now;
      return true;
    },

    async finish(id, token, req: FinishRequest) {
      const r = leased(id, token);
      if (!r) return undefined;
      r.state = req.state;
      if (req.resultJson !== undefined) r.resultJson = req.resultJson;
      if (req.lastError !== undefined) r.lastError = req.lastError;
      if (req.state === 'completed') r.progressPercent = 100;
      clearLease(r);
      r.finishedAt = req.now;
      r.updatedAt = req.now;
      return copy(r);
    },

    async reschedule(id, token, req: RescheduleRequest) {
      const r = leased(id, token);
      if (!r) return undefined;
      if (req.lastError !== undefined) r.lastError = req.lastError;
      if (!req.countAttempt) r.attempts = Math.max(0, r.attempts - 1);
      clearLease(r);
      r.updatedAt = req.now;
      if (r.cancelRequested) {
        r.state = 'cancelled';
        r.finishedAt = req.now;
      } else {
        r.state = req.runAt > req.now ? 'scheduled' : 'waiting';
        r.runAt = req.runAt;
      }
      return copy(r);
    },

    async cancel(id, now) {
      const r = jobs.get(id);
      if (!r) return { outcome: 'not_found' as CancelOutcome };
      let outcome: CancelOutcome;
      if (READY.has(r.state)) {
        r.state = 'cancelled';
        r.finishedAt = now;
        r.updatedAt = now;
        outcome = 'cancelled';
      } else if (r.state === 'active') {
        r.cancelRequested = true;
        r.updatedAt = now;
        outcome = 'requested';
      } else {
        outcome = 'invalid_state';
      }
      return { outcome, record: copy(r) };
    },

    async retry(id, now) {
      const r = jobs.get(id);
      if (!r || (r.state !== 'failed' && r.state !== 'dead')) return undefined;
      resetForRetry(r, now);
      return copy(r);
    },

    async retryDead(query) {
      const dead = [...jobs.values()]
        .filter((r) => r.state === 'dead' && (query.name === undefined || r.name === query.name))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, query.limit);
      for (const r of dead) resetForRetry(r, query.now);
      return dead.length;
    },

    async purge(query) {
      const states = new Set(query.states);
      let n = 0;
      for (const r of [...jobs.values()]) {
        if (n >= query.limit) break;
        if (!states.has(r.state)) continue;
        if (query.name !== undefined && r.name !== query.name) continue;
        if (
          query.finishedBefore !== undefined &&
          (r.finishedAt ?? r.updatedAt) >= query.finishedBefore
        ) {
          continue;
        }
        jobs.delete(r.id);
        n += 1;
      }
      return n;
    },

    async recoverStalled(now, error: JobErrorInfo) {
      const out: JobRecord[] = [];
      for (const r of jobs.values()) {
        if (r.state !== 'active' || r.leaseExpiresAt === null || r.leaseExpiresAt >= now) continue;
        clearLease(r);
        r.updatedAt = now;
        if (r.cancelRequested) {
          r.state = 'cancelled';
          r.finishedAt = now;
        } else if (r.attempts >= r.maxAttempts) {
          r.state = 'dead';
          r.lastError = { ...error };
          r.finishedAt = now;
        } else {
          r.state = 'waiting';
          r.lastError = { ...error };
          r.runAt = now;
        }
        out.push(copy(r));
      }
      return out;
    },

    async ping() {},
  };
  return backend;
}

function resetForRetry(r: JobRecord, now: number): void {
  r.state = 'waiting';
  r.attempts = 0;
  r.runAt = now;
  r.cancelRequested = false;
  r.finishedAt = null;
  r.updatedAt = now;
  r.progressPercent = 0;
  r.progressDataJson = null;
  r.resultJson = null;
}
