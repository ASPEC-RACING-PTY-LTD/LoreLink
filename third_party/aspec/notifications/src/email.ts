import { invalidInput, NotificationProviderError, NotificationsError } from './errors.js';
import type { LoggerLike, Mailer, MailMessage } from './ports.js';
import {
  classifyError,
  computeRetryDelay,
  sleep as defaultSleep,
  type RetryPolicy,
  resolveRetryPolicy,
} from './retry.js';
import { htmlToText } from './template.js';
import type { EmailContent, EmailTransport, NotificationProvider } from './types.js';

const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAMED_ADDRESS = /^\s*(?:"[^"\r\n]*"|[^<>"\r\n]*)\s*<([^<>\r\n]+)>\s*$/;

/** True for a syntactically valid bare address (local@domain), at most 254 characters. */
export function isValidEmailAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length > 254 || /[\r\n]/.test(address)) return false;
  const at = address.lastIndexOf('@');
  if (at < 1 || at > 64) return false;
  return EMAIL_PATTERN.test(address);
}

/** Accepts "user@example.com" or "Name <user@example.com>". */
export function isValidMailbox(value: string): boolean {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
  const named = NAMED_ADDRESS.exec(value);
  return isValidEmailAddress(named ? (named[1] as string).trim() : value.trim());
}

/** Validates rendered email content. Invalid recipients are permanent failures. */
export function validateEmailContent(email: EmailContent): void {
  if (!isValidMailbox(email.to)) {
    throw new NotificationProviderError('Invalid recipient address', {
      errorClass: 'permanent',
      providerCode: 'INVALID_ADDRESS',
    });
  }
  if (email.from !== undefined && !isValidMailbox(email.from)) {
    throw new NotificationProviderError('Invalid sender address', {
      errorClass: 'permanent',
      providerCode: 'INVALID_SENDER',
    });
  }
  if (email.replyTo !== undefined && !isValidMailbox(email.replyTo)) {
    throw new NotificationProviderError('Invalid reply-to address', {
      errorClass: 'permanent',
      providerCode: 'INVALID_ADDRESS',
    });
  }
  if (/[\r\n]/.test(email.subject)) {
    throw new NotificationProviderError('Subject must not contain line breaks', {
      errorClass: 'permanent',
      providerCode: 'INVALID_MESSAGE',
    });
  }
  for (const [name, value] of Object.entries(email.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /[\r\n]/.test(value)) {
      throw new NotificationProviderError(`Invalid header "${name}"`, {
        errorClass: 'permanent',
        providerCode: 'INVALID_MESSAGE',
      });
    }
  }
}

export interface EmailChannelOptions {
  /** Default sender, for example "Acme <no-reply@acme.test>". */
  from?: string;
  replyTo?: string;
  /** Provider name recorded in logs. Default "email". */
  name?: string;
}

/** Wraps an EmailTransport (for example createSmtpTransport) as a notification channel. */
export function createEmailChannel(
  transport: EmailTransport & {
    checkHealth?: NotificationProvider['checkHealth'];
    close?: () => Promise<void>;
  },
  options: EmailChannelOptions = {},
): NotificationProvider {
  if (options.from !== undefined && !isValidMailbox(options.from)) {
    throw invalidInput('Email channel option "from" is not a valid mailbox');
  }
  const provider: NotificationProvider = {
    name: options.name ?? 'email',
    kind: 'email',
    async send(message, context) {
      if (message.content.kind !== 'email') {
        throw new NotificationProviderError('Email channel received non-email content', {
          errorClass: 'permanent',
          providerCode: 'INVALID_MESSAGE',
        });
      }
      const email: EmailContent = { ...message.content.email };
      if (email.from === undefined && options.from !== undefined) email.from = options.from;
      if (email.replyTo === undefined && options.replyTo !== undefined)
        email.replyTo = options.replyTo;
      validateEmailContent(email);
      const result = await transport.send(email, { signal: context.signal });
      return result.messageId === undefined ? {} : { messageId: result.messageId };
    },
  };
  if (transport.checkHealth) {
    const check = transport.checkHealth.bind(transport);
    Object.assign(provider, { checkHealth: () => check() });
  }
  if (transport.close) {
    const close = transport.close.bind(transport);
    Object.assign(provider, { close: () => close() });
  }
  return provider;
}

export interface MailerOptions {
  /** Default sender used when the transport has none. */
  from?: string;
  replyTo?: string;
  retry?: Partial<RetryPolicy>;
  logger?: LoggerLike;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Converts a Mailer port message into email content, generating text from HTML if needed. */
export function mailMessageToEmail(
  message: MailMessage,
  defaults: { from?: string; replyTo?: string },
): EmailContent {
  if (message === null || typeof message !== 'object')
    throw invalidInput('Mail message must be an object');
  if (typeof message.to !== 'string' || typeof message.subject !== 'string') {
    throw invalidInput('Mail message needs string "to" and "subject"');
  }
  let text = typeof message.text === 'string' ? message.text : '';
  if (text.trim() === '' && typeof message.html === 'string') text = htmlToText(message.html);
  const email: EmailContent = { to: message.to.trim(), subject: message.subject, text };
  if (typeof message.html === 'string') email.html = message.html;
  if (defaults.from !== undefined) email.from = defaults.from;
  if (defaults.replyTo !== undefined) email.replyTo = defaults.replyTo;
  return email;
}

/**
 * Standalone Mailer (the port consumed by auth, users and orgs) that sends through a
 * transport with the retry policy applied inline. It does not record delivery history;
 * use notifications.mailer for tracked delivery.
 */
export function createMailer(transport: EmailTransport, options: MailerOptions = {}): Mailer {
  const policy = resolveRetryPolicy(options.retry, 'mailer.retry');
  const wait = options.sleep ?? defaultSleep;
  const defaults: { from?: string; replyTo?: string } = {};
  if (options.from !== undefined) defaults.from = options.from;
  if (options.replyTo !== undefined) defaults.replyTo = options.replyTo;
  return {
    async send(message) {
      const email = mailMessageToEmail(message, defaults);
      try {
        validateEmailContent(email);
      } catch (err) {
        throw new NotificationsError('NOTIFICATIONS_INVALID_INPUT', (err as Error).message, {
          status: 400,
          expose: true,
          cause: err,
        });
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await transport.send(email);
          return result.messageId === undefined ? {} : { id: result.messageId };
        } catch (err) {
          const info = classifyError(err);
          const retry = info.errorClass === 'transient' && attempt < policy.maxAttempts;
          options.logger?.warn(
            {
              category: message.category,
              attempt,
              errorClass: info.errorClass,
              errorCode: info.errorCode,
              willRetry: retry,
            },
            'notifications: email send failed',
          );
          if (!retry) {
            throw new NotificationsError(
              'NOTIFICATIONS_DELIVERY_FAILED',
              `Email delivery failed after ${attempt} attempt(s): ${info.errorCode}`,
              {
                status: 502,
                expose: false,
                cause: err,
                details: {
                  errorClass: info.errorClass,
                  errorCode: info.errorCode,
                  attempts: attempt,
                },
              },
            );
          }
          await wait(computeRetryDelay(attempt, policy, options.random));
        }
      }
    },
  };
}
