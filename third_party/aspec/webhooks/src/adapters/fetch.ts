import { WebhooksError } from '../errors.js';
import {
  DEFAULT_BODY_LIMIT,
  handleAdminRequest,
  parseJsonBody,
  type WebhooksAdminOptions,
} from '../http.js';
import type { WebhooksService } from '../service.js';
import type { SeenIdStore } from '../types.js';
import { type VerifyOptions, verifyWebhookSignature } from '../verify.js';

export interface FetchWebhooksAdminOptions extends WebhooksAdminOptions<Request> {
  basePath?: string;
}

export function createWebhooksAdminFetchHandler(
  service: WebhooksService,
  options: FetchWebhooksAdminOptions,
): (request: Request) => Promise<Response> {
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  return async (request) => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base !== '') {
      if (path !== base && !path.startsWith(`${base}/`)) {
        return Response.json(
          { error: { code: 'WEBHOOKS_NOT_FOUND', message: 'Not found' } },
          { status: 404 },
        );
      }
      path = path.slice(base.length) || '/';
    }
    const response = await handleAdminRequest(service, options, request, {
      method: request.method,
      path,
      query: url.searchParams,
      readBody: async () => parseJsonBody(await request.text(), limit),
    });
    if (!response) {
      return Response.json(
        { error: { code: 'WEBHOOKS_NOT_FOUND', message: 'Not found' } },
        { status: 404 },
      );
    }
    const headers = { 'Cache-Control': 'no-store' };
    if (response.body === undefined)
      return new Response(null, { status: response.status, headers });
    return Response.json(response.body, { status: response.status, headers });
  };
}

export interface FetchVerifyOptions extends VerifyOptions {
  seenIds?: SeenIdStore;
}

export async function verifyFetchWebhook(
  request: Request,
  options: FetchVerifyOptions,
): Promise<{ verified: ReturnType<typeof verifyWebhookSignature>; rawBody: Buffer }> {
  const raw = Buffer.from(await request.arrayBuffer());
  const verified = verifyWebhookSignature(raw, request.headers, options);
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
  return { verified, rawBody: raw };
}
