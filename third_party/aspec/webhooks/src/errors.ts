export type WebhooksErrorCode =
  | 'WEBHOOKS_INVALID_CONFIG'
  | 'WEBHOOKS_INVALID_INPUT'
  | 'WEBHOOKS_NOT_FOUND'
  | 'WEBHOOKS_FORBIDDEN'
  | 'WEBHOOKS_UNAUTHENTICATED'
  | 'WEBHOOKS_CONFLICT'
  | 'WEBHOOKS_SSRF_BLOCKED'
  | 'WEBHOOKS_SIGNATURE_INVALID'
  | 'WEBHOOKS_TIMESTAMP_EXPIRED'
  | 'WEBHOOKS_REPLAY'
  | 'WEBHOOKS_DELIVERY_FAILED'
  | 'WEBHOOKS_PAYLOAD_TOO_LARGE'
  | 'WEBHOOKS_UNSUPPORTED_MEDIA_TYPE'
  | 'WEBHOOKS_INTERNAL';

export interface WebhooksErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class WebhooksError extends Error {
  readonly code: WebhooksErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(code: WebhooksErrorCode, message: string, options: WebhooksErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WebhooksError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isWebhooksError(err: unknown): err is WebhooksError {
  return err instanceof WebhooksError;
}

export function invalidConfig(option: string, reason: string): WebhooksError {
  return new WebhooksError('WEBHOOKS_INVALID_CONFIG', `Invalid option ${option}: ${reason}`, {
    status: 500,
    expose: false,
  });
}

export function invalidInput(message: string, details?: unknown): WebhooksError {
  return new WebhooksError('WEBHOOKS_INVALID_INPUT', message, {
    status: 400,
    expose: true,
    ...(details === undefined ? {} : { details }),
  });
}
