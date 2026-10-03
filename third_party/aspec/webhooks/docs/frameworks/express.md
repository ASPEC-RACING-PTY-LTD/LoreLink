# Express

```ts
import { createWebhooksAdminRouter, preserveRawBody, verifyWebhookMiddleware } from '@aspec/webhooks/express';

app.use('/admin/webhooks', createWebhooksAdminRouter(webhooks, {
  resolveSubject: (req) => (req as { user?: { id: string } }).user,
}));

app.post('/hooks', preserveRawBody(), verifyWebhookMiddleware({
  scheme: 'standard',
  secrets: [process.env.INCOMING_WEBHOOK_SECRET!],
}), handler);
```

Works with Express 4 and 5, with or without `express.json()`.
