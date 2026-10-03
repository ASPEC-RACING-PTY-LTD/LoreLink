import type { Readable } from 'node:stream';
import { isStorageError, StorageError } from './errors.js';
import type { Subject } from './ports.js';
import type { ContentDispositionType } from './signing.js';
import type { Storage } from './storage.js';
import type { FileRecord } from './types.js';

export const TUS_VERSION = '1.0.0';

export type HttpActorResolver = (
  request: StorageHttpRequest,
) => Subject | undefined | Promise<Subject | undefined>;

export interface StorageHttpRequest {
  method: string;
  /** Path relative to the mount point (leading slash). */
  path: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  rawRequest: unknown;
}

export interface StorageHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | Uint8Array | Readable | null;
}

export interface StorageHttpOptions {
  storage: Storage;
  /** Resolves the caller for authorisation. */
  resolveActor?: HttpActorResolver;
  /** Base URL used when minting adapter signed URLs (for example https://app.example/api/files). */
  publicBaseUrl?: string;
  /** Maximum multipart field size for form uploads. Default 25 MiB. */
  maxFormBytes?: number;
}

function errorResponse(err: unknown): StorageHttpResponse {
  if (isStorageError(err)) {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (err.code === 'STORAGE_METHOD_NOT_ALLOWED')
      headers.allow = 'GET, HEAD, POST, PUT, PATCH, DELETE';
    if (err.code === 'STORAGE_TUS_VERSION_UNSUPPORTED') {
      headers['tus-resumable'] = TUS_VERSION;
      headers['tus-version'] = TUS_VERSION;
    }
    return {
      status: err.status,
      headers,
      body: JSON.stringify({
        error: { code: err.code, message: err.expose ? err.message : 'Request failed' },
      }),
    };
  }
  return {
    status: 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      error: { code: 'STORAGE_INTERNAL', message: 'Internal storage error' },
    }),
  };
}

function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): StorageHttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

function fileJson(file: FileRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: file.id,
    key: file.key,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    visibility: file.visibility,
    metadata: file.metadata,
    status: file.status,
    createdAt: new Date(file.createdAt).toISOString(),
    updatedAt: new Date(file.updatedAt).toISOString(),
  };
  if (file.sha256) out.sha256 = file.sha256;
  if (file.ownerId) out.ownerId = file.ownerId;
  if (file.tenantId) out.tenantId = file.tenantId;
  if (file.declaredType) out.declaredType = file.declaredType;
  if (file.detectedType) out.detectedType = file.detectedType;
  return out;
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v === null || v === '' ? undefined : v;
}

function requireTus(headers: Headers): void {
  const v = header(headers, 'tus-resumable');
  if (v !== TUS_VERSION) throw new StorageError('STORAGE_TUS_VERSION_UNSUPPORTED');
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) throw new StorageError('STORAGE_FILE_TOO_LARGE');
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Framework-agnostic HTTP router for uploads, downloads, metadata, signed URLs and tus 1.0
 * resumable uploads (`POST /uploads`, `HEAD/PATCH /uploads/:id`).
 */
