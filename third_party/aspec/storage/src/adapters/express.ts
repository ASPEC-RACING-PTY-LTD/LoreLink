import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  createStorageHttpHandler,
  type HttpActorResolver,
  type StorageHttpOptions,
} from '../http.js';
import type { Storage } from '../storage.js';

export interface ExpressStorageOptions {
  storage: Storage;
  resolveActor?: HttpActorResolver;
  publicBaseUrl?: string;
  maxFormBytes?: number;
}

function nodeToWebStream(req: IncomingMessage): ReadableStream<Uint8Array> | null {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return null;
  return Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Express 4 and 5 middleware for @aspec/storage. Mount with
 * `app.use('/files', createStorageMiddleware({ storage }))`.
 * Do not mount a body parser in front of this middleware for upload routes.
 */
export function createStorageMiddleware(options: ExpressStorageOptions) {
  const httpOpts: StorageHttpOptions = { storage: options.storage };
  if (options.resolveActor) httpOpts.resolveActor = options.resolveActor;
  if (options.publicBaseUrl) httpOpts.publicBaseUrl = options.publicBaseUrl;
  if (options.maxFormBytes !== undefined) httpOpts.maxFormBytes = options.maxFormBytes;
  const handler = createStorageHttpHandler(httpOpts);

  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, value);
    }
    handler({
      method: req.method ?? 'GET',
      path: url.pathname,
      url,
      headers,
      body: nodeToWebStream(req),
      rawRequest: req,
    })
      .then((result) => {
        res.statusCode = result.status;
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        if (result.body === null || result.body === undefined) {
          res.end();
          return;
        }
        if (typeof result.body === 'string' || result.body instanceof Uint8Array) {
          res.end(result.body);
          return;
        }
        Readable.from(result.body).pipe(res);
      })
      .catch(next);
  };
}
