import { type Context, Hono } from 'hono';
import {
  bodyTooLarge,
  DEFAULT_BODY_LIMIT,
  errorResponse,
  executeRoute,
  type NotificationsApiOptions,
  notificationRoutes,
  parseJsonBody,
  resolveUserId,
  unauthenticated,
} from '../http.js';
import type { NotificationsService } from '../service.js';

export type HonoNotificationsOptions = NotificationsApiOptions<Context>;

/**
 * Hono 4 sub-application serving the in-app notification and preferences API for the current
 * user. Mount it with app.route('/api/notifications', createNotificationsHono(service, options)).
 */
export function createNotificationsHono(
  service: NotificationsService,
  options: HonoNotificationsOptions,
): Hono {
  const app = new Hono();
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  for (const route of notificationRoutes) {
    app.on(route.method, route.path, async (c) => {
      let response: { status: number; body?: unknown };
      try {
        const userId = await resolveUserId(options.resolveUser, c);
        if (userId === undefined) {
          response = unauthenticated;
        } else {
          const declared = Number(c.req.header('content-length') ?? '0');
          if (route.hasBody && declared > limit) throw bodyTooLarge();
          const body = route.hasBody ? parseJsonBody(await c.req.text(), limit) : undefined;
          response = await executeRoute(service, route.id, {
            userId,
            params: c.req.param() as Record<string, string>,
            query: new URL(c.req.url).searchParams,
            body,
          });
        }
      } catch (err) {
        response = errorResponse(err, options.logger);
      }
      c.header('Cache-Control', 'no-store');
      if (response.body === undefined) return c.body(null, response.status as 204);
      return c.json(response.body as object, response.status as 200);
    });
  }
  return app;
}
