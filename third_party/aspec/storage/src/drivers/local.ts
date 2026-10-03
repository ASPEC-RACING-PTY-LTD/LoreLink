import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  constants,
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { configError, StorageError } from '../errors.js';
import type { HealthCheckResult } from '../ports.js';
import type {
  ByteRange,
  DriverObject,
  DriverPutOptions,
  ResumableAppendOptions,
  ResumableAppendResult,
  ResumableDriver,
  StorageDriver,
} from '../types.js';
import { validateKey } from '../validation.js';

export interface LocalDriverOptions {
  /** Root directory. Created when missing. All objects stay inside it. */
  root: string;
  /** Number of two-hex-character shard directories derived from SHA-256 of the key (0 to 3, default 2). */
  shardDepth?: number;
  /** fsync file data and parent directories after writes (default false). */
  fsync?: boolean;
  /** Mode for created files (default 0o600). */
  fileMode?: number;
  /** Mode for created directories (default 0o700). */
  dirMode?: number;
}

export interface LocalDriver extends StorageDriver {
  readonly root: string;
  /** Removes temporary and abandoned upload files older than maxAgeMs. Returns the count. */
  sweepTemporaryFiles(maxAgeMs: number, now?: number): Promise<number>;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
const PART_NAME = /^[0-9a-f-]{36}\.part$/;

async function writeAll(fh: FileHandle, chunk: Buffer, position: number | null): Promise<number> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await fh.write(
      chunk,
      offset,
      chunk.length - offset,
      position === null ? null : position + offset,
    );
    if (bytesWritten === 0) throw new Error('short write');
    offset += bytesWritten;
  }
  return chunk.length;
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new StorageError('STORAGE_VALIDATION_FAILED', { message: 'Upload chunks must be bytes' });
}

function abortError(): StorageError {
  return new StorageError('STORAGE_ABORTED');
}

/**
 * Local filesystem driver. Writes go to a temporary file in the same root and are renamed
 * into place, so readers never observe partial objects.
 */
