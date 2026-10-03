import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { configError, StorageError } from './errors.js';
import { uuidv7 } from './ids.js';
import {
  extensionOf,
  isCompatibleType,
  isInlineSafeType,
  isSniffableType,
  matchesTypePattern,
  normalizeContentType,
  OCTET_STREAM,
  sniffContentType,
  typeForExtension,
} from './mime.js';
import type {
  AuditSink,
  Clock,
  HealthCheckable,
  HealthCheckResult,
  IdGenerator,
  LoggerLike,
  PermissionChecker,
  Subject,
} from './ports.js';
import {
  type ContentDispositionType,
  normalizeSecrets,
  SIGNED_URL_PARAMS,
  type SignedMethod,
  signClaims,
  verifyClaims,
} from './signing.js';
import {
  hashStream,
  InspectorStream,
  toReadable,
  type UploadBody,
  VerifyingStream,
} from './streams.js';
import type {
  ByteRange,
  FileMetadata,
  FileRecord,
  FileVisibility,
  ListFilesQuery,
  ListFilesResult,
  QuotaLimit,
  QuotaScope,
  QuotaUsage,
  StorageDriver,
  StorageMetadataStore,
} from './types.js';
import {
  DEFAULT_METADATA_LIMITS,
  isValidId,
  type MetadataLimits,
  sanitizeFilename,
  validateKey,
  validateMetadata,
} from './validation.js';

export type StorageAction = 'read' | 'write' | 'delete';

export interface StorageAuthorizeContext {
  action: StorageAction;
  file: FileRecord;
  actor?: Subject;
}

export type StorageAuthorize = (ctx: StorageAuthorizeContext) => boolean | Promise<boolean>;

export interface ValidationOptions {
  /** Maximum upload size in bytes. Default 25 MiB. */
  maxBytes?: number;
  /** Allowed MIME patterns (for example `image/*`, `application/pdf`). Default: any. */
  allowedTypes?: readonly string[];
  /** When true, reject uploads whose sniffed type disagrees with the declared type or extension. Default true. */
  enforceTypeConsistency?: boolean;
  /** When true, reject scriptable types (SVG, HTML) unless explicitly allowed. Default true. */
  rejectScriptable?: boolean;
  metadataLimits?: Partial<MetadataLimits>;
}

export interface QuotaOptions {
  owner?: QuotaLimit;
  tenant?: QuotaLimit;
}

export interface StorageOptions {
  driver: StorageDriver;
  metadata: StorageMetadataStore;
  validation?: ValidationOptions;
  quotas?: QuotaOptions;
  /** Custom authoriser. Takes precedence over `permissions`. */
  authorize?: StorageAuthorize;
  /** PermissionChecker for `files:read`, `files:write`, `files:delete`. */
  permissions?: PermissionChecker;
  /**
   * HMAC secret(s) for adapter signed URLs. Required for `createSignedUrl` when the driver
   * has no native `presign`. At least 32 bytes each.
   */
  signingSecret?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  audit?: AuditSink;
  /** How long resumable sessions live, in milliseconds. Default 24 hours. */
  uploadSessionTtlMs?: number;
  /** Key prefix for generated object keys (validated). Default empty. */
  keyPrefix?: string;
}

export interface UploadInput {
  body: UploadBody;
  filename?: string;
  contentType?: string;
  ownerId?: string;
  tenantId?: string;
  visibility?: FileVisibility;
  metadata?: unknown;
  /** Trusted object key. When omitted a key is generated from the file ID. */
  key?: string;
  actor?: Subject;
  signal?: AbortSignal;
  /** Expected size for exact quota reservation. When omitted, reserves maxBytes. */
  expectedSize?: number;
}

export interface DownloadResult {
  file: FileRecord;
  body: NodeJS.ReadableStream;
  range?: ByteRange;
  contentLength: number;
  contentType: string;
  contentDisposition: string;
}

export interface SignedUrlOptions {
  fileId: string;
  method?: SignedMethod;
  /** Lifetime in seconds (1 to 604800). Default 900. */
  expiresInSeconds?: number;
  disposition?: ContentDispositionType;
  actor?: Subject;
  /** Base URL used to build adapter signed URLs (for example https://app.example/files). */
  baseUrl: string;
}

export interface CreateUploadSessionInput {
  uploadLength: number;
  filename?: string;
  contentType?: string;
  ownerId?: string;
  tenantId?: string;
  visibility?: FileVisibility;
  metadata?: unknown;
  actor?: Subject;
}

