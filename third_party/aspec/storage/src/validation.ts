import { StorageError } from './errors.js';
import type { FileMetadata, FileMetadataValue } from './types.js';

const MAX_FILENAME_BYTES = 255;
const MAX_KEY_BYTES = 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
// C0 and C1 controls, DEL, bidirectional overrides and isolates, zero-width and BOM characters.
const UNSAFE_FILENAME_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'g',
);
const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const KEY_FORBIDDEN_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\\\]');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let out = '';
  for (const ch of value) {
    if (utf8Length(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Turns an untrusted client filename into a safe display name: keeps only the last path
 * segment, removes control, bidirectional and reserved characters, trims dots and spaces,
 * avoids Windows device names and limits the length to 255 UTF-8 bytes (keeping the
 * extension). Never throws; returns `fallback` when nothing usable remains.
 */
export function sanitizeFilename(input: string | undefined | null, fallback = 'file'): string {
  if (typeof input !== 'string') return fallback;
  let name = input.normalize('NFC');
  const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSep !== -1) name = name.slice(lastSep + 1);
  name = name.replace(UNSAFE_FILENAME_CHARS, '').replace(RESERVED_FILENAME_CHARS, '_');
  name = name
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (name === '' || name === '.' || name === '..') return fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (utf8Length(name) > MAX_FILENAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = truncateUtf8(
      name.slice(0, name.length - ext.length),
      MAX_FILENAME_BYTES - utf8Length(ext),
    );
    name = name.replace(/[\s.]+$/, '') + ext;
  }
  return name === '' ? fallback : name;
}

/**
 * Validates a storage key: relative, forward slashes only, no `.`/`..`/empty segments, no NUL,
 * backslashes or control characters, at most 1024 UTF-8 bytes. Throws STORAGE_INVALID_KEY.
 * Drivers apply additional backend checks (the local driver also verifies the resolved path).
 */
export function validateKey(key: string): string {
  const fail = (reason: string): never => {
    throw new StorageError('STORAGE_INVALID_KEY', { message: `Invalid storage key: ${reason}` });
  };
  if (typeof key !== 'string' || key.length === 0) fail('empty');
  if (utf8Length(key) > MAX_KEY_BYTES) fail('longer than 1024 bytes');
  if (KEY_FORBIDDEN_CHARS.test(key)) fail('contains control characters or backslashes');
  if (key.startsWith('/')) fail('absolute path');
  if (/^[A-Za-z]:/.test(key)) fail('drive-qualified path');
  for (const segment of key.split('/')) {
    if (segment === '') fail('empty path segment');
    if (segment === '.' || segment === '..') fail('dot segment');
  }
  return key;
}

/** Validates a file or session ID used in keys and URLs. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export interface MetadataLimits {
  /** Default 32. */
  maxKeys: number;
  /** Default 64. */
  maxKeyLength: number;
  /** Default 1024. */
  maxValueLength: number;
  /** Serialised JSON size, default 8192 bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_METADATA_LIMITS: MetadataLimits = {
  maxKeys: 32,
  maxKeyLength: 64,
  maxValueLength: 1024,
  maxTotalBytes: 8192,
};

const METADATA_KEY = /^[A-Za-z0-9_.-]+$/;

/** Validates bounded custom metadata. Throws STORAGE_VALIDATION_FAILED with details. */
export function validateMetadata(
  input: unknown,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): FileMetadata {
  if (input === undefined || input === null) return {};
  const fail = (message: string): never => {
    throw new StorageError('STORAGE_VALIDATION_FAILED', {
      message: `Invalid metadata: ${message}`,
      details: { field: 'metadata' },
    });
  };
  if (typeof input !== 'object' || Array.isArray(input)) fail('must be an object');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > limits.maxKeys) fail(`at most ${limits.maxKeys} keys are allowed`);
  const out: FileMetadata = {};
  for (const [key, value] of entries) {
    if (key.length > limits.maxKeyLength || !METADATA_KEY.test(key)) {
      fail(`key ${JSON.stringify(key.slice(0, 80))} is not allowed`);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail(`key ${key} is reserved`);
    }
    let v: FileMetadataValue;
    if (value === null || typeof value === 'boolean') v = value;
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(`value of ${key} must be a finite number`);
      v = value;
    } else if (typeof value === 'string') {
      if (value.length > limits.maxValueLength) fail(`value of ${key} is too long`);
      v = value;
    } else {
      return fail(`value of ${key} must be a string, number, boolean or null`);
    }
    Object.defineProperty(out, key, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (utf8Length(JSON.stringify(out)) > limits.maxTotalBytes) {
    fail(`serialised metadata exceeds ${limits.maxTotalBytes} bytes`);
  }
  return out;
}
