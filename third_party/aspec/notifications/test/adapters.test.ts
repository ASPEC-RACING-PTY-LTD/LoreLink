import type { AddressInfo } from 'node:net';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createNotificationsRouter } from '../src/adapters/express.js';
import { notificationsFastifyPlugin } from '../src/adapters/fastify.js';
import { createNotificationsFetchHandler } from '../src/adapters/fetch.js';
import { createNotificationsHono } from '../src/adapters/hono.js';
import { createNotifications } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';
import { fakeClock, sequentialIds } from './helpers/fakes.js';

async function seed() {
  const service = createNotifications({
    store: createMemoryStore(),
    clock: fakeClock(),
    generateId: sequentialIds('api'),
    preferences: {
      categories: {
        security: { mandatory: true, channels: ['in-app'] },
        marketing: { channels: ['in-app'] },
      },
    },
  });
  await service.notify({
    to: { userId: 'user-1' },
    category: 'security',
    content: { message: { title: 'Hello', body: 'World' } },
    channels: ['in-app'],
  });
  return service;
}

describe.each([
  { name: 'Express 5', create: () => express5() },
  { name: 'Express 4', create: () => express4() },
])('$name notifications router', ({ create }) => {
  it('lists, marks read and manages preferences', async () => {
    const service = await seed();
    const app = create();
    app.use(
      '/api/notifications',
      createNotificationsRouter(service, {
        resolveUser: () => 'user-1',
      }),
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications`;
      const list = await fetch(base);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: Array<{ id: string }> };
      expect(body.items).toHaveLength(1);
      const id = body.items[0]!.id;
      expect((await fetch(`${base}/unread-count`)).status).toBe(200);
      expect((await fetch(`${base}/${id}/read`, { method: 'POST' })).status).toBe(204);
      const prefs = await fetch(`${base}/preferences`);
      expect(prefs.status).toBe(200);
      const put = await fetch(`${base}/preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          updates: [{ category: 'marketing', channel: 'in-app', enabled: false }],
        }),
      });
      expect(put.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Fastify notifications plugin', () => {
  it('serves the API via inject', async () => {
    const service = await seed();
    const app = Fastify();
    await app.register(notificationsFastifyPlugin, {
      prefix: '/api/notifications',
      service,
      resolveUser: () => 'user-1',
    });
    const list = await app.inject({ method: 'GET', url: '/api/notifications/' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    await app.close();
  });
});

describe('Hono notifications app', () => {
  it('serves the API via app.request', async () => {
    const service = await seed();
    const app = new Hono();
    app.route(
      '/api/notifications',
      createNotificationsHono(service, { resolveUser: () => 'user-1' }),
    );
    const res = await app.request('http://localhost/api/notifications');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('Fetch notifications handler', () => {
  it('serves the API and returns 401 without a user', async () => {
    const service = await seed();
    const handler = createNotificationsFetchHandler(service, {
      basePath: '/api/notifications',
      resolveUser: (req) => req.headers.get('x-user-id'),
    });
    const denied = await handler(new Request('http://localhost/api/notifications/'));
    expect(denied.status).toBe(401);
    const ok = await handler(
      new Request('http://localhost/api/notifications/', { headers: { 'x-user-id': 'user-1' } }),
    );
    expect(ok.status).toBe(200);
  });
});