export interface AppendUploadInput {
  uploadId: string;
  body: UploadBody;
  offset: number;
  checksumSha256?: string;
  actor?: Subject;
  signal?: AbortSignal;
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const systemClock: Clock = { now: () => Date.now() };
const DAY = 86_400_000;
const PERM: Record<StorageAction, string> = {
  read: 'files:read',
  write: 'files:write',
  delete: 'files:delete',
};

function contentDispositionHeader(
  filename: string,
  disposition: ContentDispositionType | undefined,
  contentType: string,
): string {
  const kind = disposition ?? (isInlineSafeType(contentType) ? 'inline' : 'attachment');
  const safe = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${kind}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

function parseRangeHeader(value: string | undefined, size: number): ByteRange | undefined {
  if (!value) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!m) {
    throw new StorageError('STORAGE_RANGE_NOT_SATISFIABLE', { message: 'Invalid Range header' });
  }
  let start = m[1] === '' ? undefined : Number(m[1]);
  let end = m[2] === '' ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) {
    throw new StorageError('STORAGE_RANGE_NOT_SATISFIABLE');
  }
  if (start === undefined && end !== undefined) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (start !== undefined && end === undefined) {
    end = size - 1;
  }
  if (
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new StorageError('STORAGE_RANGE_NOT_SATISFIABLE');
  }
  return { start, end: Math.min(end, size - 1) };
}

export interface Storage extends HealthCheckable {
  readonly driver: StorageDriver;
  readonly metadata: StorageMetadataStore;
  upload(input: UploadInput): Promise<FileRecord>;
  download(options: {
    fileId: string;
    range?: ByteRange | string;
    verify?: boolean;
    disposition?: ContentDispositionType;
    actor?: Subject;
    /** When true, skip authorise (used after a verified signed URL). */
    bypassAuthorize?: boolean;
  }): Promise<DownloadResult>;
  get(fileId: string, actor?: Subject): Promise<FileRecord>;
  list(query: ListFilesQuery & { actor?: Subject }): Promise<ListFilesResult>;
  update(
    fileId: string,
    patch: { filename?: string; visibility?: FileVisibility; metadata?: unknown },
    actor?: Subject,
  ): Promise<FileRecord>;
  delete(fileId: string, actor?: Subject): Promise<void>;
  deleteByOwner(ownerId: string, actor?: Subject): Promise<{ deleted: number }>;
  usage(scope: QuotaScope): Promise<QuotaUsage>;
  verify(fileId: string, actor?: Subject): Promise<{ ok: true; sha256: string; size: number }>;
  createSignedUrl(options: SignedUrlOptions): Promise<{ url: string; expiresAt: Date }>;
  /** Verifies adapter HMAC signed URL query parameters against the stored file key. */
  verifySignedUrl(options: {
    method: string;
    fileId: string;
    query: URLSearchParams;
  }): Promise<{ file: FileRecord; disposition?: ContentDispositionType }>;
  createUploadSession(input: CreateUploadSessionInput): Promise<{
    session: { id: string; uploadLength: number; uploadOffset: number; expiresAt: Date };
    file: FileRecord;
  }>;
  getUploadOffset(
    uploadId: string,
    actor?: Subject,
  ): Promise<{ uploadOffset: number; uploadLength: number; expiresAt: Date }>;
  appendUpload(input: AppendUploadInput): Promise<{ uploadOffset: number }>;
  completeUpload(uploadId: string, actor?: Subject): Promise<FileRecord>;
  abortUpload(uploadId: string, actor?: Subject): Promise<void>;
  cleanupExpired(): Promise<{ released: number }>;
}

