import {
  bodyTooLarge,
  DEFAULT_BODY_LIMIT,
  handleNotificationsRequest,
  type NotificationsApiOptions,
  parseJsonBody,
} from '../http.js';
import type { NotificationsService } from '../service.js';

export interface FetchNotificationsOptions extends NotificationsApiOptions<Request> {
  /** Path prefix where the handler is mounted, for example "/api/notifications". Default "". */
  basePath?: string;
}

async function readLimited(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) throw bodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw bodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Web Fetch API handler, (request: Request) => Promise<Response>, for the in-app
 * notification and preferences API. Unmatched paths return 404.
 */
export function createNotificationsFetchHandler(
  service: NotificationsService,
  options: FetchNotificationsOptions,
): (request: Request) => Promise<Response> {
  const limit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  return async (request) => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base !== '') {
      if (path !== base && !path.startsWith(`${base}/`)) {
        return Response.json(
          { error: { code: 'NOTIFICATIONS_NOT_FOUND', message: 'Not found' } },
          { status: 404 },
        );
      }
      path = path.slice(base.length) || '/';
    }
    const response = await handleNotificationsRequest(service, options, request, {
      method: request.method,
      path,
      query: url.searchParams,
      readBody: async () => parseJsonBody(await readLimited(request, limit), limit),
    });
    if (response === undefined) {
      return Response.json(
        { error: { code: 'NOTIFICATIONS_NOT_FOUND', message: 'Not found' } },
        { status: 404 },
      );
    }
    const headers = { 'Cache-Control': 'no-store' };
    if (response.body === undefined)
      return new Response(null, { status: response.status, headers });
    return Response.json(response.body, { status: response.status, headers });
  };
}
