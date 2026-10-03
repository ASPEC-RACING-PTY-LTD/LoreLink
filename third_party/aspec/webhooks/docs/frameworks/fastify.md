# Fastify

```ts
import { registerRawBodyParser, webhooksAdminFastifyPlugin, verifyWebhookFastifyHook } from '@aspec/webhooks/fastify';

registerRawBodyParser(app);
await app.register(webhooksAdminFastifyPlugin, {
  prefix: '/admin/webhooks',
  service: webhooks,
  resolveSubject: (req) => req.user,
});
```
