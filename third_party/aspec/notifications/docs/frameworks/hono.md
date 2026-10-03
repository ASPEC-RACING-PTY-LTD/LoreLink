# Hono

```ts
import { Hono } from 'hono';
import { createNotificationsHono } from '@aspec/notifications/hono';
import { notifications } from './aspec/notifications.setup.js';

const app = new Hono();
app.route(
  '/api/notifications',
  createNotificationsHono(notifications, {
    resolveUser: (c) => c.get('userId'),
  }),
);
```
