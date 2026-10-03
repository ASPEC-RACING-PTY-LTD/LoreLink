import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_BODY_LIMIT,
  errorResponse,
  executeRoute,
  type NotificationsApiOptions,
  notificationRoutes,
  resolveUserId,
  unauthenticated,
} from '../http.js';
import type { NotificationsService } from '../service.js';

export interface FastifyNotificationsOptions extends NotificationsApiOptions<FastifyRequest> {
  service: NotificationsService;
}

/**
 * Fastify 5 plugin serving the in-app notification and preferences API for the current user.
 * Register it with app.register(notificationsFastifyPlugin, { prefix: '/api/notifications', service, resolveUser }).
 */
export async function notificationsFastifyPlugin(
  fastify: FastifyInstance,
  options: FastifyNotificationsOptions,
): Promise<void> {
  const { service } = options;
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  for (const route of notificationRoutes) {
    fastify.route({
      method: route.method,
      url: route.path,
      bodyLimit,
      async handler(request: FastifyRequest, reply: FastifyReply) {
        let response: { status: number; body?: unknown };
        try {
          const userId = await resolveUserId(options.resolveUser, request);
          if (userId === undefined) {
            response = unauthenticated;
          } else {
            const url = new URL(request.url, 'http://localhost');
            response = await executeRoute(service, route.id, {
              userId,
              params: (request.params ?? {}) as Record<string, string>,
              query: url.searchParams,
              body: route.hasBody ? request.body : undefined,
            });
          }
        } catch (err) {
          response = errorResponse(err, options.logger);
        }
        reply.header('Cache-Control', 'no-store').code(response.status);
        return response.body === undefined ? reply.send() : reply.send(response.body);
      },
    });
  }
}
