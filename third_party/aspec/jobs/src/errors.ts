export const JobsErrorCode = {
  InvalidOption: 'JOBS_INVALID_OPTION',
  InvalidName: 'JOBS_INVALID_NAME',
  InvalidPayload: 'JOBS_INVALID_PAYLOAD',
  PayloadTooLarge: 'JOBS_PAYLOAD_TOO_LARGE',
  InvalidSchedule: 'JOBS_INVALID_SCHEDULE',
  NotFound: 'JOBS_JOB_NOT_FOUND',
  InvalidState: 'JOBS_INVALID_STATE',
  BackendFull: 'JOBS_BACKEND_FULL',
  WorkerState: 'JOBS_WORKER_STATE',
  Forbidden: 'JOBS_FORBIDDEN',
  BadRequest: 'JOBS_BAD_REQUEST',
  RouteNotFound: 'JOBS_ROUTE_NOT_FOUND',
  Internal: 'JOBS_INTERNAL',
  HandlerError: 'JOBS_HANDLER_ERROR',
  Stalled: 'JOBS_STALLED',
  Cancelled: 'JOBS_CANCELLED',
  Shutdown: 'JOBS_SHUTDOWN',
  LeaseLost: 'JOBS_LEASE_LOST',
  NonRetryable: 'JOBS_NON_RETRYABLE',
} as const;

export type JobsErrorCode = (typeof JobsErrorCode)[keyof typeof JobsErrorCode];

export interface JobsErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Base error for @aspec/jobs. Carries the ErrorLike shape (code, status, expose). */
export class JobsError extends Error {
  readonly code: JobsErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(code: JobsErrorCode, message: string, options: JobsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JobsError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? this.status < 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Throw from a job handler to fail the job immediately without further retries.
 * The job moves to the `failed` state. Any error with `retryable === false` is treated
 * the same way, so other modules can signal this without importing @aspec/jobs.
 */
export class NonRetryableError extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NonRetryableError';
    this.code = options.code ?? JobsErrorCode.NonRetryable;
  }
}

export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return true;
  return (
    typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === false
  );
}

export function invalidOption(option: string, reason: string): JobsError {
  return new JobsError(JobsErrorCode.InvalidOption, `Invalid option "${option}": ${reason}`, {
    status: 500,
    expose: false,
  });
}
