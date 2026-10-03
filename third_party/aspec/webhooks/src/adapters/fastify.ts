import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebhooksError } from '../errors.js';
import {
  adminRoutes,
  DEFAULT_BODY_LIMIT,
  errorResponse,
  executeAdminRoute,
  forbidden,
  unauthenticated,
  type WebhooksAdminOptions,
} from '../http.js';
import type { WebhooksService } from '../service.js';
import type { SeenIdStore } from '../types.js';
import { type VerifyOptions, verifyWebhookSignature } from '../verify.js';

export interface FastifyWebhooksAdminOptions extends WebhooksAdminOptions<FastifyRequest> {
  service: WebhooksService;
}

export async function webhooksAdminFastifyPlugin(
  fastify: FastifyInstance,
  options: FastifyWebhooksAdminOptions,
): Promise<void> {
  const { service } = options;
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  for (const route of adminRoutes) {
    fastify.route({
      method: route.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: route.path,
      bodyLimit,
      async handler(request, reply) {
        let response: { status: number; body?: unknown };
        try {
          const subject = await options.resolveSubject(request);
          if (!subject) response = unauthenticated;
          else if (options.permissions) {
            const ok = await options.permissions.can(
              subject,
              options.permission ?? 'webhooks:admin',
              {
                type: 'webhooks',
              },
            );
            response = ok
              ? await executeAdminRoute(service, route.id, {
                  params: (request.params ?? {}) as Record<string, string>,
                  query: new URL(request.url, 'http://localhost').searchParams,
                  body: route.hasBody ? request.body : undefined,
                })
              : forbidden;
          } else {
            response = await executeAdminRoute(service, route.id, {
              params: (request.params ?? {}) as Record<string, string>,
              query: new URL(request.url, 'http://localhost').searchParams,
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

/** Registers a content-type parser that preserves the raw Buffer on request.rawBody. */
export function registerRawBodyParser(fastify: FastifyInstance, limit = DEFAULT_BODY_LIMIT): void {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: limit },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        const json =
          (body as Buffer).length === 0 ? undefined : JSON.parse((body as Buffer).toString('utf8'));
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}

export interface FastifyVerifyOptions extends VerifyOptions {
  seenIds?: SeenIdStore;
}

export async function verifyWebhookFastifyHook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: FastifyVerifyOptions,
): Promise<void> {
  const raw =
    (request as { rawBody?: Buffer }).rawBody ??
    Buffer.from(
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}),
      'utf8',
    );
  try {
    const verified = verifyWebhookSignature(
      raw,
      request.headers as Record<string, string | string[] | undefined>,
      options,
    );
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
    (request as { webhook?: unknown }).webhook = verified;
  } catch (err) {
    if (err instanceof WebhooksError && err.expose) {
      await reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
}
