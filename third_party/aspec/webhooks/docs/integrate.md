# Integrate

```ts
import { createWebhooks, createDeliveryJobHandler, DELIVER_JOB_NAME, verifyWebhookSignature } from '@aspec/webhooks';
import { createMemoryStore, createMemorySeenIdStore } from '@aspec/webhooks/memory';

export const webhooks = createWebhooks({
  store: createMemoryStore(),
  security: { encryptionKey: process.env.WEBHOOKS_ENCRYPTION_KEY! },
  // jobs: queue,
});

// worker.register(DELIVER_JOB_NAME, createDeliveryJobHandler(webhooks));

export function verifyIncoming(rawBody: Buffer, headers: Headers) {
  const verified = verifyWebhookSignature(rawBody, headers, {
    scheme: 'standard',
    secrets: [process.env.INCOMING_WEBHOOK_SECRET!],
  });
  return verified;
}
```

Mount an admin router from `@aspec/webhooks/express` (or fastify/hono/fetch) with
`resolveSubject` and optional `PermissionChecker`.
