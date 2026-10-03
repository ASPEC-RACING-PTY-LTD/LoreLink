import { randomBytes } from 'node:crypto';
import { type ErrorClass, invalidConfig, NotificationProviderError } from './errors.js';

/** Exponential backoff with jitter. Attempts are counted from 1 (the first try). */
export interface RetryPolicy {
  /** Total attempts including the first. Default 5. */
  maxAttempts: number;
  /** Delay before the second attempt. Default 1000 ms. */
  initialDelayMs: number;
  /** Growth factor per attempt. Default 2. */
  multiplier: number;
  /** Upper bound of a single delay. Default 60000 ms. */
  maxDelayMs: number;
  /** Fraction (0 to 1) of each delay that is randomised downwards. Default 0.5. */
  jitter: number;
}

export const defaultRetryPolicy: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 5,
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 60_000,
  jitter: 0.5,
});

export function resolveRetryPolicy(
  input: Partial<RetryPolicy> = {},
  option = 'retry',
): RetryPolicy {
  const policy = { ...defaultRetryPolicy, ...input };
  const check = (name: keyof RetryPolicy, ok: boolean, reason: string) => {
    if (!ok) throw invalidConfig(`${option}.${name}`, reason);
  };
  check(
    'maxAttempts',
    Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= 50,
    'must be an integer from 1 to 50',
  );
  check(
    'initialDelayMs',
    Number.isFinite(policy.initialDelayMs) && policy.initialDelayMs >= 0,
    'must be a non-negative number',
  );
  check('multiplier', Number.isFinite(policy.multiplier) && policy.multiplier >= 1, 'must be >= 1');
  check(
    'maxDelayMs',
    Number.isFinite(policy.maxDelayMs) && policy.maxDelayMs >= policy.initialDelayMs,
    'must be >= initialDelayMs',
  );
  check(
    'jitter',
    Number.isFinite(policy.jitter) && policy.jitter >= 0 && policy.jitter <= 1,
    'must be from 0 to 1',
  );
  return policy;
}

/** Cryptographically random float in [0, 1). */
export function secureRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** Delay to wait after the given failed attempt (1-based) before the next one. */
export function computeRetryDelay(
  failedAttempt: number,
  policy: RetryPolicy,
  random: () => number = secureRandom,
): number {
  const exp = policy.initialDelayMs * policy.multiplier ** Math.max(0, failedAttempt - 1);
  const base = Math.min(policy.maxDelayMs, exp);
  return Math.round(base - base * policy.jitter * random());
}

export interface ClassifiedError {
  errorClass: ErrorClass;
  errorCode: string;
  message: string;
}

/** Classifies any thrown value. Unknown errors are transient so they are retried. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof NotificationProviderError) {
    return { errorClass: err.errorClass, errorCode: err.providerCode, message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { errorClass: 'transient', errorCode: 'TIMEOUT', message: err.message };
    }
    const code = (err as { code?: unknown }).code;
    return {
      errorClass: 'transient',
      errorCode: typeof code === 'string' && code !== '' ? code : 'UNKNOWN',
      message: err.message,
    };
  }
  return { errorClass: 'transient', errorCode: 'UNKNOWN', message: String(err) };
}

/** Resolves after ms, or rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
