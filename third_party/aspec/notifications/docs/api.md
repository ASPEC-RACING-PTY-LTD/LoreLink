# API

## `@aspec/notifications`

| Export | Description |
|--------|-------------|
| `createNotifications(options)` | Creates the notification service |
| `createDeliveryJobHandler(service)` | JobQueue handler for `notifications.deliver` |
| `DELIVER_JOB_NAME` | `"notifications.deliver"` |
| `IN_APP_CHANNEL` | `"in-app"` |
| `createMailer(transport, options?)` | Standalone Mailer port |
| `createEmailChannel(transport, options?)` | Email `NotificationProvider` |
| `createConsoleChannel(options?)` | Logs messages to a writer |
| `createTemplateRegistry(options)` | Email and notification templates |
| `compileTemplate` / `renderTemplate` / `escapeHtml` / `htmlToText` | Template helpers |
| Error classes | `NotificationsError`, `NotificationProviderError`, `isNotificationsError` |

### NotificationsService

`notify`, `processDeliveryJob`, `resumePending`, `listNotifications`, `getNotification`,
`unreadCount`, `markRead`, `markAllRead`, `archive`, `deleteNotification`,
`getPreferences`, `setPreference`, `setPreferences`, `resetPreference`,
`listDeliveries`, `getDelivery`, `queryNotifications`, `purge`, `checkHealth`, `close`,
`mailer`, `channels`.

## Subpaths

| Subpath | Exports |
|---------|---------|
| `./memory` | `createMemoryStore` |
| `./sql` | `createSqlStore`, `migrate`, `migrations`, `createMigrations` |
| `./smtp` | `createSmtpTransport`, `smtpOptionsFromEnv`, `classifySmtpError` |
| `./slack` | `createSlackProvider` |
| `./webhook` | `createHttpWebhookProvider` |
| `./express` | `createNotificationsRouter` |
| `./fastify` | `notificationsFastifyPlugin` |
| `./hono` | `createNotificationsHono` |
| `./fetch` | `createNotificationsFetchHandler` |