export function createLocalDriver(options: LocalDriverOptions): LocalDriver {
  if (!options || typeof options.root !== 'string' || options.root.trim() === '') {
    configError('root', 'a directory path is required');
  }
  const shardDepth = options.shardDepth ?? 2;
  if (!Number.isInteger(shardDepth) || shardDepth < 0 || shardDepth > 3) {
    configError('shardDepth', 'must be an integer from 0 to 3');
  }
  const fsyncEnabled = options.fsync ?? false;
  const fileMode = options.fileMode ?? 0o600;
  const dirMode = options.dirMode ?? 0o700;
  const configuredRoot = resolve(options.root);

  let objectsDir = '';
  let tmpDir = '';
  let uploadsDir = '';
  const ready = (async () => {
    await mkdir(configuredRoot, { recursive: true, mode: dirMode });
    const real = await realpath(configuredRoot);
    objectsDir = join(real, 'objects');
    tmpDir = join(real, '.tmp');
    uploadsDir = join(real, '.uploads');
    await Promise.all([
      mkdir(objectsDir, { recursive: true, mode: dirMode }),
      mkdir(tmpDir, { recursive: true, mode: dirMode }),
      mkdir(uploadsDir, { recursive: true, mode: dirMode }),
    ]);
  })();
  // Surface initialisation failures on first use rather than as an unhandled rejection.
  ready.catch(() => undefined);

  function pathFor(key: string): string {
    validateKey(key);
    const segments = key.split('/');
    for (const segment of segments) {
      if (segment.includes(':')) {
        throw new StorageError('STORAGE_INVALID_KEY', {
          message: 'Invalid storage key: colons are not allowed by the local driver',
        });
      }
      if (/[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment)) {
        throw new StorageError('STORAGE_INVALID_KEY', {
          message: 'Invalid storage key: segment is not portable across filesystems',
        });
      }
    }
    const digest = createHash('sha256').update(key).digest('hex');
    const shards: string[] = [];
    for (let i = 0; i < shardDepth; i++) shards.push(digest.slice(i * 2, i * 2 + 2));
    const full = resolve(objectsDir, ...shards, ...segments);
    const rel = relative(objectsDir, full);
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new StorageError('STORAGE_INVALID_KEY', {
        message: 'Invalid storage key: resolves outside the storage root',
      });
    }
    return full;
  }

  function partPath(state: Record<string, unknown>): string {
    const part = state.part;
    if (typeof part !== 'string' || !PART_NAME.test(part)) {
      throw new StorageError('STORAGE_INTERNAL', { message: 'Invalid local upload state' });
    }
    return join(uploadsDir, part);
  }

  async function syncDirectory(dir: string): Promise<void> {
    if (!fsyncEnabled) return;
    let fh: FileHandle | undefined;
    try {
      fh = await open(dir, 'r');
      await fh.sync();
    } catch {
      // Directories cannot be opened for fsync on Windows; file data was already synced.
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  async function place(from: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true, mode: dirMode });
    await rename(from, dest);
    await syncDirectory(dirname(dest));
  }

  const resumable: ResumableDriver = {
    async create() {
      await ready;
      const part = `${randomUUID()}.part`;
      const fh = await open(join(uploadsDir, part), 'wx', fileMode);
      await fh.close();
      return { part };
    },

    async append(
      _key: string,
      state: Record<string, unknown>,
      source: Readable,
      opts: ResumableAppendOptions,
    ): Promise<ResumableAppendResult> {
      await ready;
      const file = partPath(state);
      let fh: FileHandle;
      try {
        fh = await open(file, 'r+');
      } catch (err) {
        source.destroy();
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new StorageError('STORAGE_UPLOAD_NOT_FOUND', { cause: err });
        }
        throw err;
      }
      try {
        const current = (await fh.stat()).size;
        if (current < opts.offset) {
          source.destroy();
          throw new StorageError('STORAGE_UPLOAD_OFFSET_MISMATCH', {
            message: 'Stored upload data is shorter than the recorded offset',
          });
        }
        // Bytes past the recorded offset come from an unrecorded write; discard them.
        if (current > opts.offset) await fh.truncate(opts.offset);
        let written = 0;
        let failure: unknown;
        try {
          for await (const chunk of source) {
            if (opts.signal?.aborted) throw abortError();
            written += await writeAll(fh, asBuffer(chunk), opts.offset + written);
          }
        } catch (err) {
          failure = err;
        }
        if (failure !== undefined) {
          if (written > 0 && opts.keepPartialOnError) {
            if (fsyncEnabled) await fh.sync();
            return { state, bytesWritten: written, error: failure };
          }
          await fh.truncate(opts.offset);
          return { state, bytesWritten: 0, error: failure };
        }
        try {
          await opts.beforeCommit(written);
        } catch (err) {
          await fh.truncate(opts.offset);
          throw err;
        }
        if (fsyncEnabled) await fh.sync();
        return { state, bytesWritten: written };
      } finally {
        await fh.close();
      }
    },

    async complete(key: string, state: Record<string, unknown>) {
      await ready;
      await place(partPath(state), pathFor(key));
    },

    async abort(_key: string, state: Record<string, unknown>) {
      await ready;
      await rm(partPath(state), { force: true });
    },
  };

  const driver: LocalDriver = {
    name: 'local',
    root: configuredRoot,
    resumable,

    async put(key: string, body: Readable, putOptions: DriverPutOptions) {
      await ready;
      const dest = pathFor(key);
      const tmp = join(tmpDir, `${randomUUID()}.part`);
      let fh: FileHandle | undefined;
      try {
        fh = await open(tmp, 'wx', fileMode);
        let size = 0;
        for await (const chunk of body) {
          if (putOptions.signal?.aborted) throw abortError();
          size += await writeAll(fh, asBuffer(chunk), null);
        }
        if (fsyncEnabled) await fh.sync();
        await fh.close();
        fh = undefined;
        await place(tmp, dest);
        return { size };
      } catch (err) {
        body.destroy();
        await fh?.close().catch(() => undefined);
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async get(key: string, getOptions?: { range?: ByteRange }): Promise<DriverObject> {
      await ready;
      const file = pathFor(key);
      let size: number;
      try {
        const st = await stat(file);
        if (!st.isFile()) throw new StorageError('STORAGE_OBJECT_NOT_FOUND');
        size = st.size;
      } catch (err) {
        if (err instanceof StorageError) throw err;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new StorageError('STORAGE_OBJECT_NOT_FOUND', { cause: err });
        }
        throw err;
      }
      const range = getOptions?.range;
      if (range && (range.start < 0 || range.end < range.start || range.end >= size)) {
        throw new StorageError('STORAGE_RANGE_NOT_SATISFIABLE');
      }
      const body = range
        ? createReadStream(file, { start: range.start, end: range.end })
        : createReadStream(file);
      return { body, size };
    },

    async head(key: string) {
      await ready;
      try {
        const st = await stat(pathFor(key));
        return st.isFile() ? { size: st.size } : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    async delete(key: string) {
      await ready;
      await rm(pathFor(key), { force: true });
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const started = Date.now();
      try {
        await ready;
        await access(objectsDir, constants.R_OK | constants.W_OK);
        await access(tmpDir, constants.R_OK | constants.W_OK);
        return { ok: true, latencyMs: Date.now() - started, details: { driver: 'local' } };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          details: { driver: 'local', error: (err as NodeJS.ErrnoException).code ?? 'unavailable' },
        };
      }
    },

    async sweepTemporaryFiles(maxAgeMs: number, now = Date.now()) {
      await ready;
      let removed = 0;
      for (const dir of [tmpDir, uploadsDir]) {
        for (const name of await readdir(dir)) {
          if (!PART_NAME.test(name)) continue;
          const file = join(dir, name);
          const st = await stat(file).catch(() => undefined);
          if (st && now - st.mtimeMs > maxAgeMs) {
            await rm(file, { force: true });
            removed++;
          }
        }
      }
      return removed;
    },
  };
  return driver;
}
