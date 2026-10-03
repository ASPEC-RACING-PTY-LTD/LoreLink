import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
// express@4 installed as the `express4` alias for dual-version adapter tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no bundled types for the express4 alias package
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorageMiddleware } from '../src/adapters/express.js';
import { storageFastifyPlugin } from '../src/adapters/fastify.js';
import { createStorageFetchHandler } from '../src/adapters/fetch.js';
import { createStorageHonoHandler } from '../src/adapters/hono.js';
import { createLocalDriver } from '../src/drivers/local.js';
import { createS3Driver } from '../src/providers/s3.js';
import { createStorage } from '../src/storage.js';
import { createMemoryMetadataStore } from '../src/stores/memory.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SECRET = randomBytes(32);

const S3 = {
  endpoint: process.env.ASPEC_TEST_S3_ENDPOINT,
  accessKey: process.env.ASPEC_TEST_S3_ACCESS_KEY,
  secretKey: process.env.ASPEC_TEST_S3_SECRET_KEY,
  bucket: process.env.ASPEC_TEST_S3_BUCKET,
};

describe.skipIf(!S3.endpoint || !S3.bucket || !S3.accessKey || !S3.secretKey)(
  's3 driver (SeaweedFS)',
  () => {
    it('puts, gets, presigns and multipart resumes', async () => {
      const prefix = `t-${randomBytes(4).toString('hex')}/`;
      const bucket = S3.bucket;
      const accessKey = S3.accessKey;
      const secretKey = S3.secretKey;
      if (!bucket || !accessKey || !secretKey) throw new Error('S3 env incomplete');
      const driverOpts: Parameters<typeof createS3Driver>[0] = {
        bucket,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        keyPrefix: prefix,
      };
      if (S3.endpoint) driverOpts.endpoint = S3.endpoint;
      const driver = createS3Driver(driverOpts);
      const storage = createStorage({
        driver,
        metadata: createMemoryMetadataStore(),
        signingSecret: SECRET,
      });
      const file = await storage.upload({
        body: PNG,
        filename: 'dot.png',
        contentType: 'image/png',
      });
      expect(file.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      const { url } = await storage.createSignedUrl({
        fileId: file.id,
        baseUrl: 'https://unused.example',
        expiresInSeconds: 120,
      });
      expect(url).toContain(S3.endpoint?.replace('http://', '') ?? 'http');
      const payload = Buffer.concat([PNG, Buffer.alloc(100, 7)]);
      const { session } = await storage.createUploadSession({
        uploadLength: payload.length,
        filename: 'm.png',
        contentType: 'image/png',
      });
      await storage.appendUpload({
        uploadId: session.id,
        body: payload.subarray(0, 40),
        offset: 0,
      });
      await storage.appendUpload({
        uploadId: session.id,
        body: payload.subarray(40),
        offset: 40,
      });
      const done = await storage.completeUpload(session.id);
      expect(done.size).toBe(payload.length);
      await storage.delete(file.id);
      await storage.delete(done.id);
    });
  },
);

describe('HTTP adapters', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'aspec-storage-http-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function storage() {
    return createStorage({
      driver: createLocalDriver({ root: join(root, randomBytes(3).toString('hex')) }),
      metadata: createMemoryMetadataStore(),
      signingSecret: SECRET,
    });
  }

  it('fetch handler uploads and downloads', async () => {
    const s = storage();
    const handler = createStorageFetchHandler({
      storage: s,
      publicBaseUrl: 'http://localhost/files',
      basePath: '/files',
    });
    const post = await handler(
      new Request('http://localhost/files/', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-file-name': 'dot.png' },
        body: PNG,
      }),
    );
    expect(post.status).toBe(201);
    const meta = (await post.json()) as { id: string };
    const get = await handler(new Request(`http://localhost/files/${meta.id}`));
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('express 5 and express 4 upload', async () => {
    for (const [name, createApp] of [
      ['express5', express],
      ['express4', express4],
    ] as const) {
      const s = storage();
      const app = createApp();
      app.use(
        '/files',
        createStorageMiddleware({ storage: s, publicBaseUrl: 'http://localhost/files' }),
      );
      const server = await new Promise<import('node:http').Server>((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
      });
      try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        const res = await fetch(`http://127.0.0.1:${addr.port}/files/`, {
          method: 'POST',
          headers: { 'content-type': 'image/png', 'x-file-name': `${name}.png` },
          body: PNG,
        });
        expect(res.status).toBe(201);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  });

  it('fastify and hono upload', async () => {
    const s1 = storage();
    const app = Fastify({ logger: false });
    await storageFastifyPlugin(app as never, {
      storage: s1,
      publicBaseUrl: 'http://localhost/files',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'image/png', 'x-file-name': 'f.png' },
      payload: PNG,
    });
    expect(res.statusCode, res.body).toBe(201);
    await app.close();

    const s2 = storage();
    const hono = new Hono();
    hono.all(
      '/files/*',
      createStorageHonoHandler({
        storage: s2,
        basePath: '/files',
        publicBaseUrl: 'http://localhost/files',
      }) as never,
    );
    const hres = await hono.request('http://localhost/files/', {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-file-name': 'h.png' },
      body: PNG,
    });
    expect(hres.status).toBe(201);
  });
});