export function createStorageHttpHandler(options: StorageHttpOptions) {
  const { storage } = options;
  const maxFormBytes = options.maxFormBytes ?? 25 * 1024 * 1024;
  const resolveActor = options.resolveActor ?? (() => undefined);

  return async (request: StorageHttpRequest): Promise<StorageHttpResponse> => {
    try {
      const actor = await resolveActor(request);
      const method = request.method.toUpperCase();
      const path =
        request.path === ''
          ? '/'
          : request.path.startsWith('/')
            ? request.path
            : `/${request.path}`;
      const segments = path.split('/').filter(Boolean);

      if (method === 'OPTIONS' && segments[0] === 'uploads') {
        return {
          status: 204,
          headers: {
            'tus-resumable': TUS_VERSION,
            'tus-version': TUS_VERSION,
            'tus-extension': 'creation,termination,checksum',
            'tus-max-size': String(maxFormBytes),
          },
        };
      }

      // tus: POST /uploads
      if (method === 'POST' && segments.length === 1 && segments[0] === 'uploads') {
        requireTus(request.headers);
        const lengthRaw = header(request.headers, 'upload-length');
        if (lengthRaw === undefined || !/^\d+$/.test(lengthRaw)) {
          throw new StorageError('STORAGE_VALIDATION_FAILED', {
            message: 'Upload-Length is required',
          });
        }
        const uploadLength = Number(lengthRaw);
        const metadataHeader = header(request.headers, 'upload-metadata');
        let filename: string | undefined;
        let contentType: string | undefined;
        if (metadataHeader) {
          for (const part of metadataHeader.split(',')) {
            const [key, b64] = part.trim().split(' ');
            if (!key || !b64) continue;
            const value = Buffer.from(b64, 'base64').toString('utf8');
            if (key === 'filename') filename = value;
            if (key === 'contentType' || key === 'filetype') contentType = value;
          }
        }
        const sessionInput: Parameters<Storage['createUploadSession']>[0] = { uploadLength };
        if (filename !== undefined) sessionInput.filename = filename;
        if (contentType !== undefined) sessionInput.contentType = contentType;
        if (actor !== undefined) sessionInput.actor = actor;
        const created = await storage.createUploadSession(sessionInput);
        const location = `${options.publicBaseUrl?.replace(/\/$/, '') ?? ''}/uploads/${created.session.id}`;
        return {
          status: 201,
          headers: {
            'tus-resumable': TUS_VERSION,
            location,
            'upload-offset': '0',
            'upload-expires': created.session.expiresAt.toISOString(),
          },
        };
      }

      // tus: HEAD /uploads/:id
      if (method === 'HEAD' && segments.length === 2 && segments[0] === 'uploads') {
        requireTus(request.headers);
        const info = await storage.getUploadOffset(segments[1] ?? '', actor);
        return {
          status: 200,
          headers: {
            'tus-resumable': TUS_VERSION,
            'upload-offset': String(info.uploadOffset),
            'upload-length': String(info.uploadLength),
            'upload-expires': info.expiresAt.toISOString(),
            'cache-control': 'no-store',
          },
        };
      }

      // tus: PATCH /uploads/:id
      if (method === 'PATCH' && segments.length === 2 && segments[0] === 'uploads') {
        requireTus(request.headers);
        const offsetRaw = header(request.headers, 'upload-offset');
        if (offsetRaw === undefined || !/^\d+$/.test(offsetRaw)) {
          throw new StorageError('STORAGE_VALIDATION_FAILED', {
            message: 'Upload-Offset is required',
          });
        }
        const ct = header(request.headers, 'content-type');
        if (ct !== 'application/offset+octet-stream') {
          throw new StorageError('STORAGE_UNSUPPORTED_MEDIA_TYPE', {
            message: 'Content-Type must be application/offset+octet-stream',
          });
        }
        if (!request.body)
          throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Empty body' });
        const appendInput: Parameters<Storage['appendUpload']>[0] = {
          uploadId: segments[1] ?? '',
          body: request.body,
          offset: Number(offsetRaw),
        };
        if (actor !== undefined) appendInput.actor = actor;
        const result = await storage.appendUpload(appendInput);
        const session = await storage.getUploadOffset(segments[1] ?? '', actor);
        if (result.uploadOffset === session.uploadLength) {
          await storage.completeUpload(segments[1] ?? '', actor);
        }
        return {
          status: 204,
          headers: {
            'tus-resumable': TUS_VERSION,
            'upload-offset': String(result.uploadOffset),
          },
        };
      }

      // tus: DELETE /uploads/:id
      if (method === 'DELETE' && segments.length === 2 && segments[0] === 'uploads') {
        requireTus(request.headers);
        await storage.abortUpload(segments[1] ?? '', actor);
        return { status: 204, headers: { 'tus-resumable': TUS_VERSION } };
      }

      // POST / (multipart or raw upload)
      if (method === 'POST' && (path === '/' || path === '')) {
        const ct = header(request.headers, 'content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
          if (!request.body) {
            throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Empty body' });
          }
          const req = new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: request.body,
            duplex: 'half',
          } as RequestInit);
          const form = await req.formData();
          const file = form.get('file');
          if (!(file instanceof File)) {
            throw new StorageError('STORAGE_VALIDATION_FAILED', {
              message: 'multipart field "file" is required',
            });
          }
          if (file.size > maxFormBytes) throw new StorageError('STORAGE_FILE_TOO_LARGE');
          const buf = new Uint8Array(await file.arrayBuffer());
          const ownerId = form.get('ownerId');
          const tenantId = form.get('tenantId');
          const uploadInput: Parameters<Storage['upload']>[0] = {
            body: buf,
            filename: file.name,
            expectedSize: buf.byteLength,
          };
          if (file.type) uploadInput.contentType = file.type;
          if (typeof ownerId === 'string') uploadInput.ownerId = ownerId;
          if (typeof tenantId === 'string') uploadInput.tenantId = tenantId;
          if (actor !== undefined) uploadInput.actor = actor;
          const uploaded = await storage.upload(uploadInput);
          return json(201, fileJson(uploaded));
        }
        const filename = header(request.headers, 'x-file-name') ?? 'file';
        const contentType = header(request.headers, 'content-type');
        if (!request.body) {
          throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Empty body' });
        }
        const rawUpload: Parameters<Storage['upload']>[0] = {
          body: request.body,
          filename: decodeURIComponent(filename),
        };
        if (contentType !== undefined) rawUpload.contentType = contentType;
        if (actor !== undefined) rawUpload.actor = actor;
        const uploaded = await storage.upload(rawUpload);
        return json(201, fileJson(uploaded));
      }

      // GET|HEAD|DELETE /:id and GET /:id/signed
      if (segments.length >= 1) {
        const fileId = segments[0] ?? '';
        if (segments.length === 2 && segments[1] === 'signed' && method === 'POST') {
          if (!options.publicBaseUrl) {
            throw new StorageError('STORAGE_CONFIG_INVALID', {
              message: 'publicBaseUrl is required to mint signed URLs',
            });
          }
          const body = JSON.parse(
            new TextDecoder().decode(await readBody(request.body, 64 * 1024)),
          ) as { expiresInSeconds?: number; disposition?: ContentDispositionType };
          const signedOpts: Parameters<Storage['createSignedUrl']>[0] = {
            fileId,
            baseUrl: options.publicBaseUrl,
          };
          if (body.expiresInSeconds !== undefined)
            signedOpts.expiresInSeconds = body.expiresInSeconds;
          if (body.disposition !== undefined) signedOpts.disposition = body.disposition;
          if (actor !== undefined) signedOpts.actor = actor;
          const signed = await storage.createSignedUrl(signedOpts);
          return json(200, {
            url: signed.url,
            expiresAt: signed.expiresAt.toISOString(),
          });
        }

        if (segments.length === 1) {
          if (method === 'DELETE') {
            await storage.delete(fileId, actor);
            return { status: 204, headers: { 'cache-control': 'no-store' } };
          }
          if (method === 'GET' && request.url.searchParams.get('meta') === '1') {
            const file = await storage.get(fileId, actor);
            return json(200, fileJson(file));
          }
          if (method === 'GET' || method === 'HEAD') {
            const hasSig = request.url.searchParams.has('signature');
            let disposition: ContentDispositionType | undefined;
            if (hasSig) {
              const verified = await storage.verifySignedUrl({
                method: 'GET',
                fileId,
                query: request.url.searchParams,
              });
              disposition = verified.disposition;
            }
            const range = header(request.headers, 'range');
            const downloadOpts: Parameters<Storage['download']>[0] = {
              fileId,
              bypassAuthorize: hasSig,
            };
            if (range !== undefined) downloadOpts.range = range;
            if (disposition !== undefined) downloadOpts.disposition = disposition;
            if (actor !== undefined) downloadOpts.actor = actor;
            const downloaded = await storage.download(downloadOpts);
            const headers: Record<string, string> = {
              'content-type': downloaded.contentType,
              'content-disposition': downloaded.contentDisposition,
              'accept-ranges': 'bytes',
              'cache-control': 'private, max-age=0',
              'x-content-type-options': 'nosniff',
            };
            if (downloaded.file.sha256) {
              headers['x-content-digest'] = `sha-256=:${downloaded.file.sha256}:`;
            }
            if (downloaded.range) {
              headers['content-range'] =
                `bytes ${downloaded.range.start}-${downloaded.range.end}/${downloaded.file.size}`;
              headers['content-length'] = String(downloaded.contentLength);
              return {
                status: 206,
                headers,
                body: method === 'HEAD' ? null : (downloaded.body as Readable),
              };
            }
            headers['content-length'] = String(downloaded.contentLength);
            return {
              status: 200,
              headers,
              body: method === 'HEAD' ? null : (downloaded.body as Readable),
            };
          }
        }
      }

      throw new StorageError('STORAGE_FILE_NOT_FOUND', { message: 'Not found' });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
