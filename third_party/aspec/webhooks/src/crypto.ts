import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { invalidConfig, invalidInput } from './errors.js';

const AES_ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Parses WEBHOOKS_ENCRYPTION_KEY: 32-byte raw, base64, or 64-char hex. */
export function parseEncryptionKey(raw: string): Buffer {
  if (typeof raw !== 'string' || raw === '') {
    throw invalidConfig('encryptionKey', 'WEBHOOKS_ENCRYPTION_KEY is required');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    /* fall through */
  }
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length === 32) return buf;
  throw invalidConfig('encryptionKey', 'must be 32 bytes (raw, base64 or 64-char hex)');
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw invalidInput('corrupt encrypted secret');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Generates a Standard Webhooks secret (`whsec_` + base64 of 24 random bytes). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** Decodes a `whsec_` secret to the raw key bytes. */
export function decodeWhsec(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) {
    throw invalidInput('webhook secret must start with whsec_');
  }
  const raw = secret.slice('whsec_'.length);
  const key = Buffer.from(raw, 'base64');
  if (key.length < 16) throw invalidInput('webhook secret is too short');
  return key;
}

export function signStandardWebhooks(
  msgId: string,
  timestampSeconds: number,
  body: string | Buffer,
  secrets: readonly string[],
): string {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const toSign = Buffer.concat([Buffer.from(`${msgId}.${timestampSeconds}.`, 'utf8'), payload]);
  const parts: string[] = [];
  for (const secret of secrets) {
    const key = decodeWhsec(secret);
    const sig = createHmac('sha256', key).update(toSign).digest('base64');
    parts.push(`v1,${sig}`);
  }
  return parts.join(' ');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
