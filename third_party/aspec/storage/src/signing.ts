import { createHmac, timingSafeEqual } from 'node:crypto';
import { configError } from './errors.js';

export type SignedMethod = 'GET' | 'PUT';
export type ContentDispositionType = 'inline' | 'attachment';

export interface SignedUrlClaims {
  method: SignedMethod;
  fileId: string;
  key: string;
  /** Expiry as epoch seconds. */
  expires: number;
  disposition?: ContentDispositionType;
}

/** Query parameter names used by adapter signed URLs. */
export const SIGNED_URL_PARAMS = {
  expires: 'expires',
  disposition: 'disposition',
  signature: 'signature',
} as const;

const MIN_SECRET_BYTES = 32;

/** Normalises the signingSecret option. The first secret signs; every secret verifies. */
export function normalizeSecrets(
  input: string | Uint8Array | ReadonlyArray<string | Uint8Array>,
): Buffer[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) configError('signingSecret', 'at least one secret is required');
  return list.map((s, i) => {
    const buf = typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s as Uint8Array);
    if (buf.length < MIN_SECRET_BYTES) {
      configError(`signingSecret[${i}]`, `must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return buf;
  });
}

function canonical(claims: SignedUrlClaims): string {
  return [
    'aspec-storage-v1',
    claims.method,
    claims.fileId,
    claims.key,
    String(claims.expires),
    claims.disposition ?? '',
  ].join('\n');
}

function mac(secret: Buffer, claims: SignedUrlClaims): Buffer {
  return createHmac('sha256', secret).update(canonical(claims), 'utf8').digest();
}

/** HMAC-SHA256 signature (base64url) over method, file ID, key, expiry and disposition. */
export function signClaims(secrets: readonly Buffer[], claims: SignedUrlClaims): string {
  const first = secrets[0];
  if (!first) return configError('signingSecret', 'no secret configured');
  return mac(first, claims).toString('base64url');
}

/** Constant-time verification against every configured secret. */
export function verifyClaims(
  secrets: readonly Buffer[],
  claims: SignedUrlClaims,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const provided = Buffer.from(signature, 'base64url');
  let ok = false;
  for (const secret of secrets) {
    const expected = mac(secret, claims);
    // Evaluate every secret so timing does not reveal which one matched.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) ok = true;
  }
  return ok;
}
