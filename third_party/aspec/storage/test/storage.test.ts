import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDriver } from '../src/drivers/local.js';
import { StorageError } from '../src/errors.js';
import { createStorage } from '../src/storage.js';
import { createMemoryMetadataStore } from '../src/stores/memory.js';
import { createSqlMetadataStore, migrate } from '../src/stores/sql.js';
import type { StorageMetadataStore } from '../src/types.js';
import { createPostgresClient, createSqliteClient, POSTGRES_URL } from './helpers/sql.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SECRET = randomBytes(32);

function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  return expect(p).rejects.toMatchObject({ code });
}

interface Fixture {
  name: string;
  skip: boolean;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  createStore(): Promise<StorageMetadataStore>;
}

function fixtures(): Fixture[] {
  const sqliteClients: Array<ReturnType<typeof createSqliteClient>> = [];
  let pg: Awaited<ReturnType<typeof createPostgresClient>> | undefined;
  let pgN = 0;
  return [
    {
      name: 'memory',
      skip: false,
      async setup() {},
      async teardown() {},
      async createStore() {
        return createMemoryMetadataStore();
      },
    },
    {
      name: 'sqlite',
      skip: false,
      async setup() {},
      async teardown() {
        for (const c of sqliteClients) c.close();
      },
      async createStore() {
        const c = createSqliteClient();
        sqliteClients.push(c);
        await migrate(c);
        return createSqlMetadataStore(c);
      },
    },
    {
      name: 'postgres',
      skip: !POSTGRES_URL,
      async setup() {
        if (POSTGRES_URL) pg = await createPostgresClient(POSTGRES_URL);
      },
      async teardown() {
        await pg?.close();
      },
      async createStore() {
        if (!pg) throw new Error('no pg');
        pgN += 1;
        const tablePrefix = `s${pgN}_`;
        await migrate(pg, { tablePrefix });
        return createSqlMetadataStore(pg, { tablePrefix });
      },
    },
  ];
}

