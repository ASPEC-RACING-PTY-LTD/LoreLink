# Examples

## Background delivery

```ts
import { createDeliveryJobHandler, DELIVER_JOB_NAME, createNotifications } from '@aspec/notifications';

const notifications = createNotifications({ store, channels, jobs: queue });
worker.register(DELIVER_JOB_NAME, createDeliveryJobHandler(notifications));
```

## SQL store

```ts
import { createSqlStore, migrate } from '@aspec/notifications/sql';

await migrate(sql);
const store = createSqlStore(sql);
```

## Slack channel

```ts
import { createSlackProvider } from '@aspec/notifications/slack';

const channels = {
  slack: createSlackProvider({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
};
```

## Preferences

```ts
await notifications.setPreferences('u1', [
  { category: 'marketing', channel: 'email', enabled: false },
]);
// security is mandatory: disabling it throws NOTIFICATIONS_PREFERENCE_MANDATORY
```
