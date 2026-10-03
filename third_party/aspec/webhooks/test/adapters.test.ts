import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  createWebhooksAdminRouter,
  preserveRawBody,
  verifyWebhookMiddleware,
} from '../src/adapters/express.js';
import { registerRawBodyParser, webhooksAdminFastifyPlugin } from '../src/adapters/fastify.js';
import { createWebhooksAdminFetchHandler, verifyFetchWebhook } from '../src/adapters/fetch.js';
import { createWebhooksAdminHono, verifyWebhookHono } from '../src/adapters/hono.js';
import { generateWebhookSecret, signStandardWebhooks } from '../src/crypto.js';
import { createWebhooks } from '../src/service.js';
import { createMemorySeenIdStore, createMemoryStore } from '../src/stores/memory.js';

const key = randomBytes(32).toString('base64');

function service() {
  return createWebhooks({
    store: createMemoryStore(),
    security: {
      encryptionKey: key,
      ssrf: { requireHttps: false, allowHosts: ['127.0.0.1'], allowNonDefaultPorts: true },
    },
  });
}

describe.each([
  { name: 'Express 5', create: () => express5() },
  { name: 'Express 4', create: () => express4() },
])('$name admin + raw body verify', ({ create }) => {
  it('creates subscriptions and verifies incoming signatures', async () => {
    const svc = service();
    const app = create();
    app.use('/admin', createWebhooksAdminRouter(svc, { resolveSubject: () => ({ id: 'admin' }) }));
    const secret = generateWebhookSecret();
    app.use(
      '/hooks',
      preserveRawBody(),
      verifyWebhookMiddleware({ scheme: 'standard', secrets: [secret] }),
      (req, res) => {
        res.json({ ok: true, id: req.webhook?.id });
      },
    );
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const created = await fetch(`${base}/admin/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/h', eventTypes: ['*'] }),
      });
      expect(created.status).toBe(201);
      const body = '{"ping":true}';
      const id = 'msg_in';
      const ts = Math.floor(Date.now() / 1000);
      const sig = signStandardWebhooks(id, ts, body, [secret]);
      const verified = await fetch(`${base}/hooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': sig,
        },
        body,
      });
      expect(verified.status).toBe(200);
      expect(await verified.json()).toEqual({ ok: true, id });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await svc.close();
    }
  });
});

describe('Fastify / Hono / Fetch adapters', () => {
  it('serves admin via Fastify inject', async () => {
    const svc = service();
    const app = Fastify();
    registerRawBodyParser(app);
    await app.register(webhooksAdminFastifyPlugin, {
      prefix: '/admin',
      service: svc,
      resolveSubject: () => ({ id: 'a' }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/subscriptions',
      payload: { url: 'https://example.test/h' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
    await svc.close();
  });

  it('serves admin via Hono and verifies with middleware', async () => {
    const svc = service();
    const secret = generateWebhookSecret();
    const app = new Hono();
    app.route('/admin', createWebhooksAdminHono(svc, { resolveSubject: () => ({ id: 'a' }) }));
    app.post(
      '/hooks',
      verifyWebhookHono({
        scheme: 'standard',
        secrets: [secret],
        seenIds: createMemorySeenIdStore(),
      }),
      (c) => c.json({ ok: true }),
    );
    const created = await app.request('http://localhost/admin/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/h' }),
    });
    expect(created.status).toBe(201);
    const body = '{}';
    const id = 'msg_h';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStandardWebhooks(id, ts, body, [secret]);
    const ok = await app.request('http://localhost/hooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': sig,
      },
      body,
    });
    expect(ok.status).toBe(200);
    await svc.close();
  });

  it('serves admin via Fetch handler and verifyFetchWebhook', async () => {
    const svc = service();
    const handler = createWebhooksAdminFetchHandler(svc, {
      basePath: '/admin',
      resolveSubject: () => ({ id: 'a' }),
    });
    const created = await handler(
      new Request('http://localhost/admin/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/h' }),
      }),
    );
    expect(created.status).toBe(201);
    const secret = generateWebhookSecret();
    const body = '{}';
    const id = 'msg_f';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStandardWebhooks(id, ts, body, [secret]);
    const { verified } = await verifyFetchWebhook(
      new Request('http://localhost/hooks', {
        method: 'POST',
        headers: {
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': sig,
        },
        body,
      }),
      { scheme: 'standard', secrets: [secret] },
    );
    expect(verified.id).toBe(id);
    await svc.close();
  });
});
