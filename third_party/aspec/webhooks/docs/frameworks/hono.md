# Hono

```ts
import { createWebhooksAdminHono, verifyWebhookHono } from '@aspec/webhooks/hono';

app.route('/admin/webhooks', createWebhooksAdminHono(webhooks, {
  resolveSubject: (c) => c.get('subject'),
}));
app.post('/hooks', verifyWebhookHono({ scheme: 'standard', secrets: [secret] }), handler);
```
