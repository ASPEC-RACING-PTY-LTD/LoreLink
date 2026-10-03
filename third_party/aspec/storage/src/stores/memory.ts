import { configError, StorageError } from '../errors.js';
import type {
  CommitUpdate,
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
} from './shared.js';

export interface MemoryMetadataStoreOptions {
  /** Maximum number of file records (pending and ready). Default 10000. */
  maxRecords?: number;
}

interface UsageRow {
  bytesUsed: number;
  filesUsed: number;
  bytesReserved: number;
  filesReserved: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory metadata store for tests, development and single-process deployments without
 * durable metadata. Every mutation is synchronous, so quota updates are atomic.
 */
export function createMemoryMetadataStore(
  options: MemoryMetadataStoreOptions = {},
): StorageMetadataStore {
  const maxRecords = options.maxRecords ?? 10_000;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    configError('maxRecords', 'must be a positive integer');
  }
  const files = new Map<string, FileRecord>();
  const sessions = new Map<string, UploadSession>();
  const usageRows = new Map<string, UsageRow>();

  const usageKey = (scope: QuotaScope) => `${scope.type}\u0000${scope.id}`;
  const row = (scope: QuotaScope): UsageRow => {
    const k = usageKey(scope);
    let r = usageRows.get(k);
    if (!r) {
      r = { bytesUsed: 0, filesUsed: 0, bytesReserved: 0, filesReserved: 0 };
      usageRows.set(k, r);
    }
    return r;
  };

  return {
    async insertPending(file, reservation: ReservationRequest, session?: UploadSession) {
      if (files.has(file.id)) {
        throw new StorageError('STORAGE_INTERNAL', { message: 'Duplicate file ID' });
      }
      if (files.size >= maxRecords) throw new StorageError('STORAGE_STORE_FULL');
      const scopes = scopesOf(file);
      const reservedBytes = computeReservation(
        reservation,
        scopes,
        scopes.map((scope) => ({ ...row(scope) })),
      );
      for (const scope of scopes) {
        const r = row(scope);
        r.bytesReserved += reservedBytes;
        r.filesReserved += 1;
      }
      files.set(file.id, clone({ ...file, reservedBytes }));
      if (session) sessions.set(session.id, clone(session));
      return { reservedBytes };
    },

    async commit(id: string, update: CommitUpdate) {
      const file = files.get(id);
      if (!file || file.status !== 'pending') throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
      for (const scope of scopesOf(file)) {
        const r = row(scope);
        r.bytesReserved = Math.max(0, r.bytesReserved - file.reservedBytes);
        r.filesReserved = Math.max(0, r.filesReserved - 1);
        r.bytesUsed += update.size;
        r.filesUsed += 1;
      }
      const next: FileRecord = {
        ...file,
        size: update.size,
        sha256: update.sha256,
        contentType: update.contentType,
        status: 'ready',
        reservedBytes: 0,
        updatedAt: update.updatedAt,
      };
      if (update.detectedType !== undefined) next.detectedType = update.detectedType;
      else delete next.detectedType;
      delete next.expiresAt;
      files.set(id, next);
      sessions.delete(id);
      return clone(next);
    },

    async release(id: string) {
      const file = files.get(id);
      if (!file || file.status !== 'pending') return undefined;
      for (const scope of scopesOf(file)) {
        const r = row(scope);
        r.bytesReserved = Math.max(0, r.bytesReserved - file.reservedBytes);
        r.filesReserved = Math.max(0, r.filesReserved - 1);
      }
      files.delete(id);
      sessions.delete(id);
      return clone(file);
    },

    async get(id: string) {
      const file = files.get(id);
      return file ? clone(file) : undefined;
    },

    async list(query: ListFilesQuery): Promise<ListFilesResult> {
      const limit = normalizeListLimit(query.limit);
      const status = query.status ?? 'ready';
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const matches = [...files.values()]
        .filter(
          (f) =>
            (query.ownerId === undefined || f.ownerId === query.ownerId) &&
            (query.tenantId === undefined || f.tenantId === query.tenantId) &&
            (status === 'all' || f.status === status) &&
            (cursor === undefined ||
              f.createdAt < cursor.createdAt ||
              (f.createdAt === cursor.createdAt && f.id < cursor.id)),
        )
        .sort((a, b) =>
          b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? 1 : -1,
        );
      const items = matches.slice(0, limit).map(clone);
      const last = items[items.length - 1];
      const result: ListFilesResult = { items };
      if (matches.length > limit && last) result.nextCursor = encodeCursor(last);
      return result;
    },

    async update(id: string, patch: FileUpdate) {
      const file = files.get(id);
      if (!file) return undefined;
      const next: FileRecord = { ...file, updatedAt: patch.updatedAt };
      if (patch.filename !== undefined) next.filename = patch.filename;
      if (patch.visibility !== undefined) next.visibility = patch.visibility;
      if (patch.metadata !== undefined) next.metadata = clone(patch.metadata);
      files.set(id, next);
      return clone(next);
    },

    async remove(id: string) {
      const file = files.get(id);
      if (!file || file.status !== 'ready') return undefined;
      for (const scope of scopesOf(file)) {
        const r = row(scope);
        r.bytesUsed = Math.max(0, r.bytesUsed - file.size);
        r.filesUsed = Math.max(0, r.filesUsed - 1);
      }
      files.delete(id);
      return clone(file);
    },

    async usage(scope: QuotaScope): Promise<QuotaUsage> {
      const r = usageRows.get(usageKey(scope));
      return {
        scope: { ...scope },
        bytesUsed: r?.bytesUsed ?? 0,
        filesUsed: r?.filesUsed ?? 0,
        bytesReserved: r?.bytesReserved ?? 0,
        filesReserved: r?.filesReserved ?? 0,
      };
    },

    async getSession(id: string) {
      const s = sessions.get(id);
      return s ? clone(s) : undefined;
    },

    async lockSession(id: string, req: SessionLockRequest): Promise<SessionLockResult> {
      const s = sessions.get(id);
      if (!s) return 'not_found';
      if (s.uploadOffset !== req.expectedOffset) return 'offset_mismatch';
      if (s.lockToken !== undefined && (s.lockedUntil ?? 0) >= req.now) return 'busy';
      s.lockToken = req.token;
      s.lockedUntil = req.until;
      return 'locked';
    },

    async updateSession(id: string, patch: SessionPatch, lockToken?: string) {
      const s = sessions.get(id);
      if (!s) return false;
      if (lockToken !== undefined && s.lockToken !== lockToken) return false;
      if (patch.uploadOffset !== undefined) s.uploadOffset = patch.uploadOffset;
      if (patch.driverState !== undefined) s.driverState = clone(patch.driverState);
      if (patch.lockedUntil !== undefined) s.lockedUntil = patch.lockedUntil;
      s.updatedAt = patch.updatedAt;
      return true;
    },

    async unlockSession(id: string, lockToken: string) {
      const s = sessions.get(id);
      if (s && s.lockToken === lockToken) {
        delete s.lockToken;
        delete s.lockedUntil;
      }
    },

    async listExpired(now: number, limit: number) {
      const out: FileRecord[] = [];
      for (const f of files.values()) {
        if (f.status === 'pending' && f.expiresAt !== undefined && f.expiresAt <= now) {
          out.push(clone(f));
          if (out.length >= limit) break;
        }
      }
      return out;
    },

    async ping() {},
  };
}
