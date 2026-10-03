/** Error codes thrown by @aspec/storage. Every code is stable and documented in troubleshooting.md. */
export const STORAGE_ERROR_CODES = {
  STORAGE_CONFIG_INVALID: { status: 500, expose: false, message: 'Invalid storage configuration' },
  STORAGE_VALIDATION_FAILED: { status: 400, expose: true, message: 'The request is invalid' },
  STORAGE_INVALID_KEY: { status: 400, expose: true, message: 'The storage key is invalid' },
  STORAGE_FILE_TOO_LARGE: { status: 413, expose: true, message: 'The file exceeds the size limit' },
  STORAGE_SIZE_MISMATCH: {
    status: 400,
    expose: true,
    message: 'The uploaded size does not match the declared size',
  },
  STORAGE_TYPE_NOT_ALLOWED: { status: 415, expose: true, message: 'This file type is not allowed' },
  STORAGE_TYPE_MISMATCH: {
    status: 415,
    expose: true,
    message: 'The file content does not match its declared type or extension',
  },
  STORAGE_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    expose: true,
    message: 'The request content type is not supported',
  },
  STORAGE_QUOTA_EXCEEDED: { status: 413, expose: true, message: 'The storage quota is exceeded' },
  STORAGE_UNAUTHENTICATED: { status: 401, expose: true, message: 'Authentication required' },
  STORAGE_FORBIDDEN: { status: 403, expose: true, message: 'Access to this file is not allowed' },
  STORAGE_FILE_NOT_FOUND: { status: 404, expose: true, message: 'File not found' },
  STORAGE_FILE_NOT_READY: { status: 409, expose: true, message: 'The file upload is not complete' },
  STORAGE_OBJECT_NOT_FOUND: {
    status: 404,
    expose: false,
    message: 'The stored object for this file is missing',
  },
  STORAGE_RANGE_NOT_SATISFIABLE: {
    status: 416,
    expose: true,
    message: 'The requested range is not satisfiable',
  },
  STORAGE_CHECKSUM_MISMATCH: {
    status: 460,
    expose: true,
    message: 'The uploaded data does not match the provided checksum',
  },
  STORAGE_INTEGRITY_FAILED: {
    status: 500,
    expose: false,
    message: 'The stored file failed integrity verification',
  },
  STORAGE_SIGNATURE_INVALID: { status: 403, expose: true, message: 'The signed URL is invalid' },
  STORAGE_SIGNATURE_EXPIRED: { status: 403, expose: true, message: 'The signed URL has expired' },
  STORAGE_UPLOAD_NOT_FOUND: { status: 404, expose: true, message: 'Upload not found' },
  STORAGE_UPLOAD_EXPIRED: { status: 410, expose: true, message: 'The upload has expired' },
  STORAGE_UPLOAD_OFFSET_MISMATCH: {
    status: 409,
    expose: true,
    message: 'The upload offset does not match the stored offset',
  },
  STORAGE_UPLOAD_LOCKED: {
    status: 423,
    expose: true,
    message: 'Another request is currently writing to this upload',
  },
  STORAGE_UPLOAD_INCOMPLETE: { status: 409, expose: true, message: 'The upload is not complete' },
  STORAGE_UPLOAD_INTERRUPTED: {
    status: 400,
    expose: true,
    message: 'The upload was interrupted; resume from the stored offset',
  },
  STORAGE_ABORTED: { status: 400, expose: true, message: 'The operation was aborted' },
  STORAGE_NOT_SUPPORTED: {
    status: 501,
    expose: true,
    message: 'This operation is not supported by the configured storage',
  },
  STORAGE_TUS_VERSION_UNSUPPORTED: {
    status: 412,
    expose: true,
    message: 'Unsupported Tus-Resumable version',
  },
  STORAGE_METHOD_NOT_ALLOWED: { status: 405, expose: true, message: 'Method not allowed' },
  STORAGE_DRIVER_ERROR: { status: 502, expose: false, message: 'The storage backend failed' },
  STORAGE_STORE_FULL: { status: 507, expose: false, message: 'Metadata store capacity reached' },
  STORAGE_INTERNAL: { status: 500, expose: false, message: 'Internal storage error' },
} as const satisfies Record<string, { status: number; expose: boolean; message: string }>;

export type StorageErrorCode = keyof typeof STORAGE_ERROR_CODES;

export interface StorageErrorOptions {
  message?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Error thrown by every @aspec/storage API. Satisfies the ErrorLike port (`code`, `status`,
 * `expose`, `details`) so @aspec/errors or any problem+json mapper can translate it.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(code: StorageErrorCode, options: StorageErrorOptions = {}) {
    const def = STORAGE_ERROR_CODES[code];
    super(
      options.message ?? def.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = def.status;
    this.expose = def.expose;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

/** Throws STORAGE_CONFIG_INVALID naming the offending option. */
export function configError(option: string, problem: string): never {
  throw new StorageError('STORAGE_CONFIG_INVALID', {
    message: `Invalid option ${option}: ${problem}`,
  });
}
