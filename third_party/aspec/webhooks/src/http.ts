import { isWebhooksError, WebhooksError } from './errors.js';
import type { LoggerLike, PermissionChecker, Subject } from './ports.js';
import type { WebhooksService } from './service.js';
import type { CreateSubscriptionInput, UpdateSubscriptionInput } from './types.js';

export type ResolveSubject<Req> = (
  req: Req,
) => Promise<Subject | null | undefined> | Subject | null | undefined;

export interface WebhooksAdminOptions<Req> {
  resolveSubject: ResolveSubject<Req>;
  /** When set, requires permission "webhooks:admin" (or the given permission). */
  permissions?: PermissionChecker;
  permission?: string;
  bodyLimitBytes?: number;
  logger?: LoggerLike;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

export type AdminRouteId =
  | 'list'
  | 'create'
  | 'get'
  | 'update'
  | 'delete'
  | 'rotate'
  | 'enable'
  | 'disable'
  | 'ping'
  | 'listDeliveries'
  | 'getDelivery'
  | 'redeliver'
  | 'redeliverFailed';

export const adminRoutes: readonly {
  id: AdminRouteId;
  method: string;
  path: string;
  hasBody: boolean;
}[] = [
  { id: 'list', method: 'GET', path: '/subscriptions', hasBody: false },
  { id: 'create', method: 'POST', path: '/subscriptions', hasBody: true },
  { id: 'get', method: 'GET', path: '/subscriptions/:id', hasBody: false },
  { id: 'update', method: 'PATCH', path: '/subscriptions/:id', hasBody: true },
  { id: 'delete', method: 'DELETE', path: '/subscriptions/:id', hasBody: false },
  { id: 'rotate', method: 'POST', path: '/subscriptions/:id/rotate', hasBody: true },
  { id: 'enable', method: 'POST', path: '/subscriptions/:id/enable', hasBody: false },
  { id: 'disable', method: 'POST', path: '/subscriptions/:id/disable', hasBody: true },
  { id: 'ping', method: 'POST', path: '/subscriptions/:id/ping', hasBody: false },
  { id: 'listDeliveries', method: 'GET', path: '/subscriptions/:id/deliveries', hasBody: false },
  { id: 'getDelivery', method: 'GET', path: '/deliveries/:id', hasBody: false },
  { id: 'redeliver', method: 'POST', path: '/deliveries/:id/redeliver', hasBody: false },
  {
    id: 'redeliverFailed',
    method: 'POST',
    path: '/subscriptions/:id/redeliver-failed',
    hasBody: true,
  },
];

export function matchAdminRoute(
  method: string,
  path: string,
): { route: (typeof adminRoutes)[number]; params: Record<string, string> } | undefined {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path || '/';
  const parts = normalized.split('/').filter(Boolean);
  for (const route of adminRoutes) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const seg = pattern[i] as string;
      const actual = parts[i] as string;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual);
      else if (seg !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

export async function executeAdminRoute(
  service: WebhooksService,
  route: AdminRouteId,
  input: { params: Record<string, string>; query: URLSearchParams; body: unknown },
): Promise<ApiResponse> {
  const id = input.params.id ?? '';
  switch (route) {
    case 'list':
      return {
        status: 200,
        body: await service.listSubscriptions({
          ...(input.query.get('tenantId') ? { tenantId: input.query.get('tenantId')! } : {}),
          limit: Number(input.query.get('limit') ?? 50),
        }),
      };
    case 'create': {
      const created = await service.createSubscription(input.body as CreateSubscriptionInput);
      return { status: 201, body: created };
    }
    case 'get':
      return { status: 200, body: await service.getSubscription(id) };
    case 'update':
      return {
        status: 200,
        body: await service.updateSubscription(id, input.body as UpdateSubscriptionInput),
      };
    case 'delete':
      await service.deleteSubscription(id);
      return { status: 204 };
    case 'rotate': {
      const body = (input.body ?? {}) as { expiresInMs?: number };
      return { status: 200, body: await service.rotateSecret(id, body) };
    }
    case 'enable':
      return { status: 200, body: await service.enableSubscription(id) };
    case 'disable': {
      const reason = (input.body as { reason?: string } | null)?.reason;
      return { status: 200, body: await service.disableSubscription(id, reason) };
    }
    case 'ping':
      return { status: 200, body: await service.ping(id) };
    case 'listDeliveries':
      return {
        status: 200,
        body: await service.listDeliveries({
          subscriptionId: id,
          limit: Number(input.query.get('limit') ?? 50),
        }),
      };
    case 'getDelivery':
      return { status: 200, body: await service.getDelivery(id) };
    case 'redeliver':
      return { status: 200, body: await service.redeliver(id) };
    case 'redeliverFailed': {
      const since = Number((input.body as { since?: number } | null)?.since ?? 0);
      return { status: 200, body: { count: await service.redeliverFailed(id, since) } };
    }
  }
}

export function errorResponse(err: unknown, logger?: LoggerLike): ApiResponse {
  if (isWebhooksError(err) && err.expose && err.status < 500) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  logger?.error(
    { err: err instanceof Error ? err.message : String(err) },
    'webhooks: request failed',
  );
  const status = isWebhooksError(err) ? err.status : 500;
  return {
    status: status >= 400 ? status : 500,
    body: { error: { code: 'WEBHOOKS_INTERNAL', message: 'Internal error' } },
  };
}

export const unauthenticated: ApiResponse = {
  status: 401,
  body: { error: { code: 'WEBHOOKS_UNAUTHENTICATED', message: 'Authentication required' } },
};

export const forbidden: ApiResponse = {
  status: 403,
  body: { error: { code: 'WEBHOOKS_FORBIDDEN', message: 'Forbidden' } },
};

export const DEFAULT_BODY_LIMIT = 65_536;

export function parseJsonBody(text: string, limit: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new WebhooksError('WEBHOOKS_PAYLOAD_TOO_LARGE', 'Request body too large', {
      status: 413,
      expose: true,
    });
  }
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebhooksError('WEBHOOKS_INVALID_INPUT', 'Request body must be valid JSON', {
      status: 400,
      expose: true,
    });
  }
}

export async function handleAdminRequest<Req>(
  service: WebhooksService,
  options: WebhooksAdminOptions<Req>,
  req: Req,
  request: {
    method: string;
    path: string;
    query: URLSearchParams;
    readBody: () => Promise<unknown>;
  },
): Promise<ApiResponse | undefined> {
  const match = matchAdminRoute(request.method, request.path);
  if (!match) return undefined;
  try {
    const subject = await options.resolveSubject(req);
    if (!subject) return unauthenticated;
    if (options.permissions) {
      const allowed = await options.permissions.can(
        subject,
        options.permission ?? 'webhooks:admin',
        { type: 'webhooks' },
      );
      if (!allowed) return forbidden;
    }
    const body = match.route.hasBody ? await request.readBody() : undefined;
    return await executeAdminRoute(service, match.route.id, {
      params: match.params,
      query: request.query,
      body,
    });
  } catch (err) {
    return errorResponse(err, options.logger);
  }
}
