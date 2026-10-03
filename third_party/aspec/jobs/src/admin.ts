import { invalidOption, JobsError, JobsErrorCode } from './errors.js';
import { errorInfo, isValidJobId } from './internal.js';
import type { LoggerLike } from './ports.js';
import type { Queue } from './queue.js';
import type { Job, JobState } from './types.js';

export type AdminAction = 'jobs:read' | 'jobs:retry' | 'jobs:cancel';

export interface AdminAuthorizeContext<Req> {
  action: AdminAction;
  /** Set for single-job operations. */
  jobId?: string;
  /** The framework request (Express `req`, Fastify `request`, Hono `c`, Fetch `Request`). */
  request: Req;
}

/** Return true to allow the operation. Throwing is treated as a server error (500). */
export type AdminAuthorize<Req> = (ctx: AdminAuthorizeContext<Req>) => boolean | Promise<boolean>;

export interface AdminOptions<Req> {
  queue: Queue;
  /** Required. Decide per action whether the caller may proceed. */
  authorize: AdminAuthorize<Req>;
  /** Include job payloads in responses. Payloads may contain personal data. Default false. */
  includePayload?: boolean;
  logger?: LoggerLike;
}

export interface AdminRequest<Req> {
  method: string;
  /** Path relative to the admin mount point, for example `/jobs/123/retry`. */
  path: string;
  query: URLSearchParams;
  request: Req;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

/** Framework-agnostic admin dispatcher used by every adapter. */
export interface AdminCore<Req> {
  handle(req: AdminRequest<Req>): Promise<AdminResponse | undefined>;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function serialiseJob(job: Job, includePayload: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: job.id,
    name: job.name,
    state: job.state,
    priority: job.priority,
    runAt: job.runAt.toISOString(),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
  if (includePayload) out.payload = job.payload;
  if (job.result !== undefined) out.result = job.result;
  if (job.lastError) out.lastError = job.lastError;
  if (job.workerId) out.workerId = job.workerId;
  if (job.startedAt) out.startedAt = job.startedAt.toISOString();
  if (job.finishedAt) out.finishedAt = job.finishedAt.toISOString();
  if (job.leaseExpiresAt) out.leaseExpiresAt = job.leaseExpiresAt.toISOString();
  return out;
}

const intParam = (value: string | null, name: string, max: number): number | undefined => {
  if (value === null || value === '') return undefined;
  if (!/^\d{1,7}$/.test(value)) {
    throw new JobsError(JobsErrorCode.BadRequest, `Query parameter "${name}" must be an integer`, {
      status: 400,
      expose: true,
    });
  }
  const n = Number(value);
  if (n < 1 || n > max) {
    throw new JobsError(
      JobsErrorCode.BadRequest,
      `Query parameter "${name}" must be from 1 to ${max}`,
      { status: 400, expose: true },
    );
  }
  return n;
};

const strParam = (value: string | null): string | undefined =>
  value === null || value === '' ? undefined : value;

/**
 * Routes (relative to the mount point):
 * GET /counts, GET /jobs, GET /jobs/:id, POST /jobs/:id/retry, POST /jobs/:id/cancel,
 * GET /dead, POST /dead/retry.
 */
export function createAdminCore<Req>(options: AdminOptions<Req>): AdminCore<Req> {
  if (!options || typeof options !== 'object') throw invalidOption('options', 'must be an object');
  if (!options.queue || typeof options.queue.getJob !== 'function') {
    throw invalidOption('queue', 'must be a queue created with createQueue()');
  }
  if (typeof options.authorize !== 'function') {
    throw invalidOption('authorize', 'is required; the admin API has no default access policy');
  }
  const { queue, authorize } = options;
  const includePayload = options.includePayload ?? false;
  const logger = options.logger ?? queue.logger;

  const guard = async (req: AdminRequest<Req>, action: AdminAction, jobId?: string) => {
    const ctx: AdminAuthorizeContext<Req> = { action, request: req.request };
    if (jobId !== undefined) ctx.jobId = jobId;
    if ((await authorize(ctx)) !== true) {
      throw new JobsError(JobsErrorCode.Forbidden, 'Not allowed', { status: 403, expose: true });
    }
  };

  const route = async (req: AdminRequest<Req>): Promise<AdminResponse | undefined> => {
    const method = req.method.toUpperCase();
    const segments = req.path.split('/').filter((s) => s.length > 0);
    let decoded: string[];
    try {
      decoded = segments.map((s) => decodeURIComponent(s));
    } catch {
      throw new JobsError(JobsErrorCode.BadRequest, 'Malformed path', {
        status: 400,
        expose: true,
      });
    }
    const [a, b, c] = decoded;
    const q = req.query;
    const list = (state?: JobState) => {
      const opts: Parameters<Queue['listJobs']>[0] = {};
      const s = state ?? (strParam(q.get('state')) as JobState | undefined);
      if (s) opts.state = s;
      const name = strParam(q.get('name'));
      if (name) opts.name = name;
      const limit = intParam(q.get('limit'), 'limit', 1000);
      if (limit) opts.limit = limit;
      const cursor = strParam(q.get('cursor'));
      if (cursor) opts.cursor = cursor;
      return opts;
    };
    const page = async (state?: JobState): Promise<AdminResponse> => {
      await guard(req, 'jobs:read');
      const result = await queue.listJobs(list(state));
      const body: Record<string, unknown> = {
        jobs: result.jobs.map((j) => serialiseJob(j, includePayload)),
      };
      if (result.nextCursor) body.nextCursor = result.nextCursor;
      return { status: 200, body };
    };
    const jobIdParam = (id: string): string => {
      if (!isValidJobId(id)) {
        throw new JobsError(JobsErrorCode.BadRequest, 'Invalid job id', {
          status: 400,
          expose: true,
        });
      }
      return id;
    };

    if (method === 'GET' && a === 'counts' && decoded.length === 1) {
      await guard(req, 'jobs:read');
      const name = strParam(q.get('name'));
      return { status: 200, body: { counts: await queue.counts(name ? { name } : {}) } };
    }
    if (a === 'jobs' && decoded.length === 1 && method === 'GET') return page();
    if (a === 'dead' && decoded.length === 1 && method === 'GET') return page('dead');
    if (a === 'dead' && b === 'retry' && decoded.length === 2 && method === 'POST') {
      await guard(req, 'jobs:retry');
      const opts: { name?: string; limit?: number } = {};
      const name = strParam(q.get('name'));
      if (name) opts.name = name;
      const limit = intParam(q.get('limit'), 'limit', 100_000);
      if (limit) opts.limit = limit;
      return { status: 200, body: await queue.retryDead(opts) };
    }
    if (a === 'jobs' && b !== undefined) {
      const id = jobIdParam(b);
      if (decoded.length === 2 && method === 'GET') {
        await guard(req, 'jobs:read', id);
        const job = await queue.getJob(id);
        if (!job) {
          return {
            status: 404,
            body: errorBody(JobsErrorCode.NotFound, `Job "${id}" was not found`),
          };
        }
        return { status: 200, body: { job: serialiseJob(job, includePayload) } };
      }
      if (decoded.length === 3 && method === 'POST' && c === 'retry') {
        await guard(req, 'jobs:retry', id);
        return { status: 200, body: { job: serialiseJob(await queue.retry(id), includePayload) } };
      }
      if (decoded.length === 3 && method === 'POST' && c === 'cancel') {
        await guard(req, 'jobs:cancel', id);
        return { status: 200, body: { job: serialiseJob(await queue.cancel(id), includePayload) } };
      }
    }
    return undefined;
  };

  return {
    async handle(req) {
      try {
        return await route(req);
      } catch (err) {
        if (err instanceof JobsError && err.expose) {
          return { status: err.status, body: errorBody(err.code, err.message) };
        }
        logger.error({ err: errorInfo(err) }, 'jobs: admin request failed');
        return { status: 500, body: errorBody(JobsErrorCode.Internal, 'Internal error') };
      }
    },
  };
}
