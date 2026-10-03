import { randomBytes } from 'node:crypto';
import { JobsError, JobsErrorCode } from './errors.js';
import type { Clock, LoggerLike } from './ports.js';
import type { Job, JobErrorInfo, JobRecord, JobState } from './types.js';

export const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const systemClock: Clock = { now: () => Date.now() };

/** UUID version 7 (time ordered) built from crypto randomness. */
export function uuidv7(now: number): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomToken(): string {
  return randomBytes(18).toString('base64url');
}

const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// Printable ASCII without spaces; keeps IDs safe in URLs, logs and SQL text columns.
const JOB_ID = /^[\x21-\x7e]{1,255}$/;

export function assertJobName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !JOB_NAME.test(name)) {
    throw new JobsError(
      JobsErrorCode.InvalidName,
      'Job name must be 1 to 128 characters of letters, digits, ".", "_", ":", "/" or "-" and start with a letter or digit',
      { status: 400, expose: true },
    );
  }
}

export function isValidJobId(id: unknown): id is string {
  return typeof id === 'string' && JOB_ID.test(id);
}

export function assertJobId(id: unknown, option = 'jobId'): asserts id is string {
  if (!isValidJobId(id)) {
    throw new JobsError(
      JobsErrorCode.InvalidOption,
      `Invalid option "${option}": must be 1 to 255 printable ASCII characters without spaces`,
      { status: 400, expose: true },
    );
  }
}

/** Serialises a JSON value and enforces a byte limit. */
export function toJson(
  value: unknown,
  limitBytes: number,
  what: 'payload' | 'result' | 'progress data',
): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch (err) {
    throw new JobsError(JobsErrorCode.InvalidPayload, `Job ${what} is not JSON serialisable`, {
      status: 400,
      expose: true,
      cause: err,
    });
  }
  if (text === undefined) {
    throw new JobsError(JobsErrorCode.InvalidPayload, `Job ${what} is not JSON serialisable`, {
      status: 400,
      expose: true,
    });
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > limitBytes) {
    throw new JobsError(
      JobsErrorCode.PayloadTooLarge,
      `Job ${what} is ${size} bytes, which exceeds the limit of ${limitBytes} bytes`,
      { status: 413, expose: true, details: { size, limit: limitBytes } },
    );
  }
  return text;
}

export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  return JSON.parse(text) as unknown;
}

const MAX_MESSAGE = 2000;
const MAX_CODE = 100;

/** Extracts safe error information (message, code, name). Stacks are never included. */
export function errorInfo(err: unknown): JobErrorInfo {
  if (err instanceof Error) {
    const info: JobErrorInfo = { message: truncate(err.message || err.name, MAX_MESSAGE) };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) info.code = truncate(code, MAX_CODE);
    if (err.name) info.name = truncate(err.name, MAX_CODE);
    return info;
  }
  if (typeof err === 'string') return { message: truncate(err, MAX_MESSAGE) };
  return { message: 'Non-error value thrown', code: JobsErrorCode.HandlerError };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** State as seen by callers: scheduled jobs whose run time has passed are waiting. */
export function effectiveState(record: Pick<JobRecord, 'state' | 'runAt'>, now: number): JobState {
  if (record.state === 'scheduled' && record.runAt <= now) return 'waiting';
  return record.state;
}

export function toJob(record: JobRecord, now: number): Job {
  const job: Job = {
    id: record.id,
    name: record.name,
    payload: parseJson(record.payloadJson),
    state: effectiveState(record, now),
    priority: record.priority,
    runAt: new Date(record.runAt),
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    progress: { percent: record.progressPercent },
    cancelRequested: record.cancelRequested,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
  if (record.backoff) job.backoff = record.backoff;
  if (record.progressDataJson !== null) job.progress.data = parseJson(record.progressDataJson);
  if (record.resultJson !== null) job.result = parseJson(record.resultJson);
  if (record.lastError) job.lastError = record.lastError;
  if (record.workerId !== null) job.workerId = record.workerId;
  if (record.leaseExpiresAt !== null) job.leaseExpiresAt = new Date(record.leaseExpiresAt);
  if (record.startedAt !== null) job.startedAt = new Date(record.startedAt);
  if (record.finishedAt !== null) job.finishedAt = new Date(record.finishedAt);
  return job;
}

export function encodeCursor(seq: number): string {
  return Buffer.from(`s:${seq}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^s:(\d{1,15})$/.exec(text);
  if (!match?.[1]) {
    throw new JobsError(JobsErrorCode.InvalidOption, 'Invalid option "cursor": malformed cursor', {
      status: 400,
      expose: true,
    });
  }
  return Number(match[1]);
}

export function positiveInt(value: unknown, option: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new JobsError(
      JobsErrorCode.InvalidOption,
      `Invalid option "${option}": must be an integer from ${min} to ${max}`,
      { status: 400, expose: true },
    );
  }
  return value;
}
