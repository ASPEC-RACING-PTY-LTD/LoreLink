import { invalidOption } from '../errors.js';
import type { SqlClient, SqlDialect } from '../ports.js';
import {
  type BackendEvent,
  type CancelOutcome,
  type ClaimRequest,
  type FinishRequest,
  JOB_STATES,
  type JobErrorInfo,
  type JobRecord,
  type JobState,
  type JobsBackend,
  type NewJobRecord,
  type RescheduleRequest,
  type SerializableBackoff,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlBackendOptions {
  /** Table name prefix. Letters, digits and underscores. Default `jobs_`. */
  tablePrefix?: string;
  /**
   * PostgreSQL only: publish NOTIFY events on enqueue and cancel so listening workers wake up
   * immediately. Default true for PostgreSQL.
   */
  notify?: boolean;
  /**
   * PostgreSQL only: a dedicated, connected `pg.Client` (not a pool) used for LISTEN. Without
   * it workers rely on polling. The backend never ends this client.
   */
  listenClient?: PgListenClient;
}

/** The subset of `pg.Client` used for LISTEN/NOTIFY wake-ups. */
export interface PgListenClient {
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (message: PgNotification) => void): unknown;
  removeListener(event: 'notification', listener: (message: PgNotification) => void): unknown;
}

export interface PgNotification {
  channel: string;
  payload?: string | undefined;
}

export interface SqlBackend extends JobsBackend {
  readonly kind: SqlDialect;
  readonly tables: { jobs: string; migrations: string };
}

const PREFIX = /^[a-z][a-z0-9_]{0,40}$/;

function resolvePrefix(prefix: string | undefined): string {
  const p = prefix ?? 'jobs_';
  if (!PREFIX.test(p)) {
    throw invalidOption('tablePrefix', 'must match ^[a-z][a-z0-9_]{0,40}$');
  }
  return p;
}

const STATE_CHECK = JOB_STATES.map((s) => `'${s}'`).join(', ');

/** Migrations for a table prefix. `migrations` holds the default (`jobs_`) set. */
export function createMigrations(tablePrefix?: string): readonly Migration[] {
  const p = resolvePrefix(tablePrefix);
  const t = `${p}jobs`;
  return [
    {
      id: '001_create_jobs',
      postgres: `
CREATE TABLE IF NOT EXISTS ${t} (
  seq BIGSERIAL NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${STATE_CHECK})),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  backoff JSONB,
  progress_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  progress_data JSONB,
  result JSONB,
  last_error JSONB,
  lease_token TEXT,
  lease_expires_at BIGINT,
  worker_id TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS ${t}_ready_idx ON ${t} (priority, run_at, seq) WHERE state IN ('waiting', 'scheduled');
CREATE INDEX IF NOT EXISTS ${t}_lease_idx ON ${t} (lease_expires_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ${t}_state_seq_idx ON ${t} (state, seq);
CREATE INDEX IF NOT EXISTS ${t}_name_seq_idx ON ${t} (name, seq);
CREATE INDEX IF NOT EXISTS ${t}_finished_idx ON ${t} (state, finished_at) WHERE finished_at IS NOT NULL;
`,
      sqlite: `
CREATE TABLE IF NOT EXISTS ${t} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${STATE_CHECK})),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  backoff TEXT,
  progress_percent REAL NOT NULL DEFAULT 0,
  progress_data TEXT,
  result TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  worker_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ${t}_ready_idx ON ${t} (priority, run_at, seq) WHERE state IN ('waiting', 'scheduled');
CREATE INDEX IF NOT EXISTS ${t}_lease_idx ON ${t} (lease_expires_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ${t}_state_seq_idx ON ${t} (state, seq);
CREATE INDEX IF NOT EXISTS ${t}_name_seq_idx ON ${t} (name, seq);
CREATE INDEX IF NOT EXISTS ${t}_finished_idx ON ${t} (state, finished_at) WHERE finished_at IS NOT NULL;
`,
    },
  ];
}

export const migrations: readonly Migration[] = createMigrations();

/**
 * Applies pending migrations idempotently and records them in `<prefix>schema_migrations`.
 * On PostgreSQL a transaction-scoped advisory lock serialises concurrent migrators.
 */
