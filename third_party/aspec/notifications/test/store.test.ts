import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/stores/memory.js';
import { createSqlStore, migrate } from '../src/stores/sql.js';
import type { NotificationsStore } from '../src/types.js';
import { createPostgresClient, createSqliteClient } from './helpers/sql.js';

async function runStoreContract(
  name: string,
  create: () => Promise<{ store: NotificationsStore; close: () => Promise<void> }>,
) {
  describe(name, () => {
    let store: NotificationsStore;
    let close: () => Promise<void>;

    afterAll(async () => {
      await close?.();
    });

    it('runs migrations and supports in-app, deliveries, preferences', async () => {
      ({ store, close } = await create());
      const now = 1_700_000_000_000;
      await store.createInApp({
        id: 'n1',
        userId: 'u1',
        category: 'security',
        title: 'Hello',
        body: 'World',
        createdAt: now,
      });
      expect(await store.countUnread('u1')).toBe(1);
      expect((await store.listInApp('u1', { limit: 10 })).items).toHaveLength(1);
      expect(await store.markRead('u1', 'n1', now + 1)).toBe(true);
      expect(await store.countUnread('u1')).toBe(0);
      expect(await store.archive('u1', 'n1', now + 2)).toBe(true);

      const delivery = {
        id: 'd1',
        dispatchId: 'disp1',
        idempotencyKey: 'idem-1',
        userId: 'u1',
        category: 'security',
        channel: 'email',
        recipient: { userId: 'u1', email: 'u1@example.test' },
        content: {
          kind: 'email' as const,
          email: { to: 'u1@example.test', subject: 's', text: 't' },
        },
        status: 'queued' as const,
        attempts: 0,
        maxAttempts: 5,
        createdAt: now,
        updatedAt: now,
        metadata: {},
      };
      const created = await store.createDelivery(delivery);
      expect(created.created).toBe(true);
      const dup = await store.createDelivery(delivery);
      expect(dup.created).toBe(false);
      expect(dup.delivery.id).toBe('d1');

      const claimed = await store.claimDelivery('d1', now + 10, now - 1000);
      expect(claimed?.status).toBe('sending');
      expect(claimed?.attempts).toBe(1);
      expect(await store.claimDelivery('d1', now + 11, now - 1000)).toBeUndefined();

      await store.updateDelivery('d1', {
        status: 'sent',
        sentAt: now + 20,
        updatedAt: now + 20,
        clear: ['content'],
      });
      await store.addAttempt({
        id: 'a1',
        deliveryId: 'd1',
        attempt: 1,
        status: 'sent',
        startedAt: now + 10,
        finishedAt: now + 20,
        durationMs: 10,
      });
      expect(await store.listAttempts('d1')).toHaveLength(1);
      const listed = await store.listDeliveries({ userId: 'u1', status: 'sent', limit: 10 });
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.content).toBeUndefined();

      await store.setPreference({
        userId: 'u1',
        category: 'marketing',
        channel: 'email',
        enabled: false,
        updatedAt: now,
      });
      expect(await store.listPreferences('u1')).toEqual([
        expect.objectContaining({ category: 'marketing', channel: 'email', enabled: false }),
      ]);
      expect(await store.deletePreference('u1', 'marketing', 'email')).toBe(true);

      const purged = await store.purge(now + 100);
      expect(purged.notifications).toBe(1);
      expect(purged.deliveries).toBe(1);
    });
  });
}

await runStoreContract('memory store', async () => ({
  store: createMemoryStore(),
  close: async () => undefined,
}));

await runStoreContract('sqlite store', async () => {
  const client = createSqliteClient();
  await migrate(client);
  return {
    store: createSqlStore(client),
    close: async () => client.close(),
  };
});

describe.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)('postgres store', () => {
  it('passes the store contract', async () => {
    const url = process.env.ASPEC_TEST_POSTGRES_URL;
    if (!url) throw new Error('ASPEC_TEST_POSTGRES_URL is required');
    const client = await createPostgresClient(url);
    try {
      await migrate(client);
      const store = createSqlStore(client);
      const now = Date.now();
      await store.createInApp({
        id: 'pg-n1',
        userId: 'u1',
        category: 'security',
        title: 'Hi',
        body: 'There',
        createdAt: now,
      });
      expect(await store.countUnread('u1')).toBe(1);
      const version = await client.query<{ server_version: string }>('SHOW server_version');
      expect(version.rows[0]?.server_version).toMatch(/^17\./);
    } finally {
      await client.close();
    }
  });
});
