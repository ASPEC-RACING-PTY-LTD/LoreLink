# Fetch API

```ts
import { createNotificationsFetchHandler } from '@aspec/notifications/fetch';
import { notifications } from './aspec/notifications.setup.js';

export const GET = createNotificationsFetchHandler(notifications, {
  basePath: '/api/notifications',
  resolveUser: (req) => req.headers.get('x-user-id'),
});

// Or a single handler for all methods:
export default createNotificationsFetchHandler(notifications, {
  basePath: '/api/notifications',
  resolveUser: async (req) => {
    /* resolve session */
    return null;
  },
});
```

Compatible with runtimes that expose the Fetch API. Only Node was tested.