export async function migrate(
  client: SqlClient,
  options: { tablePrefix?: string } = {},
): Promise<void> {
  const p = resolvePrefix(options.tablePrefix);
  const table = `${p}schema_migrations`;
  await client.transaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
    }
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`,
    );
    const applied = await tx.query<{ id: string }>(`SELECT id FROM ${table}`);
    const done = new Set(applied.rows.map((r) => r.id));
    for (const m of createMigrations(p)) {
      if (done.has(m.id)) continue;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(`INSERT INTO ${table} (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
    }
  });
}

interface Row {
  seq: number | string;
  id: string;
  name: string;
  payload: string;
  state: string;
  priority: number | string;
  run_at: number | string;
  attempts: number | string;
  max_attempts: number | string;
  backoff: string | null;
  progress_percent: number | string;
  progress_data: string | null;
  result: string | null;
  last_error: string | null;
  lease_token: string | null;
  lease_expires_at: number | string | null;
  worker_id: string | null;
  cancel_requested: boolean | number | string;
  created_at: number | string;
  updated_at: number | string;
  started_at: number | string | null;
  finished_at: number | string | null;
}

const num = (v: number | string): number => Number(v);
const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));
const bool = (v: boolean | number | string): boolean =>
  v === true || v === 1 || v === '1' || v === 't';
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
};

function mapRow(r: Row): JobRecord {
  return {
    seq: num(r.seq),
    id: r.id,
    name: r.name,
    payloadJson: text(r.payload) ?? 'null',
    state: r.state as JobState,
    priority: num(r.priority),
    runAt: num(r.run_at),
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    backoff:
      r.backoff === null ? null : (JSON.parse(text(r.backoff) ?? 'null') as SerializableBackoff),
    progressPercent: num(r.progress_percent),
    progressDataJson: text(r.progress_data),
    resultJson: text(r.result),
    lastError:
      r.last_error === null ? null : (JSON.parse(text(r.last_error) ?? 'null') as JobErrorInfo),
    leaseToken: r.lease_token,
    leaseExpiresAt: numOrNull(r.lease_expires_at),
    workerId: r.worker_id,
    cancelRequested: bool(r.cancel_requested),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    startedAt: numOrNull(r.started_at),
    finishedAt: numOrNull(r.finished_at),
  };
}

const isEvent = (v: unknown): v is BackendEvent => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    (e.type === 'enqueued' && typeof e.name === 'string') ||
    (e.type === 'cancel' && typeof e.id === 'string')
  );
};

/**
 * SQL backend over the SqlClient port. PostgreSQL is the production distributed backend
 * (claims use `FOR UPDATE SKIP LOCKED`); SQLite is a durable single-process backend.
 * Run `migrate(client)` before use.
 */
