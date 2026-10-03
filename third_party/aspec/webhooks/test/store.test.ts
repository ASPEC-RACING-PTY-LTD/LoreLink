import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/stores/memory.js';
import { createSqlStore, migrate } from '../src/stores/sql.js';
import type { WebhooksStore } from '../src/types.js';
import { createPostgresClient, createSqliteClient } from './helpers/sql.js';

async function contract(
  name: string,
  create: () => Promise<{ store: WebhooksStore; close: () => Promise<void> }>,
) {
  describe(name, () => {
    let store: WebhooksStore;
    let close: () => Promise<void>;
    afterAll(async () => {
      await close?.();
    });

    it('persists subscriptions, events and deliveries', async () => {
      ({ store, close } = await create());
      const now = 1_700_000_000_000;
      await store.createSubscription({
        id: 's1',
        url: 'https://example.test/hook',
        status: 'active',
        eventTypes: ['invoice.*'],
        secrets: [{ id: 'sec', ciphertext: 'x', createdAt: now }],
        metadata: {},
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      });
      expect((await store.getSubscription('s1'))?.url).toBe('https://example.test/hook');
      const { event, created } = await store.createEvent({
        id: 'e1',
        type: 'invoice.paid',
        payload: { a: 1 },
        createdAt: now,
        idempotencyKey: 'idem',
      });
      expect(created).toBe(true);
      const again = await store.createEvent({
        id: 'e2',
        type: 'invoice.paid',
        payload: { a: 1 },
        createdAt: now,
        idempotencyKey: 'idem',
      });
      expect(again.created).toBe(false);
      expect(again.event.id).toBe(event.id);

      await store.createDelivery({
        id: 'd1',
        subscriptionId: 's1',
        eventId: 'e1',
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      const claimed = await store.claimDelivery('d1', now + 1, now - 1000);
      expect(claimed?.status).toBe('sending');
      expect(claimed?.attempts).toBe(1);
      await store.addAttempt({
        id: 'a1',
        deliveryId: 'd1',
        attempt: 1,
        requestHeaders: {},
        responseStatus: 200,
        durationMs: 5,
        createdAt: now + 2,
      });
      expect(await store.listAttempts('d1')).toHaveLength(1);
    });
  });
}

await contract('memory', async () => ({
  store: createMemoryStore(),
  close: async () => undefined,
}));

await contract('sqlite', async () => {
  const client = createSqliteClient();
  await migrate(client);
  return { store: createSqlStore(client), close: async () => client.close() };
});

describe.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)('postgres', () => {
  it('migrates and stores rows', async () => {
    const url = process.env.ASPEC_TEST_POSTGRES_URL;
    if (!url) throw new Error('missing postgres url');
    const client = await createPostgresClient(url);
    try {
      await migrate(client);
      const store = createSqlStore(client);
      await store.createSubscription({
        id: 'pg-s',
        url: 'https://example.test/h',
        status: 'active',
        eventTypes: [],
        secrets: [],
        metadata: {},
        consecutiveFailures: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(await store.getSubscription('pg-s')).toBeTruthy();
    } finally {
      await client.close();
    }
  });
});
