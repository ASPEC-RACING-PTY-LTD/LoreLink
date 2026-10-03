import { type AdminOptions, createAdminCore } from '../admin.js';
import { JobsErrorCode } from '../errors.js';

export type { AdminAction, AdminAuthorize, AdminAuthorizeContext } from '../admin.js';

export interface FetchAdminOptions extends AdminOptions<Request> {
  /** Path prefix to strip, for example `/admin/jobs`. Default empty. */
  basePath?: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

export function normaliseBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Web Fetch API handler for the jobs admin API. Works with runtimes that expose the Fetch API
 * (Node.js 22 `Request`/`Response`, Next.js route handlers and similar).
 */
export function createJobsAdminFetchHandler(options: FetchAdminOptions): FetchHandler {
  const core = createAdminCore<Request>(options);
  const base = normaliseBasePath(options.basePath);
  return async (request) => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) {
        return jsonResponse(404, {
          error: { code: JobsErrorCode.RouteNotFound, message: 'Not found' },
        });
      }
      path = path.slice(base.length);
    }
    const res = await core.handle({
      method: request.method,
      path,
      query: url.searchParams,
      request,
    });
    if (!res) {
      return jsonResponse(404, {
        error: { code: JobsErrorCode.RouteNotFound, message: 'Not found' },
      });
    }
    return jsonResponse(res.status, res.body);
  };
}