export function createSqlBackend(client: SqlClient, options: SqlBackendOptions = {}): SqlBackend {
  if (!client || typeof client.query !== 'function' || typeof client.transaction !== 'function') {
    throw invalidOption('client', 'must implement the SqlClient port');
  }
  const dialect = client.dialect;
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    throw invalidOption('client.dialect', 'must be "postgres" or "sqlite"');
  }
  const p = resolvePrefix(options.tablePrefix);
  const t = `${p}jobs`;
  const pg = dialect === 'postgres';
  const notify = pg && (options.notify ?? true);
  const channel = `${p}events`;
  const listenClient = options.listenClient;
  if (listenClient && !pg) throw invalidOption('listenClient', 'is only supported for PostgreSQL');

  const json = (n: number): string => (pg ? `CAST($${n} AS JSONB)` : `$${n}`);
  const big = (n: number): string => (pg ? `CAST($${n} AS BIGINT)` : `$${n}`);
  const col = (a: string, c: string, jsonCol = false): string =>
    pg && jsonCol ? `${a}${c}::text AS ${c}` : `${a}${c}`;
  const cols = (alias = ''): string => {
    const a = alias ? `${alias}.` : '';
    return [
      col(a, 'seq'),
      col(a, 'id'),
      col(a, 'name'),
      col(a, 'payload', true),
      col(a, 'state'),
      col(a, 'priority'),
      col(a, 'run_at'),
      col(a, 'attempts'),
      col(a, 'max_attempts'),
      col(a, 'backoff', true),
      col(a, 'progress_percent'),
      col(a, 'progress_data', true),
      col(a, 'result', true),
      col(a, 'last_error', true),
      col(a, 'lease_token'),
      col(a, 'lease_expires_at'),
      col(a, 'worker_id'),
      col(a, 'cancel_requested'),
      col(a, 'created_at'),
      col(a, 'updated_at'),
      col(a, 'started_at'),
      col(a, 'finished_at'),
    ].join(', ');
  };
  const COLS = cols();

  const one = async (sql: string, params: unknown[]): Promise<JobRecord | undefined> => {
    const res = await client.query<Row>(sql, params);
    const row = res.rows[0];
    return row ? mapRow(row) : undefined;
  };
  const many = async (sql: string, params: unknown[]): Promise<JobRecord[]> => {
    const res = await client.query<Row>(sql, params);
    return res.rows.map(mapRow);
  };

  const listeners = new Set<(event: BackendEvent) => void>();
  let listening: Promise<void> | undefined;
  const onNotification = (message: PgNotification): void => {
    if (message.channel !== channel || !message.payload) return;
    let event: unknown;
    try {
      event = JSON.parse(message.payload);
    } catch {
      return;
    }
    if (!isEvent(event)) return;
    for (const l of listeners) l(event);
  };

  const get = (id: string) => one(`SELECT ${COLS} FROM ${t} WHERE id = $1`, [id]);

  const backend: SqlBackend = {
    kind: dialect,
    tables: { jobs: t, migrations: `${p}schema_migrations` },

    async insert(job: NewJobRecord) {
      const record = await one(
        `INSERT INTO ${t} (id, name, payload, state, priority, run_at, attempts, max_attempts, backoff, progress_percent, cancel_requested, created_at, updated_at)
         VALUES ($1, $2, ${json(3)}, $4, $5, $6, 0, $7, ${json(8)}, 0, FALSE, $9, $9)
         ON CONFLICT (id) DO NOTHING RETURNING ${COLS}`,
        [
          job.id,
          job.name,
          job.payloadJson,
          job.state,
          job.priority,
          job.runAt,
          job.maxAttempts,
          job.backoff === null ? null : JSON.stringify(job.backoff),
          job.now,
        ],
      );
      if (record) return { record, created: true };
      const existing = await get(job.id);
      if (!existing) throw new Error(`jobs: insert conflict for "${job.id}" but no row found`);
      return { record: existing, created: false };
    },

    get,

    async list(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (v: unknown): number => params.push(v);
      if (query.name !== undefined) where.push(`name = $${add(query.name)}`);
      if (query.state === 'waiting') {
        where.push(
          `(state = 'waiting' OR (state = 'scheduled' AND run_at <= ${big(add(query.now))}))`,
        );
      } else if (query.state === 'scheduled') {
        where.push(`(state = 'scheduled' AND run_at > ${big(add(query.now))})`);
      } else if (query.state !== undefined) {
        where.push(`state = $${add(query.state)}`);
      }
      if (query.beforeSeq !== undefined) where.push(`seq < ${big(add(query.beforeSeq))}`);
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      return many(
        `SELECT ${COLS} FROM ${t} ${clause} ORDER BY seq DESC LIMIT $${add(query.limit)}`,
        params,
      );
    },

    async counts(query) {
      const params: unknown[] = [query.now];
      let clause = '';
      if (query.name !== undefined) {
        params.push(query.name);
        clause = 'WHERE name = $2';
      }
      const res = await client.query<{ state: string; n: number | string }>(
        `SELECT CASE WHEN state = 'scheduled' AND run_at <= ${big(1)} THEN 'waiting' ELSE state END AS state, COUNT(*) AS n
         FROM ${t} ${clause} GROUP BY 1`,
        params,
      );
      const out: Partial<Record<JobState, number>> = {};
      for (const r of res.rows) {
        const s = r.state as JobState;
        out[s] = (out[s] ?? 0) + Number(r.n);
      }
      return out;
    },

    async claim(req: ClaimRequest) {
      if (req.names.length === 0 || req.limit < 1) return [];
      const params = [
        req.now,
        pg ? [...req.names] : JSON.stringify(req.names),
        req.limit,
        req.leaseToken,
        req.workerId,
        req.leaseExpiresAt,
      ];
      const rows = await client.transaction(async (tx) => {
        const sql = pg
          ? `WITH picked AS (
               SELECT seq FROM ${t}
               WHERE state IN ('waiting', 'scheduled') AND run_at <= $1 AND name = ANY($2::text[])
               ORDER BY priority, run_at, seq
               LIMIT $3
               FOR UPDATE SKIP LOCKED
             )
             UPDATE ${t} AS j
             SET state = 'active', attempts = j.attempts + 1, lease_token = $4, worker_id = $5,
                 lease_expires_at = $6, started_at = $1, updated_at = $1
             FROM picked WHERE j.seq = picked.seq
             RETURNING ${cols('j')}`
          : `UPDATE ${t}
             SET state = 'active', attempts = attempts + 1, lease_token = $4, worker_id = $5,
                 lease_expires_at = $6, started_at = $1, updated_at = $1
             WHERE seq IN (
               SELECT seq FROM ${t}
               WHERE state IN ('waiting', 'scheduled') AND run_at <= $1
                 AND name IN (SELECT value FROM json_each($2))
               ORDER BY priority, run_at, seq
               LIMIT $3
             )
             RETURNING ${COLS}`;
        const res = await tx.query<Row>(sql, params);
        return res.rows.map(mapRow);
      });
      return rows.sort((a, b) => a.priority - b.priority || a.runAt - b.runAt || a.seq - b.seq);
    },

    async renewLease(id, token, leaseExpiresAt, now) {
      const res = await client.query<{ cancel_requested: boolean | number | string }>(
        `UPDATE ${t} SET lease_expires_at = $3, updated_at = $4
         WHERE id = $1 AND lease_token = $2 AND state = 'active' RETURNING cancel_requested`,
        [id, token, leaseExpiresAt, now],
      );
      const row = res.rows[0];
      return row
        ? { ok: true, cancelRequested: bool(row.cancel_requested) }
        : { ok: false, cancelRequested: false };
    },

    async updateProgress(id, token, percent, dataJson, now) {
      const res = await client.query(
        `UPDATE ${t} SET progress_percent = $3, progress_data = ${json(4)}, updated_at = $5
         WHERE id = $1 AND lease_token = $2 AND state = 'active'`,
        [id, token, percent, dataJson, now],
      );
      return res.rowCount > 0;
    },

    async finish(id, token, req: FinishRequest) {
      const params: unknown[] = [id, token, req.state, req.now];
      const sets = [
        'state = $3',
        'lease_token = NULL',
        'lease_expires_at = NULL',
        'worker_id = NULL',
        'finished_at = $4',
        'updated_at = $4',
      ];
      if (req.resultJson !== undefined) {
        params.push(req.resultJson);
        sets.push(`result = ${json(params.length)}`);
      }
      if (req.lastError !== undefined) {
        params.push(req.lastError === null ? null : JSON.stringify(req.lastError));
        sets.push(`last_error = ${json(params.length)}`);
      }
      if (req.state === 'completed') sets.push('progress_percent = 100');
      return one(
        `UPDATE ${t} SET ${sets.join(', ')}
         WHERE id = $1 AND lease_token = $2 AND state = 'active' RETURNING ${COLS}`,
        params,
      );
    },

    async reschedule(id, token, req: RescheduleRequest) {
      const target = req.runAt > req.now ? 'scheduled' : 'waiting';
      const params: unknown[] = [id, token, target, req.runAt, req.now];
      const sets = [
        "state = CASE WHEN cancel_requested THEN 'cancelled' ELSE $3 END",
        `run_at = CASE WHEN cancel_requested THEN run_at ELSE ${big(4)} END`,
        `finished_at = CASE WHEN cancel_requested THEN ${big(5)} ELSE NULL END`,
        'lease_token = NULL',
        'lease_expires_at = NULL',
        'worker_id = NULL',
        `updated_at = ${big(5)}`,
      ];
      if (!req.countAttempt)
        sets.push('attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END');
      if (req.lastError !== undefined) {
        params.push(req.lastError === null ? null : JSON.stringify(req.lastError));
        sets.push(`last_error = ${json(params.length)}`);
      }
      return one(
        `UPDATE ${t} SET ${sets.join(', ')}
         WHERE id = $1 AND lease_token = $2 AND state = 'active' RETURNING ${COLS}`,
        params,
      );
    },

    async cancel(id, now) {
      for (let i = 0; i < 3; i++) {
        const cancelled = await one(
          `UPDATE ${t} SET state = 'cancelled', finished_at = $2, updated_at = $2
           WHERE id = $1 AND state IN ('waiting', 'scheduled') RETURNING ${COLS}`,
          [id, now],
        );
        if (cancelled) return { outcome: 'cancelled' as CancelOutcome, record: cancelled };
        const requested = await one(
          `UPDATE ${t} SET cancel_requested = TRUE, updated_at = $2
           WHERE id = $1 AND state = 'active' RETURNING ${COLS}`,
          [id, now],
        );
        if (requested) return { outcome: 'requested' as CancelOutcome, record: requested };
        const current = await get(id);
        if (!current) return { outcome: 'not_found' as CancelOutcome };
        if (current.state !== 'waiting' && current.state !== 'scheduled') {
          return { outcome: 'invalid_state' as CancelOutcome, record: current };
        }
      }
      const current = await get(id);
      return current
        ? { outcome: 'invalid_state' as CancelOutcome, record: current }
        : { outcome: 'not_found' as CancelOutcome };
    },

    retry(id, now) {
      return one(
        `UPDATE ${t} SET state = 'waiting', attempts = 0, run_at = $2, cancel_requested = FALSE,
           finished_at = NULL, updated_at = $2, progress_percent = 0, progress_data = NULL, result = NULL
         WHERE id = $1 AND state IN ('failed', 'dead') RETURNING ${COLS}`,
        [id, now],
      );
    },

    async retryDead(query) {
      const params: unknown[] = [query.now, query.limit];
      let nameClause = '';
      if (query.name !== undefined) {
        params.push(query.name);
        nameClause = 'AND name = $3';
      }
      const res = await client.query(
        `UPDATE ${t} SET state = 'waiting', attempts = 0, run_at = $1, cancel_requested = FALSE,
           finished_at = NULL, updated_at = $1, progress_percent = 0, progress_data = NULL, result = NULL
         WHERE seq IN (SELECT seq FROM ${t} WHERE state = 'dead' ${nameClause} ORDER BY seq LIMIT $2)`,
        params,
      );
      return res.rowCount;
    },

    async purge(query) {
      if (query.states.length === 0) return 0;
      const params: unknown[] = [];
      const add = (v: unknown): number => params.push(v);
      const states = query.states.map((s) => `$${add(s)}`).join(', ');
      const where = [`state IN (${states})`];
      if (query.name !== undefined) where.push(`name = $${add(query.name)}`);
      if (query.finishedBefore !== undefined) {
        where.push(`COALESCE(finished_at, updated_at) < ${big(add(query.finishedBefore))}`);
      }
      const res = await client.query(
        `DELETE FROM ${t} WHERE seq IN (SELECT seq FROM ${t} WHERE ${where.join(' AND ')} LIMIT $${add(query.limit)})`,
        params,
      );
      return res.rowCount;
    },

    recoverStalled(now, error: JobErrorInfo) {
      const exhausted = 'attempts >= max_attempts';
      return many(
        `UPDATE ${t} SET
           state = CASE WHEN cancel_requested THEN 'cancelled' WHEN ${exhausted} THEN 'dead' ELSE 'waiting' END,
           last_error = CASE WHEN cancel_requested THEN last_error ELSE ${json(2)} END,
           run_at = CASE WHEN cancel_requested OR ${exhausted} THEN run_at ELSE ${big(1)} END,
           finished_at = CASE WHEN cancel_requested OR ${exhausted} THEN ${big(1)} ELSE NULL END,
           lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, updated_at = ${big(1)}
         WHERE state = 'active' AND lease_expires_at < ${big(1)}
         RETURNING ${COLS}`,
        [now, JSON.stringify(error)],
      );
    },

    async ping() {
      await client.query('SELECT 1 AS ok');
    },
  };

  if (notify) {
    backend.publish = async (event) => {
      await client.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(event)]);
    };
  }

  if (listenClient) {
    backend.subscribe = async (listener) => {
      listeners.add(listener);
      if (!listening) {
        listenClient.on('notification', onNotification);
        listening = listenClient.query(`LISTEN ${channel}`).then(() => undefined);
        listening.catch(() => {
          listenClient.removeListener('notification', onNotification);
          listening = undefined;
        });
      }
      try {
        await listening;
      } catch (err) {
        listeners.delete(listener);
        throw err;
      }
      return async () => {
        if (!listeners.delete(listener) || listeners.size > 0 || !listening) return;
        listening = undefined;
        listenClient.removeListener('notification', onNotification);
        await listenClient.query(`UNLISTEN ${channel}`);
      };
    };
  }

  return backend;
}
