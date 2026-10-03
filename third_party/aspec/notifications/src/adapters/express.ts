import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  type ApiResponse,
  bodyTooLarge,
  DEFAULT_BODY_LIMIT,
  handleNotificationsRequest,
  type NotificationsApiOptions,
  parseJsonBody,
} from '../http.js';
import type { NotificationsService } from '../service.js';

export type ExpressNotificationsOptions = NotificationsApiOptions<Request>;

function readRawBody(req: Request, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        req.resume();
        reject(bodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: Response, response: ApiResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  if (response.body === undefined) res.status(response.status).end();
  else res.status(response.status).json(response.body);
}

/**
 * Express 4 and 5 middleware serving the in-app notification and preferences API for the
 * current user. Mount it with app.use('/api/notifications', router). Works with or without
 * express.json() in front of it.
 */
export function createNotificationsRouter(
  service: NotificationsService,
  options: ExpressNotificationsOptions,
): RequestHandler {
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  return (req: Request, res: Response, next: NextFunction) => {
    const url = new URL(req.url, 'http://localhost');
    handleNotificationsRequest(service, options, req, {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      async readBody() {
        const parsed: unknown = (req as { body?: unknown }).body;
        if (parsed !== undefined) return parsed;
        return parseJsonBody(await readRawBody(req, limit), limit);
      },
    })
      .then((response) => {
        if (response === undefined) next();
        else send(res, response);
      })
      .catch(next);
  };
}