export function createStorage(options: StorageOptions): Storage {
  if (!options || typeof options !== 'object') configError('options', 'must be an object');
  if (!options.driver || typeof options.driver.put !== 'function') {
    configError('driver', 'must implement StorageDriver');
  }
  if (!options.metadata || typeof options.metadata.insertPending !== 'function') {
    configError('metadata', 'must implement StorageMetadataStore');
  }
  const driver = options.driver;
  const store = options.metadata;
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? (() => uuidv7(clock.now()));
  const audit = options.audit;
  const maxBytes = options.validation?.maxBytes ?? 25 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    configError('validation.maxBytes', 'must be a positive integer');
  }
  const allowedTypes = options.validation?.allowedTypes;
  const enforceTypeConsistency = options.validation?.enforceTypeConsistency ?? true;
  const rejectScriptable = options.validation?.rejectScriptable ?? true;
  const metadataLimits: MetadataLimits = {
    ...DEFAULT_METADATA_LIMITS,
    ...options.validation?.metadataLimits,
  };
  const quotas = options.quotas ?? {};
  const sessionTtlMs = options.uploadSessionTtlMs ?? DAY;
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1000) {
    configError('uploadSessionTtlMs', 'must be an integer of at least 1000');
  }
  const keyPrefix = options.keyPrefix ?? '';
  if (keyPrefix !== '') {
    if (!keyPrefix.endsWith('/')) configError('keyPrefix', 'must end with /');
    validateKey(keyPrefix.slice(0, -1));
  }
  const secrets =
    options.signingSecret === undefined ? undefined : normalizeSecrets(options.signingSecret);
  const authorizeFn = options.authorize;
  const permissions = options.permissions;

  const auditSafe = async (
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    file?: FileRecord,
    actor?: Subject,
  ): Promise<void> => {
    if (!audit) return;
    try {
      const event: import('./ports.js').AuditEventInput = {
        action,
        outcome,
        resource: file ? { type: 'file', id: file.id } : { type: 'file' },
        category: 'data',
      };
      if (actor) {
        event.actor =
          actor.type !== undefined ? { id: actor.id, type: actor.type } : { id: actor.id };
      }
      if (file?.tenantId !== undefined) event.tenantId = file.tenantId;
      await audit.record(event);
    } catch (err) {
      logger.warn({ err: String(err) }, 'storage: audit sink failed');
    }
  };

  const authorize = async (
    action: StorageAction,
    file: FileRecord,
    actor?: Subject,
  ): Promise<void> => {
    if (authorizeFn) {
      const ctx: StorageAuthorizeContext = { action, file };
      if (actor) ctx.actor = actor;
      if ((await authorizeFn(ctx)) === true) return;
      await auditSafe(`storage.${action}`, 'denied', file, actor);
      throw new StorageError('STORAGE_FORBIDDEN');
    }
    if (permissions) {
      if (!actor) throw new StorageError('STORAGE_UNAUTHENTICATED');
      const resource: import('./ports.js').ResourceRef = { type: 'file', id: file.id };
      if (file.ownerId !== undefined) resource.ownerId = file.ownerId;
      if (file.tenantId !== undefined) resource.orgId = file.tenantId;
      const ok = await permissions.can(actor, PERM[action], resource);
      if (ok) return;
      await auditSafe(`storage.${action}`, 'denied', file, actor);
      throw new StorageError('STORAGE_FORBIDDEN');
    }
  };

  const requireReady = (file: FileRecord): void => {
    if (file.status !== 'ready') throw new StorageError('STORAGE_FILE_NOT_READY');
  };

  const load = async (fileId: string): Promise<FileRecord> => {
    if (!isValidId(fileId)) throw new StorageError('STORAGE_FILE_NOT_FOUND');
    const file = await store.get(fileId);
    if (!file) throw new StorageError('STORAGE_FILE_NOT_FOUND');
    return file;
  };

  const quotaLimits = (): Partial<Record<'owner' | 'tenant', QuotaLimit>> => {
    const out: Partial<Record<'owner' | 'tenant', QuotaLimit>> = {};
    if (quotas.owner) out.owner = quotas.owner;
    if (quotas.tenant) out.tenant = quotas.tenant;
    return out;
  };

  const buildKey = (id: string, filename: string, explicit?: string): string => {
    if (explicit !== undefined) return validateKey(explicit);
    return validateKey(`${keyPrefix}${id}/${sanitizeFilename(filename)}`);
  };

  const resolveTypes = (
    filename: string,
    declaredRaw: string | undefined,
    head: Buffer,
    truncated: boolean,
  ): { contentType: string; declaredType?: string; detectedType?: string } => {
    const declared = normalizeContentType(declaredRaw);
    const sniffed = sniffContentType(head, truncated);
    const fromExt = typeForExtension(filename);
    if (rejectScriptable && sniffed.scriptable) {
      const allowed =
        allowedTypes !== undefined &&
        sniffed.type !== undefined &&
        matchesTypePattern(sniffed.type, allowedTypes);
      if (!allowed) {
        throw new StorageError('STORAGE_TYPE_NOT_ALLOWED', {
          message: `Scriptable content type ${sniffed.type ?? 'unknown'} is not allowed`,
          details: { detectedType: sniffed.type, scriptable: true },
        });
      }
    }
    const contentType = declared ?? sniffed.type ?? fromExt ?? OCTET_STREAM;
    if (enforceTypeConsistency) {
      if (declared && sniffed.type && !isCompatibleType(declared, sniffed.type)) {
        throw new StorageError('STORAGE_TYPE_MISMATCH', {
          details: { declaredType: declared, detectedType: sniffed.type },
        });
      }
      if (
        fromExt &&
        sniffed.type &&
        isSniffableType(fromExt) &&
        !isCompatibleType(fromExt, sniffed.type)
      ) {
        throw new StorageError('STORAGE_TYPE_MISMATCH', {
          message: 'File extension does not match content',
          details: { extension: extensionOf(filename), detectedType: sniffed.type },
        });
      }
      // Known binary content with an extension that does not map to that type (spoofing).
      if (
        sniffed.type &&
        isSniffableType(sniffed.type) &&
        extensionOf(filename) !== undefined &&
        fromExt === undefined
      ) {
        throw new StorageError('STORAGE_TYPE_MISMATCH', {
          message: 'File extension does not match content',
          details: { extension: extensionOf(filename), detectedType: sniffed.type },
        });
      }
      if (
        declared &&
        fromExt &&
        isSniffableType(fromExt) &&
        declared !== fromExt &&
        declared !== OCTET_STREAM &&
        !isCompatibleType(declared, fromExt)
      ) {
        throw new StorageError('STORAGE_TYPE_MISMATCH', {
          message: 'Declared type does not match filename extension',
          details: { declaredType: declared, extensionType: fromExt },
        });
      }
    }
    if (allowedTypes && !matchesTypePattern(contentType, allowedTypes)) {
      throw new StorageError('STORAGE_TYPE_NOT_ALLOWED', { details: { contentType } });
    }
    const out: { contentType: string; declaredType?: string; detectedType?: string } = {
      contentType,
    };
    if (declared) out.declaredType = declared;
    if (sniffed.type) out.detectedType = sniffed.type;
    return out;
  };

  const storage: Storage = {
    driver,
    metadata: store,

    async upload(input) {
      if (!input || typeof input !== 'object') {
        throw new StorageError('STORAGE_VALIDATION_FAILED', {
          message: 'upload input is required',
        });
      }
      const now = clock.now();
      const id = generateId();
      if (!isValidId(id)) configError('generateId', 'must return a valid id');
      const filename = sanitizeFilename(input.filename);
      const key = buildKey(id, filename, input.key);
      const meta = validateMetadata(input.metadata, metadataLimits);
      const visibility: FileVisibility = input.visibility ?? 'private';
      if (visibility !== 'private' && visibility !== 'public') {
        throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'invalid visibility' });
      }
      let reserveBytes = maxBytes;
      let exact = false;
      if (input.expectedSize !== undefined) {
        if (!Number.isInteger(input.expectedSize) || input.expectedSize < 0) {
          throw new StorageError('STORAGE_VALIDATION_FAILED', {
            message: 'expectedSize must be a non-negative integer',
          });
        }
        if (input.expectedSize > maxBytes) throw new StorageError('STORAGE_FILE_TOO_LARGE');
        reserveBytes = input.expectedSize;
        exact = true;
      }

      const pending: FileRecord = {
        id,
        key,
        filename,
        contentType: normalizeContentType(input.contentType) ?? OCTET_STREAM,
        size: 0,
        visibility,
        metadata: meta,
        status: 'pending',
        reservedBytes: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (input.ownerId !== undefined) pending.ownerId = input.ownerId;
      if (input.tenantId !== undefined) pending.tenantId = input.tenantId;
      const declaredNorm = normalizeContentType(input.contentType);
      if (declaredNorm) pending.declaredType = declaredNorm;

      await authorize('write', pending, input.actor);
      await store.insertPending(pending, {
        bytes: reserveBytes,
        exact,
        limits: quotaLimits(),
      });

      let resolvedTypes: { contentType: string; declaredType?: string; detectedType?: string } = {
        contentType: pending.contentType,
      };
      if (declaredNorm) resolvedTypes.declaredType = declaredNorm;

      const source = toReadable(input.body);
      const inspector = new InspectorStream({
        maxBytes,
        sniffBytes: 8192,
        limitError: () => new StorageError('STORAGE_FILE_TOO_LARGE'),
        onHead: (head, truncated) => {
          resolvedTypes = resolveTypes(filename, input.contentType, head, truncated);
        },
      });
      if (input.signal) {
        const onAbort = (): void => {
          source.destroy(new StorageError('STORAGE_ABORTED'));
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      }

      const bridge = new PassThrough();
      try {
        const putOpts: import('./types.js').DriverPutOptions = {
          contentType: pending.contentType,
        };
        if (input.signal) putOpts.signal = input.signal;
        const [, putResult] = await Promise.all([
          pipeline(source, inspector, bridge),
          driver.put(key, bridge, putOpts),
        ]);
        if (exact && putResult.size !== reserveBytes) {
          throw new StorageError('STORAGE_SIZE_MISMATCH', {
            details: { expected: reserveBytes, actual: putResult.size },
          });
        }
        const sha256 = inspector.digest();
        const commitUpdate: {
          size: number;
          sha256: string;
          contentType: string;
          detectedType?: string;
          updatedAt: number;
        } = {
          size: putResult.size,
          sha256,
          contentType: resolvedTypes.contentType,
          updatedAt: clock.now(),
        };
        if (resolvedTypes.detectedType) commitUpdate.detectedType = resolvedTypes.detectedType;
        const ready = await store.commit(id, commitUpdate);
        await auditSafe('storage.upload', 'success', ready, input.actor);
        logger.info(
          { fileId: id, size: ready.size, contentType: ready.contentType },
          'storage: uploaded',
        );
        return ready;
      } catch (err) {
        await store.release(id).catch((releaseErr) => {
          logger.warn(
            { err: String(releaseErr), fileId: id },
            'storage: release after failed upload',
          );
        });
        await driver.delete(key).catch((deleteErr) => {
          logger.warn({ err: String(deleteErr), key }, 'storage: cleanup after failed upload');
        });
        await auditSafe('storage.upload', 'failure', pending, input.actor);
        throw err;
      }
    },

    async get(fileId, actor) {
      const file = await load(fileId);
      await authorize('read', file, actor);
      return file;
    },

    async list(query) {
      const { actor, ...rest } = query;
      if (permissions && !actor && !authorizeFn) {
        throw new StorageError('STORAGE_UNAUTHENTICATED');
      }
      const result = await store.list(rest);
      if (!authorizeFn && !permissions) return result;
      const items: FileRecord[] = [];
      for (const file of result.items) {
        try {
          await authorize('read', file, actor);
          items.push(file);
        } catch (err) {
          if (err instanceof StorageError && err.code === 'STORAGE_FORBIDDEN') continue;
          throw err;
        }
      }
      const out: ListFilesResult = { items };
      if (result.nextCursor) out.nextCursor = result.nextCursor;
      return out;
    },

    async update(fileId, patch, actor) {
      const file = await load(fileId);
      requireReady(file);
      await authorize('write', file, actor);
      const update: {
        filename?: string;
        visibility?: FileVisibility;
        metadata?: FileMetadata;
        updatedAt: number;
      } = { updatedAt: clock.now() };
      if (patch.filename !== undefined) update.filename = sanitizeFilename(patch.filename);
      if (patch.visibility !== undefined) {
        if (patch.visibility !== 'private' && patch.visibility !== 'public') {
          throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'invalid visibility' });
        }
        update.visibility = patch.visibility;
      }
      if (patch.metadata !== undefined) {
        update.metadata = validateMetadata(patch.metadata, metadataLimits);
      }
      const updated = await store.update(fileId, update);
      if (!updated) throw new StorageError('STORAGE_FILE_NOT_FOUND');
      return updated;
    },

    async delete(fileId, actor) {
      const file = await load(fileId);
      await authorize('delete', file, actor);
      if (file.status === 'pending') {
        const session = await store.getSession(fileId);
        if (session && driver.resumable) {
          await driver.resumable.abort(file.key, session.driverState).catch(() => undefined);
        }
        await store.release(fileId);
        await driver.delete(file.key).catch(() => undefined);
        await auditSafe('storage.delete', 'success', file, actor);
        return;
      }
      await store.remove(fileId);
      await driver.delete(file.key).catch((err) => {
        logger.warn({ err: String(err), key: file.key }, 'storage: object delete failed');
      });
      await auditSafe('storage.delete', 'success', file, actor);
    },

    async deleteByOwner(ownerId, actor) {
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'ownerId is required' });
      }
      let deleted = 0;
      let cursor: string | undefined;
      for (;;) {
        const pageQuery: ListFilesQuery = { ownerId, status: 'all', limit: 100 };
        if (cursor) pageQuery.cursor = cursor;
        const page = await store.list(pageQuery);
        for (const file of page.items) {
          await storage.delete(file.id, actor);
          deleted += 1;
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return { deleted };
    },

    usage(scope) {
      return store.usage(scope);
    },

    async download(options) {
      const file = await load(options.fileId);
      requireReady(file);
      if (!options.bypassAuthorize) await authorize('read', file, options.actor);
      let range: ByteRange | undefined;
      if (typeof options.range === 'string') range = parseRangeHeader(options.range, file.size);
      else if (options.range) range = options.range;
      if (range && (range.start < 0 || range.end < range.start || range.start >= file.size)) {
        throw new StorageError('STORAGE_RANGE_NOT_SATISFIABLE');
      }
      const obj = await driver.get(file.key, range ? { range } : undefined);
      let body: NodeJS.ReadableStream = obj.body;
      if (options.verify && !range && file.sha256) {
        body = obj.body.pipe(
          new VerifyingStream(file.sha256, file.size, (actual, bytes) => {
            logger.error(
              { fileId: file.id, expected: file.sha256, actual, bytes },
              'storage: integrity failure on download',
            );
          }),
        );
      }
      const contentLength = range ? range.end - range.start + 1 : file.size;
      const result: DownloadResult = {
        file,
        body,
        contentLength,
        contentType: file.contentType,
        contentDisposition: contentDispositionHeader(
          file.filename,
          options.disposition,
          file.contentType,
        ),
      };
      if (range) result.range = range;
      return result;
    },

    async verify(fileId, actor) {
      const file = await load(fileId);
      requireReady(file);
      await authorize('read', file, actor);
      if (!file.sha256) {
        throw new StorageError('STORAGE_INTEGRITY_FAILED', { message: 'No checksum stored' });
      }
      const obj = await driver.get(file.key);
      const { sha256, size } = await hashStream(obj.body);
      if (sha256 !== file.sha256 || size !== file.size) {
        throw new StorageError('STORAGE_INTEGRITY_FAILED', {
          details: {
            expectedSha256: file.sha256,
            actualSha256: sha256,
            expectedSize: file.size,
            actualSize: size,
          },
        });
      }
      return { ok: true as const, sha256, size };
    },

    async createSignedUrl(opts) {
      const file = await load(opts.fileId);
      requireReady(file);
      const method: SignedMethod = opts.method ?? 'GET';
      await authorize(method === 'GET' ? 'read' : 'write', file, opts.actor);
      const expiresIn = opts.expiresInSeconds ?? 900;
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800) {
        throw new StorageError('STORAGE_VALIDATION_FAILED', {
          message: 'expiresInSeconds must be from 1 to 604800',
        });
      }
      if (driver.presign) {
        const presignOpts: {
          method: 'GET' | 'PUT';
          expiresInSeconds: number;
          contentType?: string;
          contentDisposition?: string;
        } = { method, expiresInSeconds: expiresIn };
        if (method === 'PUT') presignOpts.contentType = file.contentType;
        if (opts.disposition) {
          presignOpts.contentDisposition = contentDispositionHeader(
            file.filename,
            opts.disposition,
            file.contentType,
          );
        }
        const url = await driver.presign(file.key, presignOpts);
        return { url, expiresAt: new Date(clock.now() + expiresIn * 1000) };
      }
      if (!secrets) {
        throw new StorageError('STORAGE_NOT_SUPPORTED', {
          message: 'signingSecret is required for adapter signed URLs',
        });
      }
      const expires = Math.floor(clock.now() / 1000) + expiresIn;
      const claims: {
        method: SignedMethod;
        fileId: string;
        key: string;
        expires: number;
        disposition?: ContentDispositionType;
      } = { method, fileId: file.id, key: file.key, expires };
      if (opts.disposition) claims.disposition = opts.disposition;
      const signature = signClaims(secrets, claims);
      const base = opts.baseUrl.replace(/\/$/, '');
      const url = new URL(`${base}/${encodeURIComponent(file.id)}`);
      url.searchParams.set(SIGNED_URL_PARAMS.expires, String(expires));
      if (opts.disposition) {
        url.searchParams.set(SIGNED_URL_PARAMS.disposition, opts.disposition);
      }
      url.searchParams.set(SIGNED_URL_PARAMS.signature, signature);
      return { url: url.toString(), expiresAt: new Date(expires * 1000) };
    },

    async verifySignedUrl(opts) {
      if (!secrets) {
        throw new StorageError('STORAGE_NOT_SUPPORTED', {
          message: 'signingSecret is not configured',
        });
      }
      const file = await load(opts.fileId);
      const expiresRaw = opts.query.get(SIGNED_URL_PARAMS.expires);
      const signature = opts.query.get(SIGNED_URL_PARAMS.signature);
      if (!expiresRaw || !signature) throw new StorageError('STORAGE_SIGNATURE_INVALID');
      const expires = Number(expiresRaw);
      if (!Number.isInteger(expires)) throw new StorageError('STORAGE_SIGNATURE_INVALID');
      if (expires * 1000 < clock.now()) throw new StorageError('STORAGE_SIGNATURE_EXPIRED');
      const method = opts.method.toUpperCase();
      if (method !== 'GET' && method !== 'PUT') throw new StorageError('STORAGE_SIGNATURE_INVALID');
      const dispositionRaw = opts.query.get(SIGNED_URL_PARAMS.disposition);
      const disposition =
        dispositionRaw === 'inline' || dispositionRaw === 'attachment' ? dispositionRaw : undefined;
      const claims: {
        method: SignedMethod;
        fileId: string;
        key: string;
        expires: number;
        disposition?: ContentDispositionType;
      } = {
        method: method as SignedMethod,
        fileId: opts.fileId,
        key: file.key,
        expires,
      };
      if (disposition) claims.disposition = disposition;
      if (!verifyClaims(secrets, claims, signature)) {
        throw new StorageError('STORAGE_SIGNATURE_INVALID');
      }
      const out: { file: FileRecord; disposition?: ContentDispositionType } = { file };
      if (disposition) out.disposition = disposition;
      return out;
    },

    async createUploadSession(input) {
      if (!driver.resumable) {
        throw new StorageError('STORAGE_NOT_SUPPORTED', {
          message: 'The configured driver does not support resumable uploads',
        });
      }
      if (
        !Number.isInteger(input.uploadLength) ||
        input.uploadLength < 0 ||
        input.uploadLength > maxBytes
      ) {
        throw new StorageError('STORAGE_VALIDATION_FAILED', {
          message: `uploadLength must be from 0 to ${maxBytes}`,
        });
      }
      const now = clock.now();
      const id = generateId();
      if (!isValidId(id)) configError('generateId', 'must return a valid id');
      const filename = sanitizeFilename(input.filename);
      const key = buildKey(id, filename);
      const meta = validateMetadata(input.metadata, metadataLimits);
      const visibility: FileVisibility = input.visibility ?? 'private';
      const contentType = normalizeContentType(input.contentType) ?? OCTET_STREAM;
      if (allowedTypes && !matchesTypePattern(contentType, allowedTypes)) {
        throw new StorageError('STORAGE_TYPE_NOT_ALLOWED', { details: { contentType } });
      }
      const pending: FileRecord = {
        id,
        key,
        filename,
        contentType,
        size: input.uploadLength,
        visibility,
        metadata: meta,
        status: 'pending',
        reservedBytes: 0,
        expiresAt: now + sessionTtlMs,
        createdAt: now,
        updatedAt: now,
      };
      if (input.ownerId !== undefined) pending.ownerId = input.ownerId;
      if (input.tenantId !== undefined) pending.tenantId = input.tenantId;
      const declared = normalizeContentType(input.contentType);
      if (declared) pending.declaredType = declared;
      await authorize('write', pending, input.actor);
      const driverState = await driver.resumable.create(key, { contentType });
      const session = {
        id,
        uploadLength: input.uploadLength,
        uploadOffset: 0,
        driverState,
        kind: 'resumable' as const,
        expiresAt: now + sessionTtlMs,
        createdAt: now,
        updatedAt: now,
      };
      await store.insertPending(
        pending,
        { bytes: input.uploadLength, exact: true, limits: quotaLimits() },
        session,
      );
      return {
        session: {
          id,
          uploadLength: input.uploadLength,
          uploadOffset: 0,
          expiresAt: new Date(session.expiresAt),
        },
        file: { ...pending, reservedBytes: input.uploadLength },
      };
    },

    async getUploadOffset(uploadId, actor) {
      const file = await load(uploadId);
      await authorize('write', file, actor);
      const session = await store.getSession(uploadId);
      if (!session) throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
      if (session.expiresAt <= clock.now()) throw new StorageError('STORAGE_UPLOAD_EXPIRED');
      return {
        uploadOffset: session.uploadOffset,
        uploadLength: session.uploadLength,
        expiresAt: new Date(session.expiresAt),
      };
    },

    async appendUpload(input) {
      if (!driver.resumable) throw new StorageError('STORAGE_NOT_SUPPORTED');
      const file = await load(input.uploadId);
      await authorize('write', file, input.actor);
      const session = await store.getSession(input.uploadId);
      if (!session) throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
      if (session.expiresAt <= clock.now()) throw new StorageError('STORAGE_UPLOAD_EXPIRED');
      if (input.offset !== session.uploadOffset) {
        throw new StorageError('STORAGE_UPLOAD_OFFSET_MISMATCH', {
          details: { expected: session.uploadOffset, received: input.offset },
        });
      }
      const token = generateId();
      const lock = await store.lockSession(input.uploadId, {
        expectedOffset: input.offset,
        token,
        until: clock.now() + 120_000,
        now: clock.now(),
      });
      if (lock === 'busy') throw new StorageError('STORAGE_UPLOAD_LOCKED');
      if (lock === 'offset_mismatch') throw new StorageError('STORAGE_UPLOAD_OFFSET_MISMATCH');
      if (lock === 'not_found') throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');

      const remaining = session.uploadLength - session.uploadOffset;
      const source = toReadable(input.body);
      const inspectorOpts: import('./streams.js').InspectorOptions = {
        maxBytes: remaining,
        sniffBytes: session.uploadOffset === 0 ? 8192 : 0,
        limitError: () => new StorageError('STORAGE_FILE_TOO_LARGE'),
      };
      if (session.uploadOffset === 0) {
        inspectorOpts.onHead = (head, truncated) => {
          resolveTypes(file.filename, file.declaredType, head, truncated);
        };
      }
      const inspector = new InspectorStream(inspectorOpts);
      source.pipe(inspector);

      try {
        const appendOpts: import('./types.js').ResumableAppendOptions = {
          offset: input.offset,
          keepPartialOnError: true,
          beforeCommit: async (bytes) => {
            if (session.uploadOffset + bytes > session.uploadLength) {
              throw new StorageError('STORAGE_FILE_TOO_LARGE');
            }
          },
        };
        if (input.signal) appendOpts.signal = input.signal;
        const result = await driver.resumable.append(
          file.key,
          session.driverState,
          inspector,
          appendOpts,
        );
        if (input.checksumSha256) {
          const digest = inspector.digest();
          if (digest !== input.checksumSha256.toLowerCase()) {
            throw new StorageError('STORAGE_CHECKSUM_MISMATCH');
          }
        }
        const newOffset = session.uploadOffset + result.bytesWritten;
        await store.updateSession(
          input.uploadId,
          {
            uploadOffset: newOffset,
            driverState: result.state,
            updatedAt: clock.now(),
          },
          token,
        );
        if (result.error) {
          throw result.error instanceof StorageError
            ? result.error
            : new StorageError('STORAGE_UPLOAD_INTERRUPTED', { cause: result.error });
        }
        return { uploadOffset: newOffset };
      } finally {
        await store.unlockSession(input.uploadId, token).catch(() => undefined);
      }
    },

    async completeUpload(uploadId, actor) {
      if (!driver.resumable) throw new StorageError('STORAGE_NOT_SUPPORTED');
      const file = await load(uploadId);
      await authorize('write', file, actor);
      const session = await store.getSession(uploadId);
      if (!session) throw new StorageError('STORAGE_UPLOAD_NOT_FOUND');
      if (session.uploadOffset !== session.uploadLength) {
        throw new StorageError('STORAGE_UPLOAD_INCOMPLETE', {
          details: { uploadOffset: session.uploadOffset, uploadLength: session.uploadLength },
        });
      }
      await driver.resumable.complete(file.key, session.driverState);
      const obj = await driver.get(file.key);
      const { sha256, size, head } = await hashStream(obj.body);
      if (size !== session.uploadLength) {
        throw new StorageError('STORAGE_SIZE_MISMATCH', {
          details: { expected: session.uploadLength, actual: size },
        });
      }
      const types = resolveTypes(file.filename, file.declaredType, head, false);
      const commitUpdate: {
        size: number;
        sha256: string;
        contentType: string;
        detectedType?: string;
        updatedAt: number;
      } = {
        size,
        sha256,
        contentType: types.contentType,
        updatedAt: clock.now(),
      };
      if (types.detectedType) commitUpdate.detectedType = types.detectedType;
      const ready = await store.commit(uploadId, commitUpdate);
      await auditSafe('storage.upload.complete', 'success', ready, actor);
      return ready;
    },

    async abortUpload(uploadId, actor) {
      const file = await load(uploadId);
      await authorize('delete', file, actor);
      const session = await store.getSession(uploadId);
      if (session && driver.resumable) {
        await driver.resumable.abort(file.key, session.driverState).catch(() => undefined);
      }
      await store.release(uploadId);
      await driver.delete(file.key).catch(() => undefined);
    },

    async cleanupExpired() {
      let released = 0;
      for (;;) {
        const expired = await store.listExpired(clock.now(), 100);
        if (expired.length === 0) break;
        for (const file of expired) {
          const session = await store.getSession(file.id);
          if (session && driver.resumable) {
            await driver.resumable.abort(file.key, session.driverState).catch(() => undefined);
          }
          await store.release(file.id);
          await driver.delete(file.key).catch(() => undefined);
          released += 1;
        }
      }
      return { released };
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const started = clock.now();
      const driverHealth = await driver.checkHealth();
      if (store.ping) {
        try {
          await store.ping();
        } catch {
          return {
            ok: false,
            latencyMs: clock.now() - started,
            details: { driver: driverHealth, metadata: 'unavailable' },
          };
        }
      }
      return {
        ok: driverHealth.ok,
        latencyMs: clock.now() - started,
        details: { driver: driver.name, driverOk: driverHealth.ok },
      };
    },
  };

  return storage;
}
