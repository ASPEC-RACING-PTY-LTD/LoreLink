import { createHash, type Hash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { StorageError } from './errors.js';
import { SNIFF_BYTES } from './mime.js';

/** Accepted upload bodies. */
export type UploadBody =
  | Readable
  | ReadableStream<Uint8Array>
  | Uint8Array
  | AsyncIterable<Uint8Array>;

function isWebStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === 'function'
  );
}

/** Converts any accepted body to a Node Readable without buffering it. */
export function toReadable(body: UploadBody): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array)
    return Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
  if (isWebStream(body))
    return Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    return Readable.from(body as AsyncIterable<Uint8Array>, { objectMode: false });
  }
  throw new StorageError('STORAGE_VALIDATION_FAILED', {
    message: 'The upload body must be a Readable, ReadableStream, Buffer or Uint8Array',
  });
}

export interface InspectorOptions {
  /** Hard byte limit; exceeding it fails the stream with limitError(). */
  maxBytes: number;
  limitError: () => StorageError;
  /** Bytes buffered before onHead runs. */
  sniffBytes: number;
  /** Validates the head of the content; throw to abort the upload before data moves on. */
  onHead?: (head: Buffer, truncated: boolean) => void;
}

/**
 * Pass-through transform that counts bytes, computes SHA-256, enforces a byte limit while
 * streaming and validates the first bytes before releasing them downstream.
 */
export class InspectorStream extends Transform {
  bytes = 0;
  head: Buffer = Buffer.alloc(0);
  private readonly hash: Hash = createHash('sha256');
  private readonly options: InspectorOptions;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private headChecked = false;
  private digestValue: string | undefined;

  constructor(options: InspectorOptions) {
    super();
    this.options = options;
  }

  /** Hex SHA-256 of everything that passed. Available after the stream finished. */
  digest(): string {
    if (this.digestValue === undefined) this.digestValue = this.hash.digest('hex');
    return this.digestValue;
  }

  private checkHead(truncated: boolean): void {
    const joined = Buffer.concat(this.pending, this.pendingBytes);
    this.head = joined.subarray(0, this.options.sniffBytes);
    this.headChecked = true;
    this.options.onHead?.(this.head, truncated);
    this.pending = [];
    this.pendingBytes = 0;
    if (joined.length > 0) this.push(joined);
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) {
      cb();
      return;
    }
    this.bytes += buf.length;
    if (this.bytes > this.options.maxBytes) {
      cb(this.options.limitError());
      return;
    }
    this.hash.update(buf);
    if (this.headChecked) {
      cb(null, buf);
      return;
    }
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    if (this.pendingBytes < this.options.sniffBytes) {
      cb();
      return;
    }
    try {
      this.checkHead(true);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.headChecked) this.checkHead(false);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

/**
 * Transform used for verified downloads: hashes the content and withholds the final chunk
 * until the digest matches, so a corrupted file is never delivered completely.
 */
export class VerifyingStream extends Transform {
  private readonly hash = createHash('sha256');
  private held: Buffer | undefined;
  private bytes = 0;
  private readonly expectedSha256: string;
  private readonly expectedSize: number;
  private readonly onMismatch: (actual: string, bytes: number) => void;

  constructor(
    expectedSha256: string,
    expectedSize: number,
    onMismatch: (actual: string, bytes: number) => void,
  ) {
    super();
    this.expectedSha256 = expectedSha256;
    this.expectedSize = expectedSize;
    this.onMismatch = onMismatch;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    const previous = this.held;
    this.held = chunk;
    cb(null, previous);
  }

  override _flush(cb: TransformCallback): void {
    const actual = this.hash.digest('hex');
    if (actual !== this.expectedSha256 || this.bytes !== this.expectedSize) {
      this.onMismatch(actual, this.bytes);
      cb(new StorageError('STORAGE_INTEGRITY_FAILED'));
      return;
    }
    if (this.held) this.push(this.held);
    cb();
  }
}

/** Fails with limitError once more than maxBytes pass. */
export class LimitStream extends Transform {
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly limitError: () => Error;

  constructor(maxBytes: number, limitError: () => Error) {
    super();
    this.maxBytes = maxBytes;
    this.limitError = limitError;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(this.limitError());
      return;
    }
    cb(null, chunk);
  }
}

/** Hex SHA-256 and size of a whole stream. */
export async function hashStream(
  source: Readable,
): Promise<{ sha256: string; size: number; head: Buffer }> {
  const hash = createHash('sha256');
  let size = 0;
  const headParts: Buffer[] = [];
  let headBytes = 0;
  for await (const chunk of source) {
    const buf = chunk as Buffer;
    hash.update(buf);
    size += buf.length;
    if (headBytes < SNIFF_BYTES) {
      const part = buf.subarray(0, SNIFF_BYTES - headBytes);
      headParts.push(part);
      headBytes += part.length;
    }
  }
  return { sha256: hash.digest('hex'), size, head: Buffer.concat(headParts, headBytes) };
}
