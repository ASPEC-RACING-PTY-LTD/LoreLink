import nodemailer from 'nodemailer';
import { type ErrorClass, invalidConfig, NotificationProviderError } from '../errors.js';
import type { HealthCheckable, HealthCheckResult } from '../ports.js';
import type { EmailContent, EmailTransport } from '../types.js';

export interface SmtpTlsOptions {
  /** Verify the server certificate. Default true. Disable only for local development servers. */
  rejectUnauthorized?: boolean;
  /** Server name for SNI and certificate checks when connecting by IP. */
  servername?: string;
  /** Minimum TLS version. Default "TLSv1.2". */
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Extra trusted CA certificates (PEM). */
  ca?: string | readonly string[];
}

export interface SmtpDkimOptions {
  domainName: string;
  keySelector: string;
  /** PEM private key. Load it from a secret store, never commit it. */
  privateKey: string;
  /** Colon separated header names to sign. Nodemailer default when omitted. */
  headerFieldNames?: string;
}

export interface SmtpOptions {
  host: string;
  /** Default 587, or 465 when secure is true. */
  port?: number;
  /** Implicit TLS from the first byte (SMTPS, usually port 465). Default false. */
  secure?: boolean;
  /** Require STARTTLS; fail when the server does not offer it. Default false. Recommended in production. */
  requireTLS?: boolean;
  /** Never use STARTTLS even when offered. Default false. Development only. */
  ignoreTLS?: boolean;
  tls?: SmtpTlsOptions;
  auth?: { user: string; pass: string };
  /** Connection pooling. true or pool limits. Default false (one connection per message). */
  pool?: boolean | { maxConnections?: number; maxMessages?: number };
  dkim?: SmtpDkimOptions;
  /** Default sender used when a message has no from address. */
  from?: string;
  /** Hostname announced in EHLO. Default: the machine hostname. */
  name?: string;
  /** Default 10000 ms. */
  connectionTimeoutMs?: number;
  /** Default 10000 ms. */
  greetingTimeoutMs?: number;
  /** Default 60000 ms. */
  socketTimeoutMs?: number;
}

export interface SmtpTransport extends EmailTransport, HealthCheckable {
  /** Closes pooled connections. */
  close(): Promise<void>;
}

interface SentInfo {
  messageId?: string;
}

interface NodemailerTransporter {
  sendMail(message: Record<string, unknown>): Promise<SentInfo>;
  verify(): Promise<true>;
  close(): void;
}

const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'EPROXY',
  'EMAXLIMIT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

const PERMANENT_CODES: Record<string, string> = {
  EAUTH: 'SMTP_AUTH',
  ENOAUTH: 'SMTP_AUTH',
  ETLS: 'SMTP_TLS',
  EREQUIRETLS: 'SMTP_TLS',
  ECONFIG: 'SMTP_CONFIG',
  EMESSAGE: 'SMTP_MESSAGE',
  ESTREAM: 'SMTP_MESSAGE',
  EENVELOPE: 'INVALID_ADDRESS',
  EMAXRECIPIENTS: 'SMTP_MESSAGE',
};

/**
 * Classifies an SMTP or Nodemailer error: 4xx replies and connection problems are
 * transient, 5xx replies, authentication, TLS and envelope errors are permanent.
 */
export function classifySmtpError(err: unknown): NotificationProviderError {
  if (err instanceof NotificationProviderError) return err;
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  let errorClass: ErrorClass = 'transient';
  let providerCode = code ?? 'SMTP_ERROR';
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    errorClass = 'transient';
    providerCode = 'SMTP_4XX';
  } else if (responseCode !== undefined && responseCode >= 500) {
    errorClass = 'permanent';
    providerCode = 'SMTP_5XX';
  } else if (code !== undefined && TRANSIENT_CODES.has(code)) {
    errorClass = 'transient';
  } else if (code !== undefined && PERMANENT_CODES[code] !== undefined) {
    errorClass = 'permanent';
    providerCode = PERMANENT_CODES[code] as string;
  }
  const message = typeof e.message === 'string' ? e.message : 'SMTP delivery failed';
  return new NotificationProviderError(message, {
    errorClass,
    providerCode,
    cause: err,
    ...(responseCode === undefined ? {} : { responseCode }),
  });
}

function positive(name: string, value: number | undefined, def: number): number {
  const v = value ?? def;
  if (!Number.isFinite(v) || v <= 0)
    throw invalidConfig(`smtp.${name}`, 'must be a positive number');
  return v;
}

