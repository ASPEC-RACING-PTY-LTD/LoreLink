import type { MiddlewareHandler } from 'hono';
import { type Context, Hono } from 'hono';
import { WebhooksError } from '../errors.js';
import {
  adminRoutes,
  DEFAULT_BODY_LIMIT,
  errorResponse,
  executeAdminRoute,
  forbidden,
  parseJsonBody,
  unauthenticated,
  type WebhooksAdminOptions,
} from '../http.js';
import type { WebhooksService } from '../service.js';
import type { SeenIdStore } from '../types.js';
import { type VerifyOptions, verifyWebhookSignature } from '../verify.js';

export type HonoWebhooksAdminOptions = WebhooksAdminOptions<Context>;

export function createWebhooksAdminHono(
  service: WebhooksService,
  options: HonoWebhooksAdminOptions,
): Hono {
  const app = new Hono();
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  for (const route of adminRoutes) {
    app.on(route.method, route.path, async (c) => {
      let response: { status: number; body?: unknown };
      try {
        const subject = await options.resolveSubject(c);
        if (!subject) response = unauthenticated;
        else if (options.permissions) {
          const ok = await options.permissions.can(
            subject,
            options.permission ?? 'webhooks:admin',
            {
              type: 'webhooks',
            },
          );
          if (!ok) response = forbidden;
          else {
            const body = route.hasBody ? parseJsonBody(await c.req.text(), limit) : undefined;
            response = await executeAdminRoute(service, route.id, {
              params: c.req.param() as Record<string, string>,
              query: new URL(c.req.url).searchParams,
              body,
            });
          }
        } else {
          const body = route.hasBody ? parseJsonBody(await c.req.text(), limit) : undefined;
          response = await executeAdminRoute(service, route.id, {
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

export interface HonoVerifyOptions extends VerifyOptions {
  seenIds?: SeenIdStore;
}

export function verifyWebhookHono(options: HonoVerifyOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    try {
      const verified = verifyWebhookSignature(raw, c.req.raw.headers, options);
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
      c.set('webhook', verified);
      c.set('rawBody', raw);
      await next();
    } catch (err) {
      if (err instanceof WebhooksError && err.expose) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 401);
      }
      throw err;
    }
  };
}
