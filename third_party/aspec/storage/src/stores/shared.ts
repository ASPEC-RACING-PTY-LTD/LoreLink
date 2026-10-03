import { StorageError } from '../errors.js';
import type { FileRecord, QuotaScope, ReservationRequest } from '../types.js';

export interface UsageSnapshot {
  bytesUsed: number;
  filesUsed: number;
  bytesReserved: number;
  filesReserved: number;
}

/** Quota scopes of a file in a fixed order (owner, then tenant) to keep lock order stable. */
export function scopesOf(file: Pick<FileRecord, 'ownerId' | 'tenantId'>): QuotaScope[] {
  const out: QuotaScope[] = [];
  if (file.ownerId !== undefined) out.push({ type: 'owner', id: file.ownerId });
  if (file.tenantId !== undefined) out.push({ type: 'tenant', id: file.tenantId });
  return out;
}

/**
 * Decides how many bytes to reserve given current usage per scope (same order as scopes).
 * Throws STORAGE_QUOTA_EXCEEDED when the file count or an exact byte reservation does not fit.
 */
export function computeReservation(
  request: ReservationRequest,
  scopes: readonly QuotaScope[],
  usage: readonly UsageSnapshot[],
): number {
  let bytes = request.bytes;
  scopes.forEach((scope, i) => {
    const limit = request.limits[scope.type];
    const u = usage[i];
    if (!limit || !u) return;
    if (limit.maxFiles !== undefined && u.filesUsed + u.filesReserved + 1 > limit.maxFiles) {
      throw new StorageError('STORAGE_QUOTA_EXCEEDED', {
        message: `The ${scope.type} file count quota is exceeded`,
        details: { scope: scope.type, limit: 'files' },
      });
    }
    if (limit.maxBytes !== undefined) {
      const remaining = Math.max(0, limit.maxBytes - u.bytesUsed - u.bytesReserved);
      if (request.exact && request.bytes > remaining) {
        throw new StorageError('STORAGE_QUOTA_EXCEEDED', {
          message: `The ${scope.type} storage quota is exceeded`,
          details: { scope: scope.type, limit: 'bytes' },
        });
      }
      bytes = Math.min(bytes, remaining);
    }
  });
  return bytes;
}

export function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new StorageError('STORAGE_VALIDATION_FAILED', {
      message: 'limit must be an integer from 1 to 1000',
    });
  }
  return limit;
}

export function encodeCursor(file: Pick<FileRecord, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([file.createdAt, file.id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length <= 128
    ) {
      return { createdAt: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Invalid cursor' });
}