for (const fixture of fixtures()) {
  describe.skipIf(fixture.skip)(`storage (${fixture.name})`, () => {
    let root: string;

    beforeAll(async () => {
      await fixture.setup();
      root = await mkdtemp(join(tmpdir(), 'aspec-storage-'));
    });
    afterAll(async () => {
      await fixture.teardown();
      await rm(root, { recursive: true, force: true });
    });

    async function makeStorage(overrides: Partial<Parameters<typeof createStorage>[0]> = {}) {
      const metadata = overrides.metadata ?? (await fixture.createStore());
      const driver =
        overrides.driver ?? createLocalDriver({ root: join(root, randomBytes(4).toString('hex')) });
      return createStorage({
        validation: { maxBytes: 1024 * 1024 },
        signingSecret: SECRET,
        ...overrides,
        driver,
        metadata,
      });
    }

    it('uploads and downloads with integrity', async () => {
      const storage = await makeStorage();
      const file = await storage.upload({
        body: PNG,
        filename: 'dot.png',
        contentType: 'image/png',
        ownerId: 'u1',
      });
      expect(file.status).toBe('ready');
      expect(file.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      expect(file.detectedType).toBe('image/png');
      const dl = await storage.download({ fileId: file.id });
      const chunks: Buffer[] = [];
      for await (const c of dl.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
      await expect(storage.verify(file.id)).resolves.toMatchObject({ ok: true });
    });

    it('aborts oversized uploads and cleans up', async () => {
      const storage = await makeStorage({ validation: { maxBytes: 16 } });
      await expectCode(
        storage.upload({ body: Buffer.alloc(64), filename: 'big.bin' }),
        'STORAGE_FILE_TOO_LARGE',
      );
      expect((await storage.list({ status: 'all' })).items).toHaveLength(0);
    });

    it('rejects spoofed extensions and traversal keys', async () => {
      const storage = await makeStorage();
      await expectCode(
        storage.upload({
          body: PNG,
          filename: 'evil.exe',
          contentType: 'image/png',
        }),
        'STORAGE_TYPE_MISMATCH',
      );
      await expectCode(
        storage.upload({
          body: PNG,
          filename: 'ok.png',
          key: '../escape.png',
        }),
        'STORAGE_INVALID_KEY',
      );
    });

    it('enforces access control', async () => {
      const storage = await makeStorage({
        authorize: ({ action, actor }) => action === 'write' || actor?.id === 'owner',
      });
      const file = await storage.upload({ body: PNG, filename: 'a.png', actor: { id: 'owner' } });
      await expectCode(storage.get(file.id, { id: 'other' }), 'STORAGE_FORBIDDEN');
      await expect(storage.get(file.id, { id: 'owner' })).resolves.toMatchObject({ id: file.id });
    });

    it('signs URLs and rejects tampering and expiry', async () => {
      let now = Date.now();
      const storage = await makeStorage({
        clock: { now: () => now },
      });
      const file = await storage.upload({ body: PNG, filename: 'a.png' });
      const { url } = await storage.createSignedUrl({
        fileId: file.id,
        baseUrl: 'https://app.example/files',
        expiresInSeconds: 60,
      });
      const parsed = new URL(url);
      await expect(
        storage.verifySignedUrl({
          method: 'GET',
          fileId: file.id,
          query: parsed.searchParams,
        }),
      ).resolves.toMatchObject({ file: { id: file.id } });
      parsed.searchParams.set('signature', 'a'.repeat(43));
      await expectCode(
        storage.verifySignedUrl({ method: 'GET', fileId: file.id, query: parsed.searchParams }),
        'STORAGE_SIGNATURE_INVALID',
      );
      const fresh = new URL(
        (
          await storage.createSignedUrl({
            fileId: file.id,
            baseUrl: 'https://app.example/files',
            expiresInSeconds: 10,
          })
        ).url,
      );
      now += 11_000;
      await expectCode(
        storage.verifySignedUrl({ method: 'GET', fileId: file.id, query: fresh.searchParams }),
        'STORAGE_SIGNATURE_EXPIRED',
      );
    });

    it('enforces quotas under concurrency', async () => {
      const storage = await makeStorage({
        quotas: { owner: { maxBytes: PNG.length * 2, maxFiles: 2 } },
      });
      const results = await Promise.allSettled(
        [1, 2, 3].map((i) =>
          storage.upload({
            body: PNG,
            filename: `q${i}.png`,
            ownerId: 'bob',
            expectedSize: PNG.length,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const denied = results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof StorageError &&
          r.reason.code === 'STORAGE_QUOTA_EXCEEDED',
      );
      expect(ok.length).toBe(2);
      expect(denied.length).toBe(1);
      const usage = await storage.usage({ type: 'owner', id: 'bob' });
      expect(usage.filesUsed).toBe(2);
      expect(usage.bytesUsed).toBe(PNG.length * 2);
    });

    it('supports resumable uploads across interruptions', async () => {
      const storage = await makeStorage();
      const payload = Buffer.concat([PNG, Buffer.from('more-data')]);
      const { session } = await storage.createUploadSession({
        uploadLength: payload.length,
        filename: 'r.png',
        contentType: 'image/png',
      });
      const first = payload.subarray(0, 4);
      const second = payload.subarray(4);
      const a = await storage.appendUpload({
        uploadId: session.id,
        body: first,
        offset: 0,
      });
      expect(a.uploadOffset).toBe(4);
      const head = await storage.getUploadOffset(session.id);
      expect(head.uploadOffset).toBe(4);
      await storage.appendUpload({
        uploadId: session.id,
        body: second,
        offset: 4,
      });
      const done = await storage.completeUpload(session.id);
      expect(done.status).toBe('ready');
      expect(done.size).toBe(payload.length);
    });
  });
}
