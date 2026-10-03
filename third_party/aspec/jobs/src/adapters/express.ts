import type { IncomingMessage, ServerResponse } from 'node:http';
import { type AdminOptions, createAdminCore } from '../admin.js';

export type { AdminAction, AdminAuthorize, AdminAuthorizeContext } from '../admin.js';

export type ExpressAdminOptions<Req extends IncomingMessage = IncomingMessage> = AdminOptions<Req>;

export type ExpressMiddleware<Req extends IncomingMessage = IncomingMessage> = (
  req: Req,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/**
 * Express 4 and 5 middleware for the jobs admin API. Mount it on a path:
 * `app.use('/admin/jobs', createJobsAdminMiddleware({ queue, authorize }))`.
 * Unknown routes fall through to `next()`. No body parser is required.
 */
export function createJobsAdminMiddleware<Req extends IncomingMessage = IncomingMessage>(
  options: ExpressAdminOptions<Req>,
): ExpressMiddleware<Req> {
  const core = createAdminCore<Req>(options);
  return (req, res, next) => {
    // Inside a mounted router Express rewrites req.url relative to the mount path.
    const url = new URL(req.url ?? '/', 'http://localhost');
    core
      .handle({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        request: req,
      })
      .then((result) => {
        if (!result) {
          next();
          return;
        }
        const body = JSON.stringify(result.body);
        res.statusCode = result.status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('content-length', Buffer.byteLength(body));
        res.end(body);
      })
      .catch(next);
  };
}
