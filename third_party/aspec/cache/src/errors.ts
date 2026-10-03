export const CacheErrorCode = {
  UNAVAILABLE: 'CACHE_UNAVAILABLE',
  KEY_INVALID: 'CACHE_KEY_INVALID',
  SERIALIZE: 'CACHE_SERIALIZE',
  CLOSED: 'CACHE_CLOSED',
} as const;

export type CacheErrorCode = (typeof CacheErrorCode)[keyof typeof CacheErrorCode];

export class CacheError extends Error {
  readonly code: CacheErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(
    code: CacheErrorCode,
    message: string,
    options: { status?: number; expose?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CacheError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.details = options.details;
  }
}

/** Raised when the cache backend is unavailable and `failOpen` is false. */
export class CacheUnavailableError extends CacheError {
  constructor(
    message = 'Cache backend is unavailable',
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(CacheErrorCode.UNAVAILABLE, message, {
      status: 503,
      cause: options.cause,
      details: options.details,
    });
    this.name = 'CacheUnavailableError';
  }
}

export function isCacheError(value: unknown): value is CacheError {
  return value instanceof CacheError;
}
