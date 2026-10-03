# Fastify

```ts
import Fastify from 'fastify';
import { notificationsFastifyPlugin } from '@aspec/notifications/fastify';
import { notifications } from './aspec/notifications.setup.js';

const app = Fastify();
await app.register(notificationsFastifyPlugin, {
  prefix: '/api/notifications',
  service: notifications,
  resolveUser: (req) => (req.user as { id?: string } | undefined)?.id,
});
```
