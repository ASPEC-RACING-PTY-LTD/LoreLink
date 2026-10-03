import { Readable } from 'node:stream';
import {
  createStorageHttpHandler,
  type HttpActorResolver,
  type StorageHttpOptions,
} from '../http.js';
import type { Storage } from '../storage.js';

export interface HonoContextLike {
  req: {
    method: string;
    url: string;
    raw: Request;
  };
  newResponse(
    body: string | Uint8Array | ReadableStream<Uint8Array> | null,
    init?: { status?: number; headers?: Record<string, string> },
  ): Response;
}

export interface HonoStorageOptions {
  storage: Storage;
  resolveActor?: HttpActorResolver;
  publicBaseUrl?: string;
  maxFormBytes?: number;
  basePath?: string;
}

function normaliseBase(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Hono 4 handler for @aspec/storage. */
export function createStorageHonoHandler(options: HonoStorageOptions) {
  const base = normaliseBase(options.basePath);
  const httpOpts: StorageHttpOptions = { storage: options.storage };
  if (options.resolveActor) httpOpts.resolveActor = options.resolveActor;
  if (options.publicBaseUrl) httpOpts.publicBaseUrl = options.publicBaseUrl;
  if (options.maxFormBytes !== undefined) httpOpts.maxFormBytes = options.maxFormBytes;
  const handler = createStorageHttpHandler(httpOpts);

  return async (c: HonoContextLike): Promise<Response> => {
    const url = new URL(c.req.url);
    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) {
        return c.newResponse(
          JSON.stringify({ error: { code: 'STORAGE_FILE_NOT_FOUND', message: 'Not found' } }),
          { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
      }
      path = path.slice(base.length) || '/';
    }
    const result = await handler({
      method: c.req.method,
      path,
      url,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      rawRequest: c,
    });
    let body: string | Uint8Array | ReadableStream<Uint8Array> | null = null;
    if (typeof result.body === 'string' || result.body instanceof Uint8Array) body = result.body;
    else if (result.body)
      body = Readable.toWeb(result.body) as unknown as ReadableStream<Uint8Array>;
    return c.newResponse(body, { status: result.status, headers: result.headers });
  };
}
