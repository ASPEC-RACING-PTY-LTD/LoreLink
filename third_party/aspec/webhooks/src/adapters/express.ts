import type { Request, RequestHandler, Response } from 'express';
import { WebhooksError } from '../errors.js';
import {
  type ApiResponse,
  DEFAULT_BODY_LIMIT,
  handleAdminRequest,
  parseJsonBody,
  type WebhooksAdminOptions,
} from '../http.js';
import type { WebhooksService } from '../service.js';
import type { SeenIdStore } from '../types.js';
import { type VerifyOptions, verifyWebhookSignature } from '../verify.js';

export type ExpressWebhooksAdminOptions = WebhooksAdminOptions<Request>;

function readRawBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer((req as { rawBody?: Buffer }).rawBody)) {
      resolve((req as { rawBody: Buffer }).rawBody);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          new WebhooksError('WEBHOOKS_PAYLOAD_TOO_LARGE', 'Request body too large', {
            status: 413,
            expose: true,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Express middleware that captures the raw body for signature verification even when
 * express.json() has already parsed the request. Attach before or instead of json parser
 * on webhook routes: app.use('/webhooks', preserveRawBody(), express.json(), ...).
 */
export function preserveRawBody(limit = DEFAULT_BODY_LIMIT): RequestHandler {
  return (req, _res, next) => {
    if (Buffer.isBuffer((req as { rawBody?: Buffer }).rawBody)) {
      next();
      return;
    }
    readRawBody(req, limit)
      .then((buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
        if ((req as { body?: unknown }).body === undefined && buf.length > 0) {
          try {
            (req as { body?: unknown }).body = JSON.parse(buf.toString('utf8'));
          } catch {
            /* leave unparsed */
          }
        }
        next();
      })
      .catch(next);
  };
}

export function createWebhooksAdminRouter(
  service: WebhooksService,
  options: ExpressWebhooksAdminOptions,
): RequestHandler {
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  return (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    handleAdminRequest(service, options, req, {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      async readBody() {
        if ((req as { body?: unknown }).body !== undefined) return (req as { body: unknown }).body;
        return parseJsonBody((await readRawBody(req, limit)).toString('utf8'), limit);
      },
    })
      .then((response) => {
        if (!response) next();
        else send(res, response);
      })
      .catch(next);
  };
}

function send(res: Response, response: ApiResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  if (response.body === undefined) res.status(response.status).end();
  else res.status(response.status).json(response.body);
}

export interface ExpressVerifyOptions extends VerifyOptions {
  seenIds?: SeenIdStore;
  getRawBody?: (req: Request) => Buffer | Promise<Buffer>;
}

/** Verifying middleware for incoming webhooks. Sets req.webhook on success. */
export function verifyWebhookMiddleware(options: ExpressVerifyOptions): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const raw =
        (await options.getRawBody?.(req)) ??
        (req as { rawBody?: Buffer }).rawBody ??
        (await readRawBody(req, DEFAULT_BODY_LIMIT));
      const verified = verifyWebhookSignature(raw, req.headers, options);
      if (options.seenIds && verified.id) {
        const replay = await options.seenIds.checkAndStore(
          verified.id,
          Date.now() + (options.toleranceSeconds ?? 300) * 1000 * 2,
        );
        if (replay) {
          throw new WebhooksError('WEBHOOKS_REPLAY', 'Webhook id already processed', {
            status: 409,
            expose: true,
          });
        }
      }
      (req as { webhook?: unknown }).webhook = verified;
      (req as { rawBody?: Buffer }).rawBody = raw;
      next();
    })().catch((err) => {
      if (err instanceof WebhooksError && err.expose) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
      } else next(err);
    });
  };
}

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      webhook?: { id?: string; timestamp?: number; scheme: string };
    }
  }
}
