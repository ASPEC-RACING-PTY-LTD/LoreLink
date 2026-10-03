import { decodeCursor, encodeCursor } from '../cursor.js';
import { invalidConfig } from '../errors.js';
import type { SqlClient } from '../ports.js';
import type {
  DeliveryAttempt,
  DeliveryPatch,
  DeliveryRecord,
  DeliveryStatus,
  InAppNotification,
  NotificationsStore,
  Page,
  PreferenceRecord,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlStoreOptions {
  /** Table name prefix. Default "notifications_". Must match [a-z][a-z0-9_]{0,40}. */
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
export const DEFAULT_TABLE_PREFIX = 'notifications_';

function checkPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw invalidConfig('tablePrefix', 'must match [a-z][a-z0-9_]{0,40}');
  }
  return prefix;
}

function schema(p: string, dialect: 'postgres' | 'sqlite'): string {
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const bool = dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER';
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS ${p}items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  data ${json},
  delivery_id TEXT,
  created_at ${big} NOT NULL,
  read_at ${big},
  archived_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}items_user_idx ON ${p}items (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ${p}items_created_idx ON ${p}items (created_at);
CREATE TABLE IF NOT EXISTS ${p}deliveries (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  user_id TEXT,
  category TEXT NOT NULL,
  channel TEXT NOT NULL,
  template TEXT,
  recipient ${json} NOT NULL,
  content ${json},
  status TEXT NOT NULL,
  skip_reason TEXT,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  provider_message_id TEXT,
  error_class TEXT,
  error_code TEXT,
  error_message TEXT,
  next_attempt_at ${big},
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  sent_at ${big},
  failed_at ${big},
  metadata ${json} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}deliveries_user_idx ON ${p}deliveries (user_id, created_at);
CREATE INDEX IF NOT EXISTS ${p}deliveries_status_idx ON ${p}deliveries (status, created_at);
CREATE INDEX IF NOT EXISTS ${p}deliveries_category_idx ON ${p}deliveries (category, created_at);
CREATE INDEX IF NOT EXISTS ${p}deliveries_channel_idx ON ${p}deliveries (channel, created_at);
CREATE INDEX IF NOT EXISTS ${p}deliveries_dispatch_idx ON ${p}deliveries (dispatch_id);
CREATE TABLE IF NOT EXISTS ${p}delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error_class TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at ${big} NOT NULL,
  finished_at ${big} NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}delivery_attempts_delivery_idx ON ${p}delivery_attempts (delivery_id, attempt);
