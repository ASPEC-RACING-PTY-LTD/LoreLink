import type { AdminOptions } from '../admin.js';
import { invalidOption } from '../errors.js';
import { createJobsAdminFetchHandler } from './fetch.js';

export type { AdminAction, AdminAuthorize, AdminAuthorizeContext } from '../admin.js';

/** The subset of a Hono context used by the handler. */
export interface HonoContextLike {
  req: { raw: Request };
}

export interface HonoAdminOptions<C extends HonoContextLike = HonoContextLike>
  extends AdminOptions<C> {
  /** The path the handler is mounted under, for example `/admin/jobs`. */
  basePath: string;
}

/**
 * Hono 4 handler for the jobs admin API:
 * `app.all('/admin/jobs/*', createJobsAdminHonoHandler({ basePath: '/admin/jobs', queue, authorize }))`.
 * The authorisation hook receives the Hono context.
 */
export function createJobsAdminHonoHandler<C extends HonoContextLike = HonoContextLike>(
  options: HonoAdminOptions<C>,
): (c: C) => Promise<Response> {
  if (!options || typeof options.authorize !== 'function') {
    throw invalidOption('authorize', 'is required; the admin API has no default access policy');
  }
  const contexts = new WeakMap<Request, C>();
  const { authorize, basePath, ...rest } = options;
  const handler = createJobsAdminFetchHandler({
    ...rest,
    basePath,
    authorize: (ctx) => {
      const c = contexts.get(ctx.request);
      if (!c) return false;
      const out: Parameters<typeof authorize>[0] = { action: ctx.action, request: c };
      if (ctx.jobId !== undefined) out.jobId = ctx.jobId;
      return authorize(out);
    },
  });
  return (c) => {
    contexts.set(c.req.raw, c);
    return handler(c.req.raw);
  };
}
