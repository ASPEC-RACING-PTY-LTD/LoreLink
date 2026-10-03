import { invalidInput, isNotificationsError, NotificationsError } from './errors.js';
import type { LoggerLike } from './ports.js';
import type { InAppListInput, NotificationsService, PreferenceUpdate } from './service.js';

/** Resolves the authenticated user of a request. Return undefined or null when unauthenticated. */
export type ResolveUser<Req> = (
  req: Req,
) =>
  | Promise<string | { id: string } | null | undefined>
  | string
  | { id: string }
  | null
  | undefined;

export interface NotificationsApiOptions<Req> {
  resolveUser: ResolveUser<Req>;
  /** Maximum JSON body size in bytes. Default 65536. */
  bodyLimitBytes?: number;
  logger?: LoggerLike;
}

export type RouteId =
  | 'list'
  | 'unreadCount'
  | 'readAll'
  | 'getPreferences'
  | 'setPreferences'
  | 'resetPreference'
  | 'get'
  | 'read'
  | 'archive'
  | 'delete';

export interface RouteDefinition {
  id: RouteId;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path relative to the mount point, framework syntax ":id" for parameters. */
  path: string;
  hasBody: boolean;
}

/** Routes of the in-app notification and preferences API. Static paths come first. */
export const notificationRoutes: readonly RouteDefinition[] = [
  { id: 'list', method: 'GET', path: '/', hasBody: false },
  { id: 'unreadCount', method: 'GET', path: '/unread-count', hasBody: false },
  { id: 'readAll', method: 'POST', path: '/read-all', hasBody: false },
  { id: 'getPreferences', method: 'GET', path: '/preferences', hasBody: false },
  { id: 'setPreferences', method: 'PUT', path: '/preferences', hasBody: true },
  { id: 'resetPreference', method: 'DELETE', path: '/preferences', hasBody: false },
  { id: 'get', method: 'GET', path: '/:id', hasBody: false },
  { id: 'read', method: 'POST', path: '/:id/read', hasBody: false },
  { id: 'archive', method: 'POST', path: '/:id/archive', hasBody: false },
  { id: 'delete', method: 'DELETE', path: '/:id', hasBody: false },
];

export interface ApiResponse {
  status: number;
  body?: unknown;
}

const ID_SEGMENT = /^[A-Za-z0-9._:-]{1,256}$/;

/** Matches a method and a path relative to the mount point. */
export function matchRoute(
  method: string,
  path: string,
): { route: RouteDefinition; params: Record<string, string> } | undefined {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path || '/';
  const parts = normalized.split('/').filter(Boolean);
  for (const route of notificationRoutes) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const seg = pattern[i] as string;
      const actual = parts[i] as string;
      if (seg.startsWith(':')) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(actual);
        } catch {
          ok = false;
          break;
        }
        params[seg.slice(1)] = decoded;
      } else if (seg !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

export async function resolveUserId<Req>(
  resolve: ResolveUser<Req>,
  req: Req,
): Promise<string | undefined> {
  const user = await resolve(req);
  if (user === null || user === undefined) return undefined;
  const id = typeof user === 'string' ? user : user.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function parseBool(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw invalidInput('boolean query parameters must be true or false');
}

function listOptions(query: URLSearchParams): InAppListInput {
  const opts: InAppListInput = {};
  const limit = query.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw invalidInput('limit must be a positive integer');
    opts.limit = n;
  }
  const cursor = query.get('cursor');
  if (cursor !== null) opts.cursor = cursor;
  const unread = parseBool(query.get('unread'));
  if (unread !== undefined) opts.unreadOnly = unread;
  const archived = query.get('archived');
  if (archived === 'include') opts.includeArchived = true;
  else if (archived === 'only') opts.archivedOnly = true;
  else if (archived !== null && archived !== 'exclude') {
    throw invalidInput('archived must be include, only or exclude');
  }
  const category = query.get('category');
  if (category !== null) opts.category = category;
  return opts;
}

function preferenceUpdates(body: unknown): PreferenceUpdate[] {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const updates = (body as { updates?: unknown }).updates;
    if (Array.isArray(updates)) return updates as PreferenceUpdate[];
    return [body as PreferenceUpdate];
  }
  if (Array.isArray(body)) return body as PreferenceUpdate[];
  throw invalidInput('body must be a preference update, an array, or { updates: [...] }');
}

