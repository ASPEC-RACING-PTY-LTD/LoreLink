import { randomInt } from 'node:crypto';
import { invalidOption } from './errors.js';
import type { BackoffPolicy, SerializableBackoff } from './types.js';

export const DEFAULT_BACKOFF: SerializableBackoff = {
  type: 'exponential',
  baseMs: 1000,
  factor: 2,
  maxMs: 3_600_000,
  jitter: 'full',
};

const MAX_DELAY_MS = 365 * 24 * 3_600_000;

/** Random integer in [0, max] using crypto randomness. */
export type RandomSource = (maxInclusive: number) => number;

const cryptoRandom: RandomSource = (max) => {
  if (max <= 0) return 0;
  // randomInt requires max - min < 2^48.
  const bounded = Math.min(Math.floor(max), 2 ** 47);
  return randomInt(0, bounded + 1);
};

function nonNegativeFinite(value: unknown, option: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidOption(option, 'must be a non-negative finite number');
  }
  return value;
}

/** Validates a backoff policy and returns it (functions are accepted as is). */
export function validateBackoff(policy: unknown, option: string): BackoffPolicy {
  if (typeof policy === 'function') return policy as BackoffPolicy;
  if (typeof policy !== 'object' || policy === null) {
    throw invalidOption(option, 'must be a backoff object or a function');
  }
  const p = policy as Record<string, unknown>;
  if (p.type === 'fixed') {
    nonNegativeFinite(p.delayMs, `${option}.delayMs`);
    return { type: 'fixed', delayMs: p.delayMs as number };
  }
  if (p.type === 'exponential') {
    const out: SerializableBackoff = { type: 'exponential' };
    if (p.baseMs !== undefined) out.baseMs = nonNegativeFinite(p.baseMs, `${option}.baseMs`);
    if (p.factor !== undefined) {
      const factor = nonNegativeFinite(p.factor, `${option}.factor`);
      if (factor < 1) throw invalidOption(`${option}.factor`, 'must be at least 1');
      out.factor = factor;
    }
    if (p.maxMs !== undefined) out.maxMs = nonNegativeFinite(p.maxMs, `${option}.maxMs`);
    if (p.jitter !== undefined) {
      if (p.jitter !== 'full' && p.jitter !== 'equal' && p.jitter !== 'none') {
        throw invalidOption(`${option}.jitter`, 'must be "full", "equal" or "none"');
      }
      out.jitter = p.jitter;
    }
    return out;
  }
  throw invalidOption(`${option}.type`, 'must be "exponential" or "fixed"');
}

/**
 * Computes the delay before the next attempt. `attempt` is the attempt that just failed
 * (1-based). The result is clamped to [0, one year].
 */
export function computeBackoff(
  policy: BackoffPolicy,
  attempt: number,
  error: unknown,
  random: RandomSource = cryptoRandom,
): number {
  let delay: number;
  if (typeof policy === 'function') {
    delay = policy(attempt, error);
  } else if (policy.type === 'fixed') {
    delay = policy.delayMs;
  } else {
    const base = policy.baseMs ?? 1000;
    const factor = policy.factor ?? 2;
    const max = policy.maxMs ?? 3_600_000;
    const raw = Math.min(max, base * factor ** Math.max(0, attempt - 1));
    const jitter = policy.jitter ?? 'full';
    if (jitter === 'full') delay = random(raw);
    else if (jitter === 'equal') delay = raw / 2 + random(raw / 2);
    else delay = raw;
  }
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) return 0;
  return Math.min(Math.floor(delay), MAX_DELAY_MS);
}
