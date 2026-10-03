import { Readable } from 'node:stream';
import {
  createStorageHttpHandler,
  type HttpActorResolver,
  type StorageHttpOptions,
} from '../http.js';
import type { Storage } from '../storage.js';

export interface FetchStorageOptions {
  storage: Storage;
  resolveActor?: HttpActorResolver;
  publicBaseUrl?: string;
  maxFormBytes?: number;
  /** Path prefix to strip, for example `/files`. */
  basePath?: string;
}

function normaliseBase(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

/**
 * Views bytes as a Fetch body without copying. Recent TypeScript libraries only accept
 * ArrayBuffer-backed views, so views over a SharedArrayBuffer are copied.
 */
function bytesBody(bytes: Uint8Array): ResponseBody {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

async function toWebBody(
  body: string | Uint8Array | Readable | null | undefined,
): Promise<ResponseBody> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return bytesBody(body);
  return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
}

/** Web Fetch API handler for @aspec/storage. */
export function createStorageFetchHandler(options: FetchStorageOptions) {
  const base = normaliseBase(options.basePath);
  const httpOpts: StorageHttpOptions = { storage: options.storage };
  if (options.resolveActor) httpOpts.resolveActor = options.resolveActor;
  if (options.publicBaseUrl) httpOpts.publicBaseUrl = options.publicBaseUrl;
  if (options.maxFormBytes !== undefined) httpOpts.maxFormBytes = options.maxFormBytes;
  const handler = createStorageHttpHandler(httpOpts);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) {
        return new Response(
          JSON.stringify({ error: { code: 'STORAGE_FILE_NOT_FOUND', message: 'Not found' } }),
          {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
      path = path.slice(base.length) || '/';
    }
    const result = await handler({
      method: request.method,
      path,
      url,
      headers: request.headers,
      body: request.body,
      rawRequest: request,
    });
    return new Response(await toWebBody(result.body), {
      status: result.status,
      headers: result.headers,
    });
  };
}
