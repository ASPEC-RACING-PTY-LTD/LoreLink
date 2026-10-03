# @aspec/webhooks

Outgoing and incoming webhooks: subscriptions, Standard Webhooks signing, SSRF-safe delivery,
retries, history, secret rotation, event filtering and multi-scheme verification.

## Install

```bash
aspec add aspec/webhooks
# or
pnpm add @aspec/webhooks
```

Set `WEBHOOKS_ENCRYPTION_KEY` to a 32-byte key (base64 or 64-char hex).

## Quick start

```ts
import { createWebhooks } from '@aspec/webhooks';
import { createMemoryStore } from '@aspec/webhooks/memory';

const webhooks = createWebhooks({
  store: createMemoryStore(),
  security: {
    encryptionKey: process.env.WEBHOOKS_ENCRYPTION_KEY!,
    ssrf: { requireHttps: true },
  },
});

const { subscription, secret } = await webhooks.createSubscription({
  url: 'https://example.com/hooks',
  eventTypes: ['invoice.*'],
});
// secret is returned once; store it with the consumer

await webhooks.publish('invoice.paid', { id: 'inv_1' });
```

See docs/ for full documentation.