CREATE TABLE IF NOT EXISTS ${p}preferences (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled ${bool} NOT NULL,
  updated_at ${big} NOT NULL,
  PRIMARY KEY (user_id, category, channel)
);
`;
}

/** Migrations for a table prefix. */
export function createMigrations(tablePrefix: string = DEFAULT_TABLE_PREFIX): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  return [{ id: '0001_initial', postgres: schema(p, 'postgres'), sqlite: schema(p, 'sqlite') }];
}

/** Migrations for the default "notifications_" prefix. */
export const migrations: readonly Migration[] = createMigrations();

/** Applies pending migrations idempotently, tracked in <prefix>schema_migrations. */
export async function migrate(client: SqlClient, options: SqlStoreOptions = {}): Promise<void> {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const big = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${big} NOT NULL)`,
  );
  for (const migration of createMigrations(p)) {
    await client.transaction(async (tx) => {
      if (tx.dialect === 'postgres') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p}schema_migrations`]);
      }
      const done = await tx.query(`SELECT id FROM ${p}schema_migrations WHERE id = $1`, [
        migration.id,
      ]);
      if (done.rows.length > 0) return;
      await tx.query(tx.dialect === 'postgres' ? migration.postgres : migration.sqlite);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        migration.id,
        Date.now(),
      ]);
    });
  }
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);
const optStr = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);
const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't';

function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function toInApp(row: Row): InAppNotification {
  const n: InAppNotification = {
    id: String(row.id),
    userId: String(row.user_id),
    category: String(row.category),
    title: String(row.title),
    body: String(row.body),
    createdAt: num(row.created_at),
  };
  assign(n, 'url', optStr(row.url));
  if (row.data !== null && row.data !== undefined) n.data = json<Record<string, unknown>>(row.data);
  assign(n, 'deliveryId', optStr(row.delivery_id));
  assign(n, 'readAt', optNum(row.read_at));
  assign(n, 'archivedAt', optNum(row.archived_at));
  return n;
}

function toDelivery(row: Row): DeliveryRecord {
  const d: DeliveryRecord = {
    id: String(row.id),
    dispatchId: String(row.dispatch_id),
    category: String(row.category),
    channel: String(row.channel),
    recipient: json(row.recipient),
    status: String(row.status) as DeliveryStatus,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    metadata: json(row.metadata),
  };
  assign(d, 'idempotencyKey', optStr(row.idempotency_key));
  assign(d, 'userId', optStr(row.user_id));
  assign(d, 'template', optStr(row.template));
  if (row.content !== null && row.content !== undefined) d.content = json(row.content);
  assign(d, 'skipReason', optStr(row.skip_reason) as DeliveryRecord['skipReason']);
  assign(d, 'providerMessageId', optStr(row.provider_message_id));
  assign(d, 'errorClass', optStr(row.error_class) as DeliveryRecord['errorClass']);
  assign(d, 'errorCode', optStr(row.error_code));
  assign(d, 'errorMessage', optStr(row.error_message));
  assign(d, 'nextAttemptAt', optNum(row.next_attempt_at));
  assign(d, 'sentAt', optNum(row.sent_at));
  assign(d, 'failedAt', optNum(row.failed_at));
  return d;
}

function toAttempt(row: Row): DeliveryAttempt {
  const a: DeliveryAttempt = {
    id: String(row.id),
    deliveryId: String(row.delivery_id),
    attempt: num(row.attempt),
    status: String(row.status) as DeliveryAttempt['status'],
    startedAt: num(row.started_at),
    finishedAt: num(row.finished_at),
    durationMs: num(row.duration_ms),
  };
  assign(a, 'providerMessageId', optStr(row.provider_message_id));
  assign(a, 'errorClass', optStr(row.error_class) as DeliveryAttempt['errorClass']);
  assign(a, 'errorCode', optStr(row.error_code));
  assign(a, 'errorMessage', optStr(row.error_message));
  return a;
}

const PATCH_COLUMNS = {
  status: 'status',
  attempts: 'attempts',
  providerMessageId: 'provider_message_id',
  errorClass: 'error_class',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  nextAttemptAt: 'next_attempt_at',
  sentAt: 'sent_at',
  failedAt: 'failed_at',
  content: 'content',
  updatedAt: 'updated_at',
} as const;

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];
  add(sql: (placeholder: string) => string, value: unknown): void {
    this.params.push(value);
    this.clauses.push(sql(`$${this.params.length}`));
  }
  raw(sql: string): void {
    this.clauses.push(sql);
  }
  cursor(cursor: string | undefined): void {
    if (cursor === undefined) return;
    const pos = decodeCursor(cursor);
    this.params.push(pos.createdAt, pos.id);
    const c = `$${this.params.length - 1}`;
    const i = `$${this.params.length}`;
    this.clauses.push(`(created_at < ${c} OR (created_at = ${c} AND id < ${i}))`);
  }
  toSql(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`;
  }
}

async function page<T extends { createdAt: number; id: string }>(
  client: SqlClient,
  table: string,
  where: Where,
  limit: number,
  map: (row: Row) => T,
): Promise<Page<T>> {
  where.params.push(limit + 1);
  const result = await client.query<Row>(
    `SELECT * FROM ${table}${where.toSql()} ORDER BY created_at DESC, id DESC LIMIT $${where.params.length}`,
    where.params,
  );
  const items = result.rows.slice(0, limit).map(map);
  const last = items[items.length - 1];
  return result.rows.length > limit && last !== undefined
    ? { items, nextCursor: encodeCursor(last) }
    : { items };
}

/**
 * SQL store for PostgreSQL and SQLite on the SqlClient port. Run migrate(client) first.
 */
