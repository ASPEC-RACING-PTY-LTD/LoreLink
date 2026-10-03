import { Readable } from 'node:stream';
import {
  createStorageHttpHandler,
  type HttpActorResolver,
  type StorageHttpOptions,
} from '../http.js';
import type { Storage } from '../storage.js';

export interface FastifyStorageOptions {
  storage: Storage;
  resolveActor?: HttpActorResolver;
  publicBaseUrl?: string;
  maxFormBytes?: number;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  raw: { host?: string } & NodeJS.ReadableStream;
  body?: unknown;
}

interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

interface FastifyInstanceLike {
  all(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown> | unknown,
  ): unknown;
  addContentTypeParser(
    contentType: string | string[],
    opts: { parseAs: 'buffer' } | { parseAs: 'string' },
    parser: (req: unknown, body: unknown, done: (err: null, body: unknown) => void) => void,
  ): unknown;
}

/** Fastify 5 plugin for @aspec/storage. Register with a prefix such as `/files`. */
export async function storageFastifyPlugin(
  app: FastifyInstanceLike,
  options: FastifyStorageOptions,
): Promise<void> {
  const httpOpts: StorageHttpOptions = { storage: options.storage };
  if (options.resolveActor) httpOpts.resolveActor = options.resolveActor;
  if (options.publicBaseUrl) httpOpts.publicBaseUrl = options.publicBaseUrl;
  if (options.maxFormBytes !== undefined) httpOpts.maxFormBytes = options.maxFormBytes;
  const handler = createStorageHttpHandler(httpOpts);

  // Preserve raw bodies for uploads; JSON metadata routes still work with buffers.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const routeHandler = async (request: FastifyRequestLike, reply: FastifyReplyLike) => {
    const host =
      (typeof request.headers.host === 'string' ? request.headers.host : undefined) ?? 'localhost';
    // Fastify strips the plugin prefix from request.url.
    const url = new URL(
      request.url.startsWith('http') ? request.url : `http://${host}${request.url}`,
    );
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, value);
    }
    let body: ReadableStream<Uint8Array> | null = null;
    if (request.body instanceof Uint8Array) {
      body = Readable.toWeb(Readable.from([request.body])) as unknown as ReadableStream<Uint8Array>;
    } else if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.method !== 'DELETE'
    ) {
      body = Readable.toWeb(
        Readable.from(request.raw as NodeJS.ReadableStream),
      ) as unknown as ReadableStream<Uint8Array>;
    }
    const result = await handler({
      method: request.method,
      path: url.pathname || '/',
      url,
      headers,
      body,
      rawRequest: request,
    });
    reply.status(result.status);
    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    return reply.send(result.body ?? '');
  };

  app.all('/', routeHandler);
  app.all('/*', routeHandler);
}
