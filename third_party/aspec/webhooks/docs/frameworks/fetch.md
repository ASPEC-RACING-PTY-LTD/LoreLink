# Fetch API

```ts
import { createWebhooksAdminFetchHandler, verifyFetchWebhook } from '@aspec/webhooks/fetch';

export default createWebhooksAdminFetchHandler(webhooks, {
  basePath: '/admin/webhooks',
  resolveSubject: async (req) => ({ id: 'admin' }),
});

// Incoming:
const { verified, rawBody } = await verifyFetchWebhook(request, {
  scheme: 'standard',
  secrets: [secret],
});
```