export function createSqlStore(
  client: SqlClient,
  options: SqlStoreOptions = {},
): NotificationsStore {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const items = `${p}items`;
  const deliveries = `${p}deliveries`;
  const attemptsTable = `${p}delivery_attempts`;
  const prefs = `${p}preferences`;
  const jsonParam = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
  const boolParam = (v: boolean): boolean | number =>
    client.dialect === 'postgres' ? v : v ? 1 : 0;

  return {
    async createInApp(n) {
      await client.query(
        `INSERT INTO ${items} (id, user_id, category, title, body, url, data, delivery_id, created_at, read_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          n.id,
          n.userId,
          n.category,
          n.title,
          n.body,
          n.url ?? null,
          jsonParam(n.data),
          n.deliveryId ?? null,
          n.createdAt,
          n.readAt ?? null,
          n.archivedAt ?? null,
        ],
      );
    },
    async getInApp(userId, id) {
      const r = await client.query<Row>(`SELECT * FROM ${items} WHERE user_id = $1 AND id = $2`, [
        userId,
        id,
      ]);
      const row = r.rows[0];
      return row ? toInApp(row) : undefined;
    },
    async listInApp(userId, opts) {
      const w = new Where();
      w.add((x) => `user_id = ${x}`, userId);
      if (opts.category !== undefined) w.add((x) => `category = ${x}`, opts.category);
      if (opts.archivedOnly) w.raw('archived_at IS NOT NULL');
      else if (!opts.includeArchived) w.raw('archived_at IS NULL');
      if (opts.unreadOnly) w.raw('read_at IS NULL');
      w.cursor(opts.cursor);
      return page(client, items, w, opts.limit, toInApp);
    },
    async queryInApp(q) {
      const w = new Where();
      if (q.userId !== undefined) w.add((x) => `user_id = ${x}`, q.userId);
      if (q.category !== undefined) w.add((x) => `category = ${x}`, q.category);
      if (q.from !== undefined) w.add((x) => `created_at >= ${x}`, q.from);
      if (q.to !== undefined) w.add((x) => `created_at < ${x}`, q.to);
      if (q.state === 'archived') w.raw('archived_at IS NOT NULL');
      if (q.state === 'read') w.raw('read_at IS NOT NULL AND archived_at IS NULL');
      if (q.state === 'unread') w.raw('read_at IS NULL AND archived_at IS NULL');
      w.cursor(q.cursor);
      return page(client, items, w, q.limit, toInApp);
    },
    async countUnread(userId) {
      const r = await client.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${items} WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL`,
        [userId],
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    async markRead(userId, id, at) {
      await client.query(
        `UPDATE ${items} SET read_at = $3 WHERE user_id = $1 AND id = $2 AND read_at IS NULL`,
        [userId, id, at],
      );
      const r = await client.query(`SELECT id FROM ${items} WHERE user_id = $1 AND id = $2`, [
        userId,
        id,
      ]);
      return r.rows.length > 0;
    },
    async markAllRead(userId, at) {
      const r = await client.query(
        `UPDATE ${items} SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL`,
        [userId, at],
      );
      return r.rowCount;
    },
    async archive(userId, id, at) {
      const r = await client.query(
        `UPDATE ${items} SET archived_at = COALESCE(archived_at, $3), read_at = COALESCE(read_at, $3)
         WHERE user_id = $1 AND id = $2`,
        [userId, id, at],
      );
      return r.rowCount > 0;
    },
    async deleteInApp(userId, id) {
      const r = await client.query(`DELETE FROM ${items} WHERE user_id = $1 AND id = $2`, [
        userId,
        id,
      ]);
      return r.rowCount > 0;
    },

    async createDelivery(d) {
      const inserted = await client.query<Row>(
        `INSERT INTO ${deliveries} (id, dispatch_id, idempotency_key, user_id, category, channel, template,
           recipient, content, status, skip_reason, attempts, max_attempts, provider_message_id, error_class,
           error_code, error_message, next_attempt_at, created_at, updated_at, sent_at, failed_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          d.id,
          d.dispatchId,
          d.idempotencyKey ?? null,
          d.userId ?? null,
          d.category,
          d.channel,
          d.template ?? null,
          jsonParam(d.recipient),
          jsonParam(d.content),
          d.status,
          d.skipReason ?? null,
          d.attempts,
          d.maxAttempts,
          d.providerMessageId ?? null,
          d.errorClass ?? null,
          d.errorCode ?? null,
          d.errorMessage ?? null,
          d.nextAttemptAt ?? null,
          d.createdAt,
          d.updatedAt,
          d.sentAt ?? null,
          d.failedAt ?? null,
          jsonParam(d.metadata),
        ],
      );
      const row = inserted.rows[0];
      if (row) return { delivery: toDelivery(row), created: true };
      const existing = await client.query<Row>(
        `SELECT * FROM ${deliveries} WHERE idempotency_key = $1`,
        [d.idempotencyKey ?? null],
      );
      const found = existing.rows[0];
      if (!found)
        throw new Error('notifications: delivery insert conflicted but no existing row was found');
      return { delivery: toDelivery(found), created: false };
    },
    async getDelivery(id) {
      const r = await client.query<Row>(`SELECT * FROM ${deliveries} WHERE id = $1`, [id]);
      const row = r.rows[0];
      return row ? toDelivery(row) : undefined;
    },
    async claimDelivery(id, now, staleBefore) {
      const r = await client.query<Row>(
        `UPDATE ${deliveries} SET status = 'sending', attempts = attempts + 1, updated_at = $2
         WHERE id = $1 AND (status = 'queued' OR (status = 'sending' AND updated_at < $3))
         RETURNING *`,
        [id, now, staleBefore],
      );
      const row = r.rows[0];
      return row ? toDelivery(row) : undefined;
    },
    async updateDelivery(id, patch: DeliveryPatch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [field, column] of Object.entries(PATCH_COLUMNS) as [
        keyof typeof PATCH_COLUMNS,
        string,
      ][]) {
        const value = patch[field];
        if (value === undefined) continue;
        params.push(field === 'content' ? jsonParam(value) : value);
        sets.push(`${column} = $${params.length}`);
      }
      for (const field of patch.clear ?? []) sets.push(`${PATCH_COLUMNS[field]} = NULL`);
      const r = await client.query<Row>(
        `UPDATE ${deliveries} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      );
      const row = r.rows[0];
      return row ? toDelivery(row) : undefined;
    },
    async listDeliveries(q) {
      const w = new Where();
      if (q.userId !== undefined) w.add((x) => `user_id = ${x}`, q.userId);
      if (q.category !== undefined) w.add((x) => `category = ${x}`, q.category);
      if (q.channel !== undefined) w.add((x) => `channel = ${x}`, q.channel);
      if (q.status !== undefined) w.add((x) => `status = ${x}`, q.status);
      if (q.dispatchId !== undefined) w.add((x) => `dispatch_id = ${x}`, q.dispatchId);
      if (q.from !== undefined) w.add((x) => `created_at >= ${x}`, q.from);
      if (q.to !== undefined) w.add((x) => `created_at < ${x}`, q.to);
      w.cursor(q.cursor);
      return page(client, deliveries, w, q.limit, toDelivery);
    },
    async addAttempt(a) {
      await client.query(
        `INSERT INTO ${attemptsTable} (id, delivery_id, attempt, status, provider_message_id, error_class,
           error_code, error_message, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          a.id,
          a.deliveryId,
          a.attempt,
          a.status,
          a.providerMessageId ?? null,
          a.errorClass ?? null,
          a.errorCode ?? null,
          a.errorMessage ?? null,
          a.startedAt,
          a.finishedAt,
          a.durationMs,
        ],
      );
    },
    async listAttempts(deliveryId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${attemptsTable} WHERE delivery_id = $1 ORDER BY attempt ASC`,
        [deliveryId],
      );
      return r.rows.map(toAttempt);
    },

    async listPreferences(userId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${prefs} WHERE user_id = $1 ORDER BY category, channel`,
        [userId],
      );
      return r.rows.map(
        (row): PreferenceRecord => ({
          userId: String(row.user_id),
          category: String(row.category),
          channel: String(row.channel),
          enabled: bool(row.enabled),
          updatedAt: num(row.updated_at),
        }),
      );
    },
    async setPreference(record) {
      await client.query(
        `INSERT INTO ${prefs} (user_id, category, channel, enabled, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
        [
          record.userId,
          record.category,
          record.channel,
          boolParam(record.enabled),
          record.updatedAt,
        ],
      );
    },
    async deletePreference(userId, category, channel) {
      const r = await client.query(
        `DELETE FROM ${prefs} WHERE user_id = $1 AND category = $2 AND channel = $3`,
        [userId, category, channel],
      );
      return r.rowCount > 0;
    },

    async purge(before) {
      return client.transaction(async (tx) => {
        const done = `status IN ('sent', 'failed', 'skipped')`;
        await tx.query(
          `DELETE FROM ${attemptsTable} WHERE delivery_id IN (SELECT id FROM ${deliveries} WHERE created_at < $1 AND ${done})`,
          [before],
        );
        const d = await tx.query(`DELETE FROM ${deliveries} WHERE created_at < $1 AND ${done}`, [
          before,
        ]);
        const n = await tx.query(`DELETE FROM ${items} WHERE created_at < $1`, [before]);
        return { notifications: n.rowCount, deliveries: d.rowCount };
      });
    },
  };
}
