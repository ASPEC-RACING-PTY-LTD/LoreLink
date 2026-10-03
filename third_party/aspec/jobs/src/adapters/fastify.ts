import { type AdminOptions, createAdminCore } from '../admin.js';

export type { AdminAction, AdminAuthorize, AdminAuthorizeContext } from '../admin.js';

/** The subset of a Fastify request used by the plugin. */
export interface FastifyRequestLike {
  method: string;
  url: string;
  params: unknown;
}

/** The subset of a Fastify reply used by the plugin. */
export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

/** The subset of a Fastify instance used by the plugin. */
export interface FastifyInstanceLike {
  route(options: {
    method: string[];
    url: string;
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>;
  }): unknown;
}

export type FastifyAdminOptions<Req extends FastifyRequestLike = FastifyRequestLike> =
  AdminOptions<Req>;

/**
 * Fastify 5 plugin for the jobs admin API. Register it with a prefix:
 * `await app.register(jobsAdminFastifyPlugin, { prefix: '/admin/jobs', queue, authorize })`.
 */
export async function jobsAdminFastifyPlugin<Req extends FastifyRequestLike = FastifyRequestLike>(
  fastify: FastifyInstanceLike,
  options: FastifyAdminOptions<Req>,
): Promise<void> {
  const core = createAdminCore<Req>(options);
  fastify.route({
    method: ['GET', 'POST'],
    url: '/*',
    handler: async (request, reply) => {
      const wildcard = (request.params as Record<string, unknown> | undefined)?.['*'];
      const rest = typeof wildcard === 'string' ? wildcard : '';
      const query = new URL(request.url, 'http://localhost').searchParams;
      // Fastify already decoded the wildcard; re-encode each segment for the core router.
      const path = `/${rest
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')}`;
      const result = await core.handle({
        method: request.method,
        path,
        query,
        request: request as Req,
      });
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-type', 'application/json; charset=utf-8');
      if (!result) {
        return reply
          .code(404)
          .send(JSON.stringify({ error: { code: 'JOBS_ROUTE_NOT_FOUND', message: 'Not found' } }));
      }
      return reply.code(result.status).send(JSON.stringify(result.body));
    },
  });
}
