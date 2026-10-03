import { invalidConfig } from '../errors.js';
import type { SqlClient } from '../ports.js';
import type {
  Delivery,
  DeliveryAttempt,
  SeenIdStore,
  Subscription,
  WebhookEvent,
  WebhooksStore,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlStoreOptions {
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
export const DEFAULT_TABLE_PREFIX = 'webhooks_';

function checkPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw invalidConfig('tablePrefix', 'must match [a-z][a-z0-9_]{0,40}');
  }
  return prefix;
}

function schema(p: string, dialect: 'postgres' | 'sqlite'): string {
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS ${p}subscriptions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  event_types ${json} NOT NULL,
  payload_filter ${json},
  secrets ${json} NOT NULL,
  tenant_id TEXT,
  owner_id TEXT,
  metadata ${json} NOT NULL,
  headers ${json},
  consecutive_failures INTEGER NOT NULL,
  disabled_reason TEXT,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}subscriptions_tenant_idx ON ${p}subscriptions (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ${p}events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload ${json} NOT NULL,
  tenant_id TEXT,
  idempotency_key TEXT,
  created_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}events_idem_idx ON ${p}events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${p}deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at ${big},
  last_status_code INTEGER,
  last_error TEXT,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}deliveries_sub_idx ON ${p}deliveries (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ${p}deliveries_status_idx ON ${p}deliveries (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS ${p}delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  request_headers ${json} NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  created_at ${big} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}attempts_delivery_idx ON ${p}delivery_attempts (delivery_id, attempt);
CREATE TABLE IF NOT EXISTS ${p}seen_ids (
  id TEXT PRIMARY KEY,
  expires_at ${big} NOT NULL
);
`;
}

export function createMigrations(tablePrefix: string = DEFAULT_TABLE_PREFIX): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  return [{ id: '0001_initial', postgres: schema(p, 'postgres'), sqlite: schema(p, 'sqlite') }];
}

export const migrations: readonly Migration[] = createMigrations();

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
const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

function mapSub(row: Row): Subscription {
  const sub: Subscription = {
    id: String(row.id),
    url: String(row.url),
    status: row.status as Subscription['status'],
    eventTypes: json(row.event_types),
    secrets: json(row.secrets),
    metadata: json(row.metadata),
    consecutiveFailures: num(row.consecutive_failures),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
  if (row.description != null) sub.description = String(row.description);
  if (row.payload_filter != null) sub.payloadFilter = json(row.payload_filter);
  if (row.tenant_id != null) sub.tenantId = String(row.tenant_id);
  if (row.owner_id != null) sub.ownerId = String(row.owner_id);
  if (row.headers != null) sub.headers = json(row.headers);
  if (row.disabled_reason != null) sub.disabledReason = String(row.disabled_reason);
  return sub;
}

function mapEvent(row: Row): WebhookEvent {
  const e: WebhookEvent = {
    id: String(row.id),
    type: String(row.type),
    payload: json(row.payload),
    createdAt: num(row.created_at),
  };
  if (row.tenant_id != null && row.tenant_id !== '') e.tenantId = String(row.tenant_id);
  if (row.idempotency_key != null) e.idempotencyKey = String(row.idempotency_key);
  return e;
}

function mapDelivery(row: Row): Delivery {
  const d: Delivery = {
    id: String(row.id),
    subscriptionId: String(row.subscription_id),
    eventId: String(row.event_id),
    status: row.status as Delivery['status'],
    attempts: num(row.attempts),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
  if (row.next_attempt_at != null) d.nextAttemptAt = num(row.next_attempt_at);
  if (row.last_status_code != null) d.lastStatusCode = num(row.last_status_code);
  if (row.last_error != null) d.lastError = String(row.last_error);
  return d;
}

export function createSqlStore(client: SqlClient, options: SqlStoreOptions = {}): WebhooksStore {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const j = (v: unknown) => JSON.stringify(v);

  return {
    async createSubscription(sub) {
      await client.query(
        `INSERT INTO ${p}subscriptions (
          id, url, description, status, event_types, payload_filter, secrets, tenant_id, owner_id,
          metadata, headers, consecutive_failures, disabled_reason, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          sub.id,
          sub.url,
          sub.description ?? null,
          sub.status,
          j(sub.eventTypes),
          sub.payloadFilter === undefined ? null : j(sub.payloadFilter),
          j(sub.secrets),
          sub.tenantId ?? null,
          sub.ownerId ?? null,
          j(sub.metadata),
          sub.headers === undefined ? null : j(sub.headers),
          sub.consecutiveFailures,
          sub.disabledReason ?? null,
          sub.createdAt,
          sub.updatedAt,
        ],
      );
      return sub;
    },
    async updateSubscription(id, patch) {
      const cur = await this.getSubscription(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      await client.query(
        `UPDATE ${p}subscriptions SET
          url=$2, description=$3, status=$4, event_types=$5, payload_filter=$6, secrets=$7,
          tenant_id=$8, owner_id=$9, metadata=$10, headers=$11, consecutive_failures=$12,
          disabled_reason=$13, updated_at=$14
         WHERE id=$1`,
        [
          id,
          next.url,
          next.description ?? null,
          next.status,
          j(next.eventTypes),
          next.payloadFilter === undefined ? null : j(next.payloadFilter),
          j(next.secrets),
          next.tenantId ?? null,
          next.ownerId ?? null,
          j(next.metadata),
          next.headers === undefined ? null : j(next.headers),
          next.consecutiveFailures,
          next.disabledReason ?? null,
          next.updatedAt,
        ],
      );
      return next;
    },
    async getSubscription(id) {
      const r = await client.query(`SELECT * FROM ${p}subscriptions WHERE id = $1`, [id]);
      return r.rows[0] ? mapSub(r.rows[0] as Row) : undefined;
    },
    async listSubscriptions(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.tenantId !== undefined) {
        params.push(query.tenantId);
        where.push(`tenant_id = $${params.length}`);
      }
      if (query.status !== undefined) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      params.push(query.limit + 1);
      const sql = `SELECT * FROM ${p}subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
      const r = await client.query(sql, params);
      const rows = r.rows.map((row) => mapSub(row as Row));
      if (query.cursor) {
        const idx = rows.findIndex((s) => s.id === query.cursor);
        const sliced = idx >= 0 ? rows.slice(idx + 1) : rows;
        const items = sliced.slice(0, query.limit);
        const last = items[items.length - 1];
        return sliced.length > query.limit && last ? { items, nextCursor: last.id } : { items };
      }
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return rows.length > query.limit && last ? { items, nextCursor: last.id } : { items };
    },
    async deleteSubscription(id) {
      const r = await client.query(`DELETE FROM ${p}subscriptions WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async createEvent(event) {
      try {
        await client.query(
          `INSERT INTO ${p}events (id, type, payload, tenant_id, idempotency_key, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            event.id,
            event.type,
            j(event.payload),
            event.tenantId ?? '',
            event.idempotencyKey ?? null,
            event.createdAt,
          ],
        );
        return { event, created: true };
      } catch (err) {
        if (event.idempotencyKey) {
          const existing = await this.findEventByIdempotency(event.tenantId, event.idempotencyKey);
          if (existing) return { event: existing, created: false };
        }
        throw err;
      }
    },
    async getEvent(id) {
      const r = await client.query(`SELECT * FROM ${p}events WHERE id = $1`, [id]);
      return r.rows[0] ? mapEvent(r.rows[0] as Row) : undefined;
    },
    async findEventByIdempotency(tenantId, key) {
      const r = await client.query(
        `SELECT * FROM ${p}events WHERE idempotency_key = $1 AND tenant_id = $2`,
        [key, tenantId ?? ''],
      );
      return r.rows[0] ? mapEvent(r.rows[0] as Row) : undefined;
    },
    async createDelivery(delivery) {
      await client.query(
        `INSERT INTO ${p}deliveries (
          id, subscription_id, event_id, status, attempts, next_attempt_at,
          last_status_code, last_error, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          delivery.id,
          delivery.subscriptionId,
          delivery.eventId,
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt ?? null,
          delivery.lastStatusCode ?? null,
          delivery.lastError ?? null,
          delivery.createdAt,
          delivery.updatedAt,
        ],
      );
      return delivery;
    },
    async getDelivery(id) {
      const r = await client.query(`SELECT * FROM ${p}deliveries WHERE id = $1`, [id]);
      return r.rows[0] ? mapDelivery(r.rows[0] as Row) : undefined;
    },
    async updateDelivery(id, patch) {
      const cur = await this.getDelivery(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      await client.query(
        `UPDATE ${p}deliveries SET status=$2, attempts=$3, next_attempt_at=$4,
          last_status_code=$5, last_error=$6, updated_at=$7 WHERE id=$1`,
        [
          id,
          next.status,
          next.attempts,
          next.nextAttemptAt ?? null,
          next.lastStatusCode ?? null,
          next.lastError ?? null,
          next.updatedAt,
        ],
      );
      return next;
    },
    async claimDelivery(id, now, staleBefore) {
      return client.transaction(async (tx) => {
        const r = await tx.query(`SELECT * FROM ${p}deliveries WHERE id = $1`, [id]);
        const row = r.rows[0] as Row | undefined;
        if (!row) return undefined;
        const cur = mapDelivery(row);
        if (cur.status === 'success' || cur.status === 'cancelled') return undefined;
        if (cur.status === 'sending' && cur.updatedAt >= staleBefore) return undefined;
        if (
          cur.status === 'pending' &&
          cur.nextAttemptAt !== undefined &&
          cur.nextAttemptAt > now
        ) {
          return undefined;
        }
        const next: Delivery = {
          ...cur,
          status: 'sending',
          attempts: cur.attempts + 1,
          updatedAt: now,
        };
        await tx.query(
          `UPDATE ${p}deliveries SET status=$2, attempts=$3, updated_at=$4 WHERE id=$1`,
          [id, next.status, next.attempts, next.updatedAt],
        );
        return next;
      });
    },
    async listDeliveries(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.subscriptionId) {
        params.push(query.subscriptionId);
        where.push(`subscription_id = $${params.length}`);
      }
      if (query.eventId) {
        params.push(query.eventId);
        where.push(`event_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      params.push(query.limit + 1);
      const r = await client.query(
        `SELECT * FROM ${p}deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const rows = r.rows.map((row) => mapDelivery(row as Row));
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return rows.length > query.limit && last ? { items, nextCursor: last.id } : { items };
    },
    async addAttempt(attempt) {
      await client.query(
        `INSERT INTO ${p}delivery_attempts (
          id, delivery_id, attempt, request_headers, response_status, response_body,
          duration_ms, error, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          attempt.id,
          attempt.deliveryId,
          attempt.attempt,
          j(attempt.requestHeaders),
          attempt.responseStatus ?? null,
          attempt.responseBody ?? null,
          attempt.durationMs,
          attempt.error ?? null,
          attempt.createdAt,
        ],
      );
    },
    async listAttempts(deliveryId) {
      const r = await client.query(
        `SELECT * FROM ${p}delivery_attempts WHERE delivery_id = $1 ORDER BY attempt ASC`,
        [deliveryId],
      );
      return r.rows.map((row) => {
        const a: DeliveryAttempt = {
          id: String((row as Row).id),
          deliveryId: String((row as Row).delivery_id),
          attempt: num((row as Row).attempt),
          requestHeaders: json((row as Row).request_headers),
          durationMs: num((row as Row).duration_ms),
          createdAt: num((row as Row).created_at),
        };
        if ((row as Row).response_status != null)
          a.responseStatus = num((row as Row).response_status);
        if ((row as Row).response_body != null) a.responseBody = String((row as Row).response_body);
        if ((row as Row).error != null) a.error = String((row as Row).error);
        return a;
      });
    },
    async listFailedDeliveries(subscriptionId, since, limit) {
      const r = await client.query(
        `SELECT * FROM ${p}deliveries WHERE subscription_id = $1 AND status = 'failed' AND created_at >= $2
         ORDER BY created_at ASC LIMIT $3`,
        [subscriptionId, since, limit],
      );
      return r.rows.map((row) => mapDelivery(row as Row));
    },
  };
}

export function createSqlSeenIdStore(
  client: SqlClient,
  options: SqlStoreOptions = {},
): SeenIdStore {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  return {
    async checkAndStore(id, expiresAt) {
      await client.query(`DELETE FROM ${p}seen_ids WHERE expires_at <= $1`, [Date.now()]);
      try {
        await client.query(`INSERT INTO ${p}seen_ids (id, expires_at) VALUES ($1, $2)`, [
          id,
          expiresAt,
        ]);
        return false;
      } catch {
        return true;
      }
    },
    async purge(now) {
      const r = await client.query(`DELETE FROM ${p}seen_ids WHERE expires_at <= $1`, [now]);
      return r.rowCount;
    },
  };
}
