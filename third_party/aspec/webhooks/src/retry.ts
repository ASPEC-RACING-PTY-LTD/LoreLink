/** Standard Webhooks inspired retry delays (ms), attempt index 0 = first retry after failure. */
export const DEFAULT_RETRY_SCHEDULE_MS: readonly number[] = Object.freeze([
  0,
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
  10 * 60 * 60_000,
  10 * 60 * 60_000,
]);

export interface RetryPolicy {
  scheduleMs: readonly number[];
  /** Fraction of each delay randomised downwards. Default 0.1. */
  jitter: number;
  maxAttempts: number;
}

export function resolveRetryPolicy(input?: Partial<RetryPolicy>): RetryPolicy {
  const scheduleMs = input?.scheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS;
  const jitter = input?.jitter ?? 0.1;
  const maxAttempts = input?.maxAttempts ?? scheduleMs.length;
  return { scheduleMs, jitter, maxAttempts };
}

export function nextRetryDelayMs(
  failedAttempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number | undefined {
  // failedAttempt is 1-based count of failures so far
  const index = failedAttempt - 1;
  if (failedAttempt >= policy.maxAttempts) return undefined;
  const base = policy.scheduleMs[Math.min(index, policy.scheduleMs.length - 1)] ?? 0;
  return Math.round(base - base * policy.jitter * random());
}
