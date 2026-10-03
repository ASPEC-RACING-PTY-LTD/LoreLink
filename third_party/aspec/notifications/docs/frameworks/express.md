# Express

Works with Express 4 and 5.

```ts
import express from 'express';
import { createNotificationsRouter } from '@aspec/notifications/express';
import { notifications } from './aspec/notifications.setup.js';

const app = express();
app.use(
  '/api/notifications',
  createNotificationsRouter(notifications, {
    resolveUser: (req) => (req as { user?: { id: string } }).user?.id,
  }),
);
```

Routes: list, unread-count, read-all, preferences, get/read/archive/delete by id.
Works with or without `express.json()`.
