import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { configError, StorageError } from '../errors.js';
import type { HealthCheckResult } from '../ports.js';
import type {
  ByteRange,
  DriverObject,
  DriverPutOptions,
  PresignOptions,
  ResumableAppendOptions,
  ResumableAppendResult,
  ResumableDriver,
  StorageDriver,
} from '../types.js';
import { validateKey } from '../validation.js';

const MIB = 1024 * 1024;
const MIN_PART_SIZE = 5 * MIB;
const MAX_PART_SIZE = 5 * 1024 * MIB;
const MAX_PARTS = 10_000;

export interface S3DriverOptions {
  bucket: string;
  /** Existing client. When omitted one is created from endpoint, region, credentials. */
  client?: S3Client;
  /** Custom endpoint for S3-compatible services (for example http://127.0.0.1:8333). */
  endpoint?: string;
  /** Default us-east-1. */
  region?: string;
  /** Path-style addressing (bucket in the path). Default true when endpoint is set. */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Prefix prepended to every object key (for example `uploads/`). Validated like a key. */
  keyPrefix?: string;
  /** Multipart part size in bytes (5 MiB to 5 GiB, default 8 MiB). Streams up to this size use one PUT. */
  partSize?: number;
  /** Send x-amz-checksum-sha256 with PUT and UploadPart requests (default true). */
  checksums?: boolean;
}

export interface S3Driver extends StorageDriver {
  readonly client: S3Client;
  readonly bucket: string;
}

interface PartState {
  n: number;
  etag: string;
  sha?: string;
}

interface MultipartState {
  uploadId: string;
  parts: PartState[];
  tailKey?: string;
  tailSize: number;
  gen: number;
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name) : '';
}

function httpStatus(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return meta?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(err) === 404;
}

function mapError(err: unknown): unknown {
  if (err instanceof StorageError) return err;
  if (isNotFound(err)) return new StorageError('STORAGE_OBJECT_NOT_FOUND', { cause: err });
  if (errorName(err) === 'InvalidRange' || httpStatus(err) === 416) {
    return new StorageError('STORAGE_RANGE_NOT_SATISFIABLE', { cause: err });
  }
  if (errorName(err) === 'BadDigest') {
    return new StorageError('STORAGE_CHECKSUM_MISMATCH', { cause: err });
  }
  if (errorName(err) === 'AbortError') return new StorageError('STORAGE_ABORTED', { cause: err });
  return new StorageError('STORAGE_DRIVER_ERROR', { cause: err });
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Upload chunks must be bytes' });
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  const b = body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined;
  if (b && typeof b.transformToWebStream === 'function') {
    return Readable.fromWeb(
      b.transformToWebStream() as unknown as NodeWebReadableStream<Uint8Array>,
    );
  }
  throw new StorageError('STORAGE_DRIVER_ERROR', { message: 'Unexpected S3 response body' });
}

function parseState(state: Record<string, unknown>): MultipartState {
  const s = state as Partial<MultipartState>;
  if (typeof s.uploadId !== 'string' || !Array.isArray(s.parts)) {
    throw new StorageError('STORAGE_INTERNAL', { message: 'Invalid S3 upload state' });
  }
  const out: MultipartState = {
    uploadId: s.uploadId,
    parts: s.parts.map((p) => ({ ...p })),
    tailSize: typeof s.tailSize === 'number' ? s.tailSize : 0,
    gen: typeof s.gen === 'number' ? s.gen : 0,
  };
  if (typeof s.tailKey === 'string') out.tailKey = s.tailKey;
  return out;
}

function stateRecord(s: MultipartState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    uploadId: s.uploadId,
    parts: s.parts,
    tailSize: s.tailSize,
    gen: s.gen,
  };
  if (s.tailKey !== undefined) out.tailKey = s.tailKey;
  return out;
}

/**
 * Driver for Amazon S3 and S3-compatible object stores (tested with SeaweedFS). Requires the
 * optional peers @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
 */
