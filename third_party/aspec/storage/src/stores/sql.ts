import { configError, StorageError } from '../errors.js';
import type { SqlClient, SqlDialect } from '../ports.js';
import type {
  CommitUpdate,
  FileMetadata,
  FileRecord,
  FileUpdate,
  ListFilesQuery,
  ListFilesResult,
  QuotaScope,
  QuotaUsage,
  ReservationRequest,
  SessionLockRequest,
  SessionLockResult,
  SessionPatch,
  StorageMetadataStore,
  UploadSession,
} from '../types.js';
import {
  computeReservation,
  decodeCursor,
  encodeCursor,
  normalizeListLimit,
  scopesOf,
  type UsageSnapshot,
} from './shared.js';

export type { SqlClient, SqlDialect, SqlQueryResult } from '../ports.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlStoreOptions {
  /** Table name prefix (default `storage_`). Must match /^[a-z][a-z0-9_]{0,30}$/. */
  tablePrefix?: string;
}

const DEFAULT_PREFIX = 'storage_';
const MIGRATION_LOCK_ID = 0x53544f52; // "STOR"

function checkPrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) {
    configError('tablePrefix', 'must match /^[a-z][a-z0-9_]{0,30}$/');
  }
  return prefix;
}

/** Migrations for a given table prefix. */
export function buildMigrations(tablePrefix: string = DEFAULT_PREFIX): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  const files = (int: string, json: string) => `CREATE TABLE IF NOT EXISTS ${p}files (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  declared_type TEXT,
  detected_type TEXT,
  size ${int} NOT NULL,
  sha256 TEXT,
  owner_id TEXT,
  tenant_id TEXT,
  visibility TEXT NOT NULL,
  metadata ${json} NOT NULL,
  status TEXT NOT NULL,
  reserved_bytes ${int} NOT NULL DEFAULT 0,
  expires_at ${int},
  created_at ${int} NOT NULL,
  updated_at ${int} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}files_owner_idx ON ${p}files (owner_id, created_at, id);
CREATE INDEX IF NOT EXISTS ${p}files_tenant_idx ON ${p}files (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS ${p}files_pending_idx ON ${p}files (status, expires_at);
CREATE TABLE IF NOT EXISTS ${p}upload_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  upload_length ${int} NOT NULL,
  upload_offset ${int} NOT NULL DEFAULT 0,
  driver_state ${json} NOT NULL,
  lock_token TEXT,
  locked_until ${int},
  expires_at ${int} NOT NULL,
  created_at ${int} NOT NULL,
  updated_at ${int} NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}quota_usage (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bytes_used ${int} NOT NULL DEFAULT 0,
  files_used ${int} NOT NULL DEFAULT 0,
  bytes_reserved ${int} NOT NULL DEFAULT 0,
  files_reserved ${int} NOT NULL DEFAULT 0,
  updated_at ${int} NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);`;
  return [
    {
      id: '0001_initial',
      postgres: files('BIGINT', 'JSONB'),
      sqlite: files('INTEGER', 'TEXT'),
    },
  ];
}

/** Migrations for the default `storage_` prefix. */
export const migrations: readonly Migration[] = buildMigrations();

/**
 * Applies pending migrations idempotently inside one transaction, recording them in
 * `<prefix>schema_migrations`. On PostgreSQL an advisory lock serialises concurrent runs.
 */