/** Creates an SMTP transport (Nodemailer) with pooling, TLS, authentication, DKIM and health checks. */
export function createSmtpTransport(options: SmtpOptions): SmtpTransport {
  if (!options || typeof options.host !== 'string' || options.host.trim() === '') {
    throw invalidConfig('smtp.host', 'is required');
  }
  const secure = options.secure ?? false;
  const port = options.port ?? (secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw invalidConfig('smtp.port', 'must be 1 to 65535');
  if (options.requireTLS && options.ignoreTLS) {
    throw invalidConfig('smtp.ignoreTLS', 'cannot be combined with requireTLS');
  }
  if (
    options.auth &&
    (typeof options.auth.user !== 'string' || typeof options.auth.pass !== 'string')
  ) {
    throw invalidConfig('smtp.auth', 'needs user and pass strings');
  }
  if (options.dkim) {
    for (const key of ['domainName', 'keySelector', 'privateKey'] as const) {
      if (typeof options.dkim[key] !== 'string' || options.dkim[key] === '') {
        throw invalidConfig(`smtp.dkim.${key}`, 'is required when dkim is set');
      }
    }
  }
  const tls: Record<string, unknown> = {
    rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
    minVersion: options.tls?.minVersion ?? 'TLSv1.2',
  };
  if (options.tls?.servername !== undefined) tls.servername = options.tls.servername;
  if (options.tls?.ca !== undefined) tls.ca = options.tls.ca;

  const config: Record<string, unknown> = {
    host: options.host,
    port,
    secure,
    requireTLS: options.requireTLS ?? false,
    ignoreTLS: options.ignoreTLS ?? false,
    tls,
    connectionTimeout: positive('connectionTimeoutMs', options.connectionTimeoutMs, 10_000),
    greetingTimeout: positive('greetingTimeoutMs', options.greetingTimeoutMs, 10_000),
    socketTimeout: positive('socketTimeoutMs', options.socketTimeoutMs, 60_000),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (options.name !== undefined) config.name = options.name;
  if (options.auth) config.auth = { user: options.auth.user, pass: options.auth.pass };
  if (options.pool) {
    config.pool = true;
    if (typeof options.pool === 'object') {
      if (options.pool.maxConnections !== undefined)
        config.maxConnections = options.pool.maxConnections;
      if (options.pool.maxMessages !== undefined) config.maxMessages = options.pool.maxMessages;
    }
  }
  if (options.dkim) config.dkim = { ...options.dkim };

  const transporter = nodemailer.createTransport(
    config as Parameters<typeof nodemailer.createTransport>[0],
  ) as unknown as NodemailerTransporter;

  return {
    async send(email: EmailContent) {
      const message: Record<string, unknown> = {
        from: email.from ?? options.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
      };
      if (message.from === undefined) {
        throw new NotificationProviderError('No sender address configured (from)', {
          errorClass: 'permanent',
          providerCode: 'INVALID_SENDER',
        });
      }
      if (email.html !== undefined) message.html = email.html;
      if (email.replyTo !== undefined) message.replyTo = email.replyTo;
      if (email.headers !== undefined) message.headers = { ...email.headers };
      try {
        const info = await transporter.sendMail(message);
        return typeof info.messageId === 'string' ? { messageId: info.messageId } : {};
      } catch (err) {
        throw classifySmtpError(err);
      }
    },
    async checkHealth(): Promise<HealthCheckResult> {
      const started = Date.now();
      try {
        await transporter.verify();
        return { ok: true, latencyMs: Date.now() - started, details: { host: options.host, port } };
      } catch (err) {
        const classified = classifySmtpError(err);
        return {
          ok: false,
          latencyMs: Date.now() - started,
          details: { host: options.host, port, error: classified.providerCode },
        };
      }
    },
    async close() {
      transporter.close();
    },
  };
}

function envBool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw invalidConfig(name, 'must be true or false');
}

/**
 * Reads SMTP options from environment variables: SMTP_HOST (required), SMTP_PORT,
 * SMTP_SECURE, SMTP_REQUIRE_TLS, SMTP_USER, SMTP_PASSWORD, SMTP_POOL, SMTP_TLS_REJECT_UNAUTHORIZED,
 * NOTIFICATIONS_EMAIL_FROM, SMTP_DKIM_DOMAIN, SMTP_DKIM_SELECTOR and SMTP_DKIM_PRIVATE_KEY.
 */
export function smtpOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SmtpOptions {
  const host = env.SMTP_HOST;
  if (host === undefined || host === '') throw invalidConfig('SMTP_HOST', 'is required');
  const options: SmtpOptions = { host };
  if (env.SMTP_PORT !== undefined && env.SMTP_PORT !== '') {
    const port = Number(env.SMTP_PORT);
    if (!Number.isInteger(port)) throw invalidConfig('SMTP_PORT', 'must be an integer');
    options.port = port;
  }
  const secure = envBool(env.SMTP_SECURE, 'SMTP_SECURE');
  if (secure !== undefined) options.secure = secure;
  const requireTLS = envBool(env.SMTP_REQUIRE_TLS, 'SMTP_REQUIRE_TLS');
  if (requireTLS !== undefined) options.requireTLS = requireTLS;
  const pool = envBool(env.SMTP_POOL, 'SMTP_POOL');
  if (pool !== undefined) options.pool = pool;
  const reject = envBool(env.SMTP_TLS_REJECT_UNAUTHORIZED, 'SMTP_TLS_REJECT_UNAUTHORIZED');
  if (reject !== undefined) options.tls = { rejectUnauthorized: reject };
  if (env.SMTP_USER) {
    if (env.SMTP_PASSWORD === undefined)
      throw invalidConfig('SMTP_PASSWORD', 'is required with SMTP_USER');
    options.auth = { user: env.SMTP_USER, pass: env.SMTP_PASSWORD };
  }
  if (env.NOTIFICATIONS_EMAIL_FROM) options.from = env.NOTIFICATIONS_EMAIL_FROM;
  if (env.SMTP_DKIM_DOMAIN && env.SMTP_DKIM_SELECTOR && env.SMTP_DKIM_PRIVATE_KEY) {
    options.dkim = {
      domainName: env.SMTP_DKIM_DOMAIN,
      keySelector: env.SMTP_DKIM_SELECTOR,
      privateKey: env.SMTP_DKIM_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return options;
}
