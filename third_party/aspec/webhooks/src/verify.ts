import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeWhsec, timingSafeEqualBuf, timingSafeEqualString } from './crypto.js';
import { WebhooksError } from './errors.js';

export type VerifyScheme = 'standard' | 'github' | 'stripe' | 'hmac';

export interface VerifyOptions {
  scheme: VerifyScheme;
  secrets: readonly string[];
  /** Timestamp skew tolerance in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Epoch seconds now. */
  nowSeconds?: number;
  /** Header name for generic HMAC (default x-signature). */
  headerName?: string;
  /** Hash for generic HMAC: sha256 (default) or sha1. */
  algorithm?: 'sha256' | 'sha1';
}

export interface VerifiedWebhook {
  id?: string;
  timestamp?: number;
  scheme: VerifyScheme;
}

function header(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function parseStandardSignatures(value: string): string[] {
  return value
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1,'))
    .map((p) => p.slice(3));
}

function hmacDigest(algo: 'sha256' | 'sha1', secret: Buffer | string, body: Buffer): Buffer {
  return createHmac(algo, secret).update(body).digest();
}

/**
 * Verifies an incoming webhook body and headers. Throws WebhooksError on failure.
 * Does not perform replay checks; callers should use a SeenIdStore separately.
 */
export function verifyWebhookSignature(
  body: Buffer,
  headers: Headers | Record<string, string | string[] | undefined>,
  options: VerifyOptions,
): VerifiedWebhook {
  const secrets = options.secrets;
  if (!secrets.length) {
    throw new WebhooksError('WEBHOOKS_INVALID_CONFIG', 'At least one secret is required', {
      status: 500,
      expose: false,
    });
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (options.scheme === 'standard') {
    const id = header(headers, 'webhook-id');
    const tsRaw = header(headers, 'webhook-timestamp');
    const sigHeader = header(headers, 'webhook-signature');
    if (!id || !tsRaw || !sigHeader) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Missing Standard Webhooks headers', {
        status: 401,
        expose: true,
      });
    }
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid webhook-timestamp', {
        status: 401,
        expose: true,
      });
    }
    if (Math.abs(now - ts) > tolerance) {
      throw new WebhooksError('WEBHOOKS_TIMESTAMP_EXPIRED', 'Webhook timestamp outside tolerance', {
        status: 401,
        expose: true,
      });
    }
    const provided = parseStandardSignatures(sigHeader);
    const toSign = Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), body]);
    let ok = false;
    for (const secret of secrets) {
      const key = decodeWhsec(secret);
      const expected = createHmac('sha256', key).update(toSign).digest('base64');
      for (const got of provided) {
        if (timingSafeEqualString(got, expected)) ok = true;
      }
    }
    if (!ok) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid webhook signature', {
        status: 401,
        expose: true,
      });
    }
    return { id, timestamp: ts, scheme: 'standard' };
  }

  if (options.scheme === 'github') {
    const sig = header(headers, 'x-hub-signature-256');
    if (!sig?.startsWith('sha256=')) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Missing X-Hub-Signature-256', {
        status: 401,
        expose: true,
      });
    }
    const got = Buffer.from(sig.slice('sha256='.length), 'hex');
    let ok = false;
    for (const secret of secrets) {
      const expected = hmacDigest('sha256', secret, body);
      if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
    }
    if (!ok) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid GitHub signature', {
        status: 401,
        expose: true,
      });
    }
    return { scheme: 'github' };
  }

  if (options.scheme === 'stripe') {
    const sigHeader = header(headers, 'stripe-signature');
    if (!sigHeader) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Missing Stripe-Signature', {
        status: 401,
        expose: true,
      });
    }
    const parts = Object.fromEntries(
      sigHeader.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k?.trim() ?? '', v?.trim() ?? ''];
      }),
    );
    const ts = Number(parts.t);
    const v1 = parts.v1;
    if (!Number.isFinite(ts) || !v1) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid Stripe-Signature', {
        status: 401,
        expose: true,
      });
    }
    if (Math.abs(now - ts) > tolerance) {
      throw new WebhooksError('WEBHOOKS_TIMESTAMP_EXPIRED', 'Stripe timestamp outside tolerance', {
        status: 401,
        expose: true,
      });
    }
    const signed = Buffer.from(`${ts}.${body.toString('utf8')}`, 'utf8');
    let ok = false;
    for (const secret of secrets) {
      const expected = createHmac('sha256', secret).update(signed).digest('hex');
      if (timingSafeEqualString(v1, expected)) ok = true;
    }
    if (!ok) {
      throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid Stripe signature', {
        status: 401,
        expose: true,
      });
    }
    return { timestamp: ts, scheme: 'stripe' };
  }

  // generic HMAC
  const name = (options.headerName ?? 'x-signature').toLowerCase();
  const algo = options.algorithm ?? 'sha256';
  const sig = header(headers, name);
  if (!sig) {
    throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', `Missing ${name} header`, {
      status: 401,
      expose: true,
    });
  }
  const hex = sig.startsWith(`${algo}=`) ? sig.slice(algo.length + 1) : sig;
  const got = Buffer.from(hex, 'hex');
  let ok = false;
  for (const secret of secrets) {
    const expected = hmacDigest(algo, secret, body);
    if (timingSafeEqualBuf(got, expected)) ok = true;
  }
  if (!ok) {
    throw new WebhooksError('WEBHOOKS_SIGNATURE_INVALID', 'Invalid HMAC signature', {
      status: 401,
      expose: true,
    });
  }
  return { scheme: 'hmac' };
}