export function createS3Driver(options: S3DriverOptions): S3Driver {
  if (!options || typeof options.bucket !== 'string' || options.bucket.length === 0) {
    configError('bucket', 'a bucket name is required');
  }
  const partSize = options.partSize ?? 8 * MIB;
  if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE || partSize > MAX_PART_SIZE) {
    configError('partSize', 'must be an integer from 5 MiB to 5 GiB');
  }
  const prefix = options.keyPrefix ?? '';
  if (prefix !== '') {
    if (!prefix.endsWith('/')) configError('keyPrefix', 'must end with /');
    try {
      validateKey(prefix.slice(0, -1));
    } catch {
      configError('keyPrefix', 'must be a valid relative key prefix');
    }
  }
  const checksums = options.checksums ?? true;
  const bucket = options.bucket;
  let client = options.client;
  if (!client) {
    const config: S3ClientConfig = {
      region: options.region ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
      // Only send checksums the driver computes itself; keeps presigned URLs and
      // S3-compatible services free of SDK default CRC32 headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    if (options.endpoint !== undefined) config.endpoint = options.endpoint;
    if (options.credentials) config.credentials = options.credentials;
    client = new S3Client(config);
  }
  const s3 = client;
  const full = (key: string) => `${prefix}${validateKey(key)}`;
  const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('base64');

  async function send<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapError(err);
    }
  }

  async function uploadPart(
    objectKey: string,
    uploadId: string,
    n: number,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<PartState> {
    if (n > MAX_PARTS) {
      throw new StorageError('STORAGE_FILE_TOO_LARGE', {
        message: 'The upload exceeds the maximum number of multipart parts',
      });
    }
    const checksum = checksums ? sha(data) : undefined;
    const res = await send(() =>
      s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploadId,
          PartNumber: n,
          Body: data,
          ContentLength: data.length,
          ...(checksum ? { ChecksumSHA256: checksum } : {}),
        }),
        signal ? { abortSignal: signal } : {},
      ),
    );
    if (!res.ETag) throw new StorageError('STORAGE_DRIVER_ERROR', { message: 'Missing part ETag' });
    const part: PartState = { n, etag: res.ETag };
    const partSha = res.ChecksumSHA256 ?? checksum;
    if (checksums && partSha) part.sha = partSha;
    return part;
  }

  async function putBuffer(
    objectKey: string,
    data: Buffer,
    contentType?: string,
    signal?: AbortSignal,
  ) {
    const checksum = checksums ? sha(data) : undefined;
    await send(() =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: data,
          ContentLength: data.length,
          ...(contentType ? { ContentType: contentType } : {}),
          ...(checksum ? { ChecksumSHA256: checksum } : {}),
        }),
        signal ? { abortSignal: signal } : {},
      ),
    );
  }

  async function createMultipart(objectKey: string, contentType: string): Promise<string> {
    const res = await send(() =>
      s3.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: contentType,
          ...(checksums ? { ChecksumAlgorithm: 'SHA256' as const } : {}),
        }),
      ),
    );
    if (!res.UploadId) {
      throw new StorageError('STORAGE_DRIVER_ERROR', { message: 'Missing multipart upload ID' });
    }
    return res.UploadId;
  }

  async function completeMultipart(objectKey: string, uploadId: string, parts: PartState[]) {
    const sorted = [...parts].sort((a, b) => a.n - b.n);
    await send(() =>
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.n,
              ETag: p.etag,
              ...(p.sha ? { ChecksumSHA256: p.sha } : {}),
            })),
          },
        }),
      ),
    );
  }

  async function abortMultipart(objectKey: string, uploadId: string) {
    try {
      await s3.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId }),
      );
    } catch (err) {
      if (errorName(err) !== 'NoSuchUpload' && !isNotFound(err)) throw mapError(err);
    }
  }

  async function readObject(objectKey: string): Promise<Buffer> {
    const res = await send(() => s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey })));
    const parts: Buffer[] = [];
    for await (const chunk of toNodeReadable(res.Body)) parts.push(asBuffer(chunk));
    return Buffer.concat(parts);
  }

  async function deleteObject(objectKey: string) {
    await send(() => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })));
  }

  const resumable: ResumableDriver = {
    async create(key, { contentType }) {
      const uploadId = await createMultipart(full(key), contentType);
      return stateRecord({ uploadId, parts: [], tailSize: 0, gen: 0 });
    },

    async append(
      key: string,
      rawState: Record<string, unknown>,
      source: Readable,
      opts: ResumableAppendOptions,
    ): Promise<ResumableAppendResult> {
      const objectKey = full(key);
      const state = parseState(rawState);
      let buffers: Buffer[] = [];
      let buffered = 0;
      if (state.tailKey) {
        const tail = await readObject(state.tailKey);
        if (tail.length !== state.tailSize) {
          source.destroy();
          throw new StorageError('STORAGE_UPLOAD_OFFSET_MISMATCH', {
            message: 'Stored upload data does not match the recorded offset',
          });
        }
        buffers.push(tail);
        buffered = tail.length;
      }
      const newParts: PartState[] = [];
      let received = 0;
      let failure: unknown;
      try {
        for await (const chunk of source) {
          if (opts.signal?.aborted) throw new StorageError('STORAGE_ABORTED');
          const buf = asBuffer(chunk);
          buffers.push(buf);
          buffered += buf.length;
          received += buf.length;
          if (buffered >= partSize) {
            const data = Buffer.concat(buffers, buffered);
            buffers = [];
            buffered = 0;
            const n = state.parts.length + newParts.length + 1;
            newParts.push(await uploadPart(objectKey, state.uploadId, n, data, opts.signal));
          }
        }
      } catch (err) {
        failure = err;
      }
      if (failure !== undefined && !(received > 0 && opts.keepPartialOnError)) {
        // Parts uploaded in this attempt are overwritten by the next attempt (same numbers).
        return { state: rawState, bytesWritten: 0, error: failure };
      }
      if (failure === undefined) await opts.beforeCommit(received);
      const gen = state.gen + 1;
      const remainder = Buffer.concat(buffers, buffered);
      let tailKey: string | undefined;
      if (remainder.length > 0) {
        tailKey = `${objectKey}.aspec-tail.${gen}`;
        await putBuffer(tailKey, remainder);
      }
      if (state.tailKey) await deleteObject(state.tailKey).catch(() => undefined);
      const next: MultipartState = {
        uploadId: state.uploadId,
        parts: [...state.parts, ...newParts],
        tailSize: remainder.length,
        gen,
      };
      if (tailKey) next.tailKey = tailKey;
      const result: ResumableAppendResult = { state: stateRecord(next), bytesWritten: received };
      if (failure !== undefined) result.error = failure;
      return result;
    },

    async complete(key, rawState) {
      const objectKey = full(key);
      const state = parseState(rawState);
      const tail = state.tailKey ? await readObject(state.tailKey) : Buffer.alloc(0);
      if (state.parts.length === 0 && tail.length === 0) {
        await abortMultipart(objectKey, state.uploadId);
        await putBuffer(objectKey, tail);
      } else {
        const parts = [...state.parts];
        if (tail.length > 0) {
          parts.push(await uploadPart(objectKey, state.uploadId, parts.length + 1, tail));
        }
        await completeMultipart(objectKey, state.uploadId, parts);
      }
      if (state.tailKey) await deleteObject(state.tailKey).catch(() => undefined);
    },

    async abort(key, rawState) {
      const state = parseState(rawState);
      await abortMultipart(full(key), state.uploadId);
      if (state.tailKey) await deleteObject(state.tailKey).catch(() => undefined);
    },
  };

  const driver: S3Driver = {
    name: 's3',
    client: s3,
    bucket,
    resumable,

    async put(key: string, body: Readable, putOptions: DriverPutOptions) {
      const objectKey = full(key);
      let buffers: Buffer[] = [];
      let buffered = 0;
      let total = 0;
      let uploadId: string | undefined;
      const parts: PartState[] = [];
      try {
        for await (const chunk of body) {
          if (putOptions.signal?.aborted) throw new StorageError('STORAGE_ABORTED');
          const buf = asBuffer(chunk);
          buffers.push(buf);
          buffered += buf.length;
          total += buf.length;
          if (buffered >= partSize) {
            if (uploadId === undefined) {
              uploadId = await createMultipart(objectKey, putOptions.contentType);
            }
            const data = Buffer.concat(buffers, buffered);
            buffers = [];
            buffered = 0;
            parts.push(
              await uploadPart(objectKey, uploadId, parts.length + 1, data, putOptions.signal),
            );
          }
        }
        const rest = Buffer.concat(buffers, buffered);
        if (uploadId === undefined) {
          await putBuffer(objectKey, rest, putOptions.contentType, putOptions.signal);
        } else {
          if (rest.length > 0) {
            parts.push(
              await uploadPart(objectKey, uploadId, parts.length + 1, rest, putOptions.signal),
            );
          }
          await completeMultipart(objectKey, uploadId, parts);
        }
        return { size: total };
      } catch (err) {
        body.destroy();
        if (uploadId !== undefined)
          await abortMultipart(objectKey, uploadId).catch(() => undefined);
        throw mapError(err);
      }
    },

    async get(key: string, getOptions?: { range?: ByteRange }): Promise<DriverObject> {
      const range = getOptions?.range;
      const res = await send(() =>
        s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: full(key),
            ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
          }),
        ),
      );
      let size = res.ContentLength ?? 0;
      const total = /\/(\d+)$/.exec(res.ContentRange ?? '');
      if (total?.[1]) size = Number(total[1]);
      return { body: toNodeReadable(res.Body), size };
    },

    async head(key: string) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: full(key) }));
        return { size: res.ContentLength ?? 0 };
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw mapError(err);
      }
    },

    async delete(key: string) {
      await deleteObject(full(key));
    },

    async move(fromKey: string, toKey: string) {
      const source = full(fromKey);
      const copySource = `${bucket}/${source.split('/').map(encodeURIComponent).join('/')}`;
      await send(() =>
        s3.send(
          new CopyObjectCommand({ Bucket: bucket, Key: full(toKey), CopySource: copySource }),
        ),
      );
      await deleteObject(source);
    },

    async presign(key: string, presignOptions: PresignOptions) {
      const objectKey = full(key);
      try {
        if (presignOptions.method === 'GET') {
          return await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: bucket,
              Key: objectKey,
              ...(presignOptions.contentDisposition
                ? { ResponseContentDisposition: presignOptions.contentDisposition }
                : {}),
              ...(presignOptions.contentType
                ? { ResponseContentType: presignOptions.contentType }
                : {}),
            }),
            { expiresIn: presignOptions.expiresInSeconds },
          );
        }
        const signable = new Set<string>();
        if (presignOptions.contentType) signable.add('content-type');
        return await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            ...(presignOptions.contentType ? { ContentType: presignOptions.contentType } : {}),
            ...(presignOptions.checksumSha256
              ? { ChecksumSHA256: presignOptions.checksumSha256 }
              : {}),
          }),
          {
            expiresIn: presignOptions.expiresInSeconds,
            signableHeaders: signable,
            unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
          },
        );
      } catch (err) {
        throw mapError(err);
      }
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const started = Date.now();
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return { ok: true, latencyMs: Date.now() - started, details: { driver: 's3', bucket } };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          details: { driver: 's3', bucket, error: errorName(err) || 'unavailable' },
        };
      }
    },
  };
  return driver;
}
