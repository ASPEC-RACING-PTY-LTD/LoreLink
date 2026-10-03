export type NotificationsErrorCode =
  | 'NOTIFICATIONS_INVALID_CONFIG'
  | 'NOTIFICATIONS_INVALID_INPUT'
  | 'NOTIFICATIONS_TEMPLATE_SYNTAX'
  | 'NOTIFICATIONS_TEMPLATE_NOT_FOUND'
  | 'NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING'
  | 'NOTIFICATIONS_CHANNEL_NOT_FOUND'
  | 'NOTIFICATIONS_NOT_FOUND'
  | 'NOTIFICATIONS_PREFERENCE_MANDATORY'
  | 'NOTIFICATIONS_DELIVERY_FAILED'
  | 'NOTIFICATIONS_UNAUTHENTICATED'
  | 'NOTIFICATIONS_PROVIDER_ERROR';

export interface NotificationsErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Base error class. Satisfies the ErrorLike shape consumed by @aspec/errors. */
export class NotificationsError extends Error {
  readonly code: NotificationsErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    code: NotificationsErrorCode,
    message: string,
    options: NotificationsErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NotificationsError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? this.status < 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** Classification of a delivery failure. Transient failures are retried, permanent ones are not. */
export type ErrorClass = 'transient' | 'permanent';

export interface ProviderErrorOptions {
  errorClass: ErrorClass;
  /** Short provider specific code, for example SMTP_4XX, SMTP_5XX, HTTP_503, TIMEOUT. */
  providerCode: string;
  /** SMTP reply code or HTTP status when known. */
  responseCode?: number;
  cause?: unknown;
}

/** Thrown by NotificationProvider implementations to report a classified delivery failure. */
export class NotificationProviderError extends NotificationsError {
  readonly errorClass: ErrorClass;
  readonly providerCode: string;
  readonly responseCode?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super('NOTIFICATIONS_PROVIDER_ERROR', message, {
      status: 502,
      expose: false,
      cause: options.cause,
    });
    this.name = 'NotificationProviderError';
    this.errorClass = options.errorClass;
    this.providerCode = options.providerCode;
    if (options.responseCode !== undefined) this.responseCode = options.responseCode;
  }
}

export function isNotificationsError(err: unknown): err is NotificationsError {
  return err instanceof NotificationsError;
}

export function invalidConfig(option: string, reason: string): NotificationsError {
  return new NotificationsError(
    'NOTIFICATIONS_INVALID_CONFIG',
    `Invalid option "${option}": ${reason}`,
    {
      status: 500,
      expose: false,
    },
  );
}

export function invalidInput(message: string, details?: unknown): NotificationsError {
  return new NotificationsError('NOTIFICATIONS_INVALID_INPUT', message, {
    status: 400,
    expose: true,
    details,
  });
}