/** Executes a matched route for an authenticated user. */
export async function executeRoute(
  service: NotificationsService,
  route: RouteId,
  input: { userId: string; params: Record<string, string>; query: URLSearchParams; body: unknown },
): Promise<ApiResponse> {
  const { userId, params, query, body } = input;
  const id = params.id ?? '';
  if (params.id !== undefined && !ID_SEGMENT.test(id))
    throw invalidInput('invalid notification id');
  switch (route) {
    case 'list':
      return { status: 200, body: await service.listNotifications(userId, listOptions(query)) };
    case 'unreadCount':
      return { status: 200, body: { count: await service.unreadCount(userId) } };
    case 'readAll':
      return { status: 200, body: { updated: await service.markAllRead(userId) } };
    case 'getPreferences':
      return { status: 200, body: await service.getPreferences(userId) };
    case 'setPreferences':
      return { status: 200, body: await service.setPreferences(userId, preferenceUpdates(body)) };
    case 'resetPreference': {
      const category = query.get('category');
      const channel = query.get('channel');
      if (category === null || channel === null) {
        throw invalidInput('category and channel query parameters are required');
      }
      return { status: 200, body: await service.resetPreference(userId, category, channel) };
    }
    case 'get':
      return { status: 200, body: await service.getNotification(userId, id) };
    case 'read':
      await service.markRead(userId, id);
      return { status: 204 };
    case 'archive':
      await service.archive(userId, id);
      return { status: 204 };
    case 'delete':
      await service.deleteNotification(userId, id);
      return { status: 204 };
  }
}

/** Converts an error into a safe JSON response. Internal details are never exposed. */
export function errorResponse(err: unknown, logger?: LoggerLike): ApiResponse {
  if (isNotificationsError(err) && err.expose && err.status < 500) {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { status: err.status, body: { error } };
  }
  logger?.error(
    {
      code: err instanceof NotificationsError ? err.code : undefined,
      err: err instanceof Error ? err.message : String(err),
    },
    'notifications: request failed',
  );
  const status = isNotificationsError(err) ? err.status : 500;
  return {
    status: status >= 400 ? status : 500,
    body: { error: { code: 'NOTIFICATIONS_INTERNAL', message: 'Internal error' } },
  };
}

export const unauthenticated: ApiResponse = {
  status: 401,
  body: { error: { code: 'NOTIFICATIONS_UNAUTHENTICATED', message: 'Authentication required' } },
};

export const DEFAULT_BODY_LIMIT = 65_536;

export function bodyTooLarge(): NotificationsError {
  return new NotificationsError('NOTIFICATIONS_INVALID_INPUT', 'Request body too large', {
    status: 413,
    expose: true,
  });
}

/** Parses a JSON request body with a size limit. Empty bodies become undefined. */
export function parseJsonBody(text: string, limit: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > limit) throw bodyTooLarge();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidInput('Request body must be valid JSON');
  }
}

/**
 * Framework-neutral request handler used by every adapter. Returns undefined when no route
 * matches so adapters can fall through.
 */
export async function handleNotificationsRequest<Req>(
  service: NotificationsService,
  options: NotificationsApiOptions<Req>,
  req: Req,
  request: {
    method: string;
    path: string;
    query: URLSearchParams;
    readBody: () => Promise<unknown>;
  },
): Promise<ApiResponse | undefined> {
  const match = matchRoute(request.method, request.path);
  if (!match) return undefined;
  try {
    const userId = await resolveUserId(options.resolveUser, req);
    if (userId === undefined) return unauthenticated;
    const body = match.route.hasBody ? await request.readBody() : undefined;
    return await executeRoute(service, match.route.id, {
      userId,
      params: match.params,
      query: request.query,
      body,
    });
  } catch (err) {
    return errorResponse(err, options.logger);
  }
}
