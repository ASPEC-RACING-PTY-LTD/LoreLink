# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | for SMTP | SMTP hostname |
| `SMTP_PORT` | no | Default 587 (465 when `SMTP_SECURE=true`) |
| `SMTP_SECURE` | no | Implicit TLS (`true`/`false`) |
| `SMTP_REQUIRE_TLS` | no | Require STARTTLS |
| `SMTP_USER` / `SMTP_PASSWORD` | no | SMTP authentication |
| `SMTP_POOL` | no | Enable connection pooling |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | no | Certificate verification (default true) |
| `NOTIFICATIONS_EMAIL_FROM` | recommended | Default From mailbox |
| `SMTP_DKIM_DOMAIN` / `SMTP_DKIM_SELECTOR` / `SMTP_DKIM_PRIVATE_KEY` | no | DKIM signing |

Use `smtpOptionsFromEnv()` from `@aspec/notifications/smtp` to load these.

## Factory options

`createNotifications({ store, channels?, templates?, preferences?, jobs?, logger, clock, generateId, retry, inApp, resolveRecipient, retainContent, sendTimeoutMs, staleSendingMs })`

- `store`: memory or SQL store (required)
- `channels`: map of channel name to `NotificationProvider`
- `preferences.categories.<id>.mandatory`: when true, users cannot disable the category
- `retry`: `{ maxAttempts, initialDelayMs, multiplier, maxDelayMs, jitter }`
- `jobs`: optional JobQueue; when set, non-in-app deliveries enqueue `notifications.deliver`

SQL: `createSqlStore(client, { tablePrefix })` then `migrate(client, { tablePrefix })`.
Default prefix is `notifications_`.