export async function migrate(client: SqlClient, options: SqlStoreOptions = {}): Promise<void> {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_PREFIX);
  const list = buildMigrations(p);
  await client.transaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    }
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${
        tx.dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
      } NOT NULL)`,
    );
    const applied = await tx.query<{ id: string }>(`SELECT id FROM ${p}schema_migrations`);
    const done = new Set(applied.rows.map((r) => r.id));
    for (const m of list) {
      if (done.has(m.id)) continue;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        m.id,
        Date.now(),
      ]);
    }
  });
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const optStr = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);
const optNum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : num(v);

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

function toFile(r: Row): FileRecord {
  const file: FileRecord = {
    id: String(r.id),
    key: String(r.object_key),
    filename: String(r.filename),
    contentType: String(r.content_type),
    size: num(r.size),
    visibility: r.visibility === 'public' ? 'public' : 'private',
    metadata: json<FileMetadata>(r.metadata, {}),
    status: r.status === 'ready' ? 'ready' : 'pending',
    reservedBytes: num(r.reserved_bytes),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const declared = optStr(r.declared_type);
  if (declared !== undefined) file.declaredType = declared;
  const detected = optStr(r.detected_type);
  if (detected !== undefined) file.detectedType = detected;
  const sha = optStr(r.sha256);
  if (sha !== undefined) file.sha256 = sha;
  const owner = optStr(r.owner_id);
  if (owner !== undefined) file.ownerId = owner;
  const tenant = optStr(r.tenant_id);
  if (tenant !== undefined) file.tenantId = tenant;
  const expires = optNum(r.expires_at);
  if (expires !== undefined) file.expiresAt = expires;
  return file;
}

function toSession(r: Row): UploadSession {
  const s: UploadSession = {
    id: String(r.id),
    kind: r.kind === 'signed-put' ? 'signed-put' : 'resumable',
    uploadLength: num(r.upload_length),
    uploadOffset: num(r.upload_offset),
    driverState: json<Record<string, unknown>>(r.driver_state, {}),
    expiresAt: num(r.expires_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const token = optStr(r.lock_token);
  if (token !== undefined) s.lockToken = token;
  const until = optNum(r.locked_until);
  if (until !== undefined) s.lockedUntil = until;
  return s;
}

function toUsage(r: Row | undefined): UsageSnapshot {
  return {
    bytesUsed: num(r?.bytes_used ?? 0),
    filesUsed: num(r?.files_used ?? 0),
    bytesReserved: num(r?.bytes_reserved ?? 0),
    filesReserved: num(r?.files_reserved ?? 0),
  };
}

const FILE_COLUMNS =
  'id, object_key, filename, content_type, declared_type, detected_type, size, sha256, owner_id, tenant_id, visibility, metadata, status, reserved_bytes, expires_at, created_at, updated_at';
const SESSION_COLUMNS =
  'id, kind, upload_length, upload_offset, driver_state, lock_token, locked_until, expires_at, created_at, updated_at';

/**
 * SQL metadata store for PostgreSQL and SQLite built on the SqlClient port. Run migrate()
 * first. Quota changes run in transactions; PostgreSQL rows are locked with FOR UPDATE.
 */
export function createSqlMetadataStore(
  client: SqlClient,
  options: SqlStoreOptions = {},
): StorageMetadataStore {
  if (!client || typeof client.query !== 'function' || typeof client.transaction !== 'function') {
    configError('client', 'a SqlClient is required');
  }
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_PREFIX);
  const files = `${p}files`;
  const sessions = `${p}upload_sessions`;
  const quota = `${p}quota_usage`;
  const forUpdate = (d: SqlDialect) => (d === 'postgres' ? ' FOR UPDATE' : '');

  async function getFile(db: SqlClient, id: string, lock = false): Promise<FileRecord | undefined> {
    const r = await db.query<Row>(
      `SELECT ${FILE_COLUMNS} FROM ${files} WHERE id = $1${lock ? forUpdate(db.dialect) : ''}`,
      [id],
    );
    const row = r.rows[0];
    return row ? toFile(row) : undefined;
  }

  async function adjustUsage(
    db: SqlClient,
    scope: QuotaScope,
    delta: { reservedBytes: number; reservedFiles: number; usedBytes: number; usedFiles: number },
    now: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO ${quota} (scope_type, scope_id, bytes_used, files_used, bytes_reserved, files_reserved, updated_at)
       VALUES ($1, $2, 0, 0, 0, 0, $3) ON CONFLICT (scope_type, scope_id) DO NOTHING`,
      [scope.type, scope.id, now],
    );
    await db.query(
      `UPDATE ${quota} SET
         bytes_reserved = CASE WHEN bytes_reserved + $3 < 0 THEN 0 ELSE bytes_reserved + $3 END,
         files_reserved = CASE WHEN files_reserved + $4 < 0 THEN 0 ELSE files_reserved + $4 END,
         bytes_used = CASE WHEN bytes_used + $5 < 0 THEN 0 ELSE bytes_used + $5 END,
         files_used = CASE WHEN files_used + $6 < 0 THEN 0 ELSE files_used + $6 END,
         updated_at = $7
       WHERE scope_type = $1 AND scope_id = $2`,
      [
        scope.type,
        scope.id,
        delta.reservedBytes,
        delta.reservedFiles,
        delta.usedBytes,
        delta.usedFiles,
        now,
      ],
    );
  }

  return {
    async insertPending(
      file: FileRecord,
      reservation: ReservationRequest,
      session?: UploadSession,
    ) {
      return client.transaction(async (tx) => {
        const scopes = scopesOf(file);
        const usage: UsageSnapshot[] = [];
        for (const scope of scopes) {
          await tx.query(
            `INSERT INTO ${quota} (scope_type, scope_id, bytes_used, files_used, bytes_reserved, files_reserved, updated_at)
             VALUES ($1, $2, 0, 0, 0, 0, $3) ON CONFLICT (scope_type, scope_id) DO NOTHING`,
            [scope.type, scope.id, file.createdAt],
          );
          const r = await tx.query<Row>(
            `SELECT bytes_used, files_used, bytes_reserved, files_reserved FROM ${quota}
             WHERE scope_type = $1 AND scope_id = $2${forUpdate(tx.dialect)}`,
            [scope.type, scope.id],
          );
          usage.push(toUsage(r.rows[0]));
        }
        const reservedBytes = computeReservation(reservation, scopes, usage);
        for (const scope of scopes) {
          await adjustUsage(
            tx,
            scope,
            { reservedBytes, reservedFiles: 1, usedBytes: 0, usedFiles: 0 },
            file.createdAt,
          );
        }
        await tx.query(
          `INSERT INTO ${files} (${FILE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            file.id,
            file.key,
            file.filename,
            file.contentType,
            file.declaredType ?? null,
            file.detectedType ?? null,
            file.size,
            file.sha256 ?? null,
            file.ownerId ?? null,
            file.tenantId ?? null,
            file.visibility,
            JSON.stringify(file.metadata),
            'pending',
            reservedBytes,
            file.expiresAt ?? null,
            file.createdAt,
            file.updatedAt,
          ],
        );
        if (session) {
          await tx.query(
            `INSERT INTO ${sessions} (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              session.id,
              session.kind,
              session.uploadLength,
              session.uploadOffset,
              JSON.stringify(session.driverState),
              session.lockToken ?? null,
              session.lockedUntil ?? null,
              session.expiresAt,
              session.createdAt,
              session.updatedAt,
            ],
          );
        }
        return { reservedBytes };
      });
    },

    async commit(id: string, update: CommitUpdate) {
      return client.transaction(async (tx) => {
        const file = await getFile(tx, id, true);
        if (!file || file.status !== 'pending') throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
        for (const scope of scopesOf(file)) {
          await adjustUsage(
            tx,
            scope,
            {
              reservedBytes: -file.reservedBytes,
              reservedFiles: -1,
              usedBytes: update.size,
              usedFiles: 1,
            },
            update.updatedAt,
          );
        }
        await tx.query(
          `UPDATE ${files} SET status = 'ready', size = $2, sha256 = $3, content_type = $4, detected_type = $5,
             reserved_bytes = 0, expires_at = NULL, updated_at = $6
           WHERE id = $1 AND status = 'pending'`,
          [
            id,
            update.size,
            update.sha256,
            update.contentType,
            update.detectedType ?? null,
            update.updatedAt,
          ],
        );
        await tx.query(`DELETE FROM ${sessions} WHERE id = $1`, [id]);
        const next = await getFile(tx, id);
        if (!next) throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
        return next;
      });
    },

    async release(id: string) {
      return client.transaction(async (tx) => {
        const file = await getFile(tx, id, true);
        if (!file || file.status !== 'pending') return undefined;
        const now = Date.now();
        for (const scope of scopesOf(file)) {
          await adjustUsage(
            tx,
            scope,
            { reservedBytes: -file.reservedBytes, reservedFiles: -1, usedBytes: 0, usedFiles: 0 },
            now,
          );
        }
        await tx.query(`DELETE FROM ${files} WHERE id = $1 AND status = 'pending'`, [id]);
        await tx.query(`DELETE FROM ${sessions} WHERE id = $1`, [id]);
        return file;
      });
    },

    async get(id: string) {
      return getFile(client, id);
    },

    async list(query: ListFilesQuery): Promise<ListFilesResult> {
      const limit = normalizeListLimit(query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: (n: string) => string, value: unknown) => {
        params.push(value);
        where.push(clause(`$${params.length}`));
      };
      if (query.ownerId !== undefined) add((n) => `owner_id = ${n}`, query.ownerId);
      if (query.tenantId !== undefined) add((n) => `tenant_id = ${n}`, query.tenantId);
      const status = query.status ?? 'ready';
      if (status !== 'all') add((n) => `status = ${n}`, status);
      if (query.cursor !== undefined) {
        const c = decodeCursor(query.cursor);
        params.push(c.createdAt, c.id);
        const a = `$${params.length - 1}`;
        const b = `$${params.length}`;
        where.push(`(created_at < ${a} OR (created_at = ${a} AND id < ${b}))`);
      }
      params.push(limit + 1);
      const sql = `SELECT ${FILE_COLUMNS} FROM ${files}${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
      const r = await client.query<Row>(sql, params);
      const all = r.rows.map(toFile);
      const items = all.slice(0, limit);
      const result: ListFilesResult = { items };
      const last = items[items.length - 1];
      if (all.length > limit && last) result.nextCursor = encodeCursor(last);
      return result;
    },

    async update(id: string, patch: FileUpdate) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.filename !== undefined) set('filename', patch.filename);
      if (patch.visibility !== undefined) set('visibility', patch.visibility);
      if (patch.metadata !== undefined) set('metadata', JSON.stringify(patch.metadata));
      set('updated_at', patch.updatedAt);
      const r = await client.query(`UPDATE ${files} SET ${sets.join(', ')} WHERE id = $1`, params);
      if (r.rowCount === 0) return undefined;
      return getFile(client, id);
    },

    async remove(id: string) {
      return client.transaction(async (tx) => {
        const file = await getFile(tx, id, true);
        if (!file || file.status !== 'ready') return undefined;
        const r = await tx.query(`DELETE FROM ${files} WHERE id = $1 AND status = 'ready'`, [id]);
        if (r.rowCount === 0) return undefined;
        const now = Date.now();
        for (const scope of scopesOf(file)) {
          await adjustUsage(
            tx,
            scope,
            { reservedBytes: 0, reservedFiles: 0, usedBytes: -file.size, usedFiles: -1 },
            now,
          );
        }
        return file;
      });
    },

    async usage(scope: QuotaScope): Promise<QuotaUsage> {
      const r = await client.query<Row>(
        `SELECT bytes_used, files_used, bytes_reserved, files_reserved FROM ${quota} WHERE scope_type = $1 AND scope_id = $2`,
        [scope.type, scope.id],
      );
      return { scope: { ...scope }, ...toUsage(r.rows[0]) };
    },

    async getSession(id: string) {
      const r = await client.query<Row>(
        `SELECT ${SESSION_COLUMNS} FROM ${sessions} WHERE id = $1`,
        [id],
      );
      const row = r.rows[0];
      return row ? toSession(row) : undefined;
    },

    async lockSession(id: string, req: SessionLockRequest): Promise<SessionLockResult> {
      const r = await client.query(
        `UPDATE ${sessions} SET lock_token = $2, locked_until = $3
         WHERE id = $1 AND upload_offset = $4 AND (lock_token IS NULL OR locked_until < $5)`,
        [id, req.token, req.until, req.expectedOffset, req.now],
      );
      if (r.rowCount === 1) return 'locked';
      const s = await this.getSession(id);
      if (!s) return 'not_found';
      if (s.uploadOffset !== req.expectedOffset) return 'offset_mismatch';
      return 'busy';
    },

    async updateSession(id: string, patch: SessionPatch, lockToken?: string) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.uploadOffset !== undefined) set('upload_offset', patch.uploadOffset);
      if (patch.driverState !== undefined) set('driver_state', JSON.stringify(patch.driverState));
      if (patch.lockedUntil !== undefined) set('locked_until', patch.lockedUntil);
      set('updated_at', patch.updatedAt);
      let sql = `UPDATE ${sessions} SET ${sets.join(', ')} WHERE id = $1`;
      if (lockToken !== undefined) {
        params.push(lockToken);
        sql += ` AND lock_token = $${params.length}`;
      }
      const r = await client.query(sql, params);
      return r.rowCount === 1;
    },

    async unlockSession(id: string, lockToken: string) {
      await client.query(
        `UPDATE ${sessions} SET lock_token = NULL, locked_until = NULL WHERE id = $1 AND lock_token = $2`,
        [id, lockToken],
      );
    },

    async listExpired(now: number, limit: number) {
      const r = await client.query<Row>(
        `SELECT ${FILE_COLUMNS} FROM ${files}
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
         ORDER BY expires_at ASC LIMIT $2`,
        [now, limit],
      );
      return r.rows.map(toFile);
    },

    async ping() {
      await client.query('SELECT 1');
    },
  };
}
