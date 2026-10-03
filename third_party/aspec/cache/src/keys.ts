import { createHash } from 'node:crypto';
import { CacheError, CacheErrorCode } from './errors.js';

const MAX_KEY_BYTES = 512;
const SAFE = /^[A-Za-z0-9:._@/-]+$/;

/**
 * Builds a cache key from non-empty string/number/boolean/bigint parts joined by `:`.
 * Long keys are truncated with a SHA-256 suffix so Redis and memory stores stay within limits.
 */
export function key(...parts: Array<string | number | boolean | bigint>): string {
  if (parts.length === 0) {
    throw new CacheError(CacheErrorCode.KEY_INVALID, 'Cache key requires at least one part');
  }
  const raw = parts
    .map((part, index) => {
      if (part === null || part === undefined || (typeof part === 'string' && part.length === 0)) {
        throw new CacheError(CacheErrorCode.KEY_INVALID, `Cache key part ${index} is empty`);
      }
      return String(part);
    })
    .join(':');
  return normaliseKey(raw);
}

/** Validates and optionally hashes a key so it stays within length and character limits. */
export function normaliseKey(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CacheError(CacheErrorCode.KEY_INVALID, 'Cache key must be a non-empty string');
  }
  if (raw.includes('\0')) {
    throw new CacheError(CacheErrorCode.KEY_INVALID, 'Cache key must not contain NUL');
  }
  if (!SAFE.test(raw)) {
    throw new CacheError(
      CacheErrorCode.KEY_INVALID,
      'Cache key may only contain letters, digits and :._@/-',
    );
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= MAX_KEY_BYTES) return raw;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, Math.max(1, MAX_KEY_BYTES - 65));
  return `${prefix}#${hash}`;
}

export function versionedKey(
  version: string | number,
  ...parts: Array<string | number | boolean | bigint>
): string {
  return key(`v${version}`, ...parts);
}
