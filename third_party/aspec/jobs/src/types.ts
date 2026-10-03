import type { EnqueueOptions } from './ports.js';

/** Every state a job can be in. `scheduled` jobs become `waiting` once their run time passes. */
export const JOB_STATES = [
  'waiting',
  'scheduled',
  'active',
  'completed',
  'failed',
  'dead',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** Terminal states: the job will not run again unless retried explicitly. */
export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'dead', 'cancelled'];

/** Error information kept on a job. Stacks are only written to logs, never stored. */
export interface JobErrorInfo {
  message: string;
  code?: string;
  name?: string;
}

/** Exponential backoff: delay = min(maxMs, baseMs * factor^(attempt - 1)), then jitter. */
export interface ExponentialBackoff {
  type: 'exponential';
  /** Delay before the first retry in milliseconds. Default 1000. */
  baseMs?: number;
  /** Multiplier per attempt. Default 2. */
  factor?: number;
  /** Upper bound for the delay in milliseconds. Default 3600000 (one hour). */
  maxMs?: number;
  /**
   * `full` picks a random delay in [0, delay], `equal` in [delay / 2, delay], `none` disables
   * jitter. Default `full`.
   */
  jitter?: 'full' | 'equal' | 'none';
}

/** Fixed backoff: every retry waits the same delay. */
export interface FixedBackoff {
  type: 'fixed';
  delayMs: number;
}

/** Backoff policies that can be stored with a job (JSON serialisable). */
export type SerializableBackoff = ExponentialBackoff | FixedBackoff;

/**
 * Custom backoff: returns the delay in milliseconds before the next attempt. `attempt` is the
 * number of the attempt that just failed (1 for the first attempt).
 */
export type BackoffFunction = (attempt: number, error: unknown) => number;

export type BackoffPolicy = SerializableBackoff | BackoffFunction;

/** Options accepted by `queue.add()`: the JobQueue port options plus job-level overrides. */
export interface AddOptions extends EnqueueOptions {
  /** Per-job retry backoff override. Stored with the job. */
  backoff?: SerializableBackoff;
}

export interface JobProgress {
  /** Percentage from 0 to 100. */
  percent: number;
  /** Optional JSON data reported by the handler. */
  data?: unknown;
}

/** Public view of a job. */
export interface Job {
  id: string;
  name: string;
  payload: unknown;
  state: JobState;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  backoff?: SerializableBackoff;
  progress: JobProgress;
  result?: unknown;
  lastError?: JobErrorInfo;
  cancelRequested: boolean;
  workerId?: string;
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface ListJobsOptions {
  state?: JobState;
  name?: string;
  /** Page size, 1 to 1000. Default 50. */
  limit?: number;
  /** Opaque cursor from a previous page (`nextCursor`). */
  cursor?: string;
}

export interface JobPage {
  jobs: Job[];
  /** Present when more jobs are available. Pass it back as `cursor`. */
  nextCursor?: string;
}

export type JobCounts = Record<JobState, number>;

/** Stored representation used by backends. JSON values are kept as serialised text. */
export interface JobRecord {
  seq: number;
  id: string;
  name: string;
  payloadJson: string;
  state: JobState;
  priority: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  backoff: SerializableBackoff | null;
  progressPercent: number;
  progressDataJson: string | null;
  resultJson: string | null;
  lastError: JobErrorInfo | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  workerId: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface NewJobRecord {
  id: string;
  name: string;
  payloadJson: string;
  state: 'waiting' | 'scheduled';
  priority: number;
  runAt: number;
  maxAttempts: number;
  backoff: SerializableBackoff | null;
  now: number;
}

export interface ClaimRequest {
  /** Only claim jobs with these names. */
  names: readonly string[];
  limit: number;
  now: number;
  leaseExpiresAt: number;
  leaseToken: string;
  workerId: string;
}

export interface FinishRequest {
  state: 'completed' | 'failed' | 'dead' | 'cancelled';
  now: number;
  resultJson?: string | null;
  lastError?: JobErrorInfo | null;
}

export interface RescheduleRequest {
  runAt: number;
  now: number;
  /** When false the running attempt is not counted (used when releasing leases on shutdown). */
  countAttempt: boolean;
  lastError?: JobErrorInfo | null;
}

export type CancelOutcome = 'cancelled' | 'requested' | 'not_found' | 'invalid_state';

export type BackendEvent = { type: 'enqueued'; name: string } | { type: 'cancel'; id: string };

/**
 * Storage and coordination backend. Every transition that concerns a running job is guarded
 * by its lease token, so a worker that lost its lease can never overwrite newer state.
 */
export interface JobsBackend {
  readonly kind: string;
  insert(job: NewJobRecord): Promise<{ record: JobRecord; created: boolean }>;
  get(id: string): Promise<JobRecord | undefined>;
  list(query: {
    state?: JobState;
    name?: string;
    limit: number;
    beforeSeq?: number;
    now: number;
  }): Promise<JobRecord[]>;
  counts(query: { name?: string; now: number }): Promise<Partial<Record<JobState, number>>>;
  claim(request: ClaimRequest): Promise<JobRecord[]>;
  renewLease(
    id: string,
    leaseToken: string,
    leaseExpiresAt: number,
    now: number,
  ): Promise<{ ok: boolean; cancelRequested: boolean }>;
  updateProgress(
    id: string,
    leaseToken: string,
    percent: number,
    dataJson: string | null,
    now: number,
  ): Promise<boolean>;
  finish(id: string, leaseToken: string, request: FinishRequest): Promise<JobRecord | undefined>;
  reschedule(
    id: string,
    leaseToken: string,
    request: RescheduleRequest,
  ): Promise<JobRecord | undefined>;
  cancel(id: string, now: number): Promise<{ outcome: CancelOutcome; record?: JobRecord }>;
  /** Moves a failed or dead job back to waiting with a fresh attempt budget. */
  retry(id: string, now: number): Promise<JobRecord | undefined>;
  retryDead(query: { name?: string; limit: number; now: number }): Promise<number>;
  purge(query: {
    states: readonly JobState[];
    name?: string;
    finishedBefore?: number;
    limit: number;
  }): Promise<number>;
  recoverStalled(now: number, error: JobErrorInfo): Promise<JobRecord[]>;
  ping(): Promise<void>;
  /** Optional push notifications (for example PostgreSQL LISTEN/NOTIFY). */
  subscribe?(listener: (event: BackendEvent) => void): Promise<() => Promise<void>>;
  /** Optional hook used by the queue to announce events to other processes. */
  publish?(event: BackendEvent): Promise<void>;
}
