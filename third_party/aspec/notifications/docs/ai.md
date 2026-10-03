# AI agent guide

## Purpose

Deliver transactional email and in-app notifications with templates, preferences,
tracking and retries.

## Use when

- You need SMTP email without a paid ESP for basic delivery
- Auth/users/orgs need a Mailer port implementation
- Users need an in-app inbox and notification preferences

## Avoid when

- You only need outbound signed webhooks (use `@aspec/webhooks`)
- You need SMS/push vendors without writing a `NotificationProvider`

## Prerequisites

Node `>=22.13.0`, optional `nodemailer`, optional framework peers, SMTP or console channel.

## Integration steps

1. Install `@aspec/notifications` and `nodemailer` if using SMTP.
2. Create a store (`createMemoryStore` or `createSqlStore` + `migrate`).
3. Register templates with `createTemplateRegistry`.
4. Create channels (`createEmailChannel(createSmtpTransport(...))`).
5. Call `createNotifications({ store, templates, channels, preferences })`.
6. Export `notifications.mailer` for Mailer consumers.
7. Optionally register `createDeliveryJobHandler(notifications)` for `notifications.deliver`.
8. Mount a framework router with `resolveUser`.

## Configuration

See `docs/configure.md` for env vars and options. Mark security categories `mandatory: true`.

## Verification

```bash
pnpm --filter @aspec/notifications test
# With Mailpit: set ASPEC_TEST_SMTP_* and ASPEC_TEST_MAILPIT_API
```

Expect `notify()` to return deliveries with status `sent` or `queued`.

## Common mistakes

- Forgetting `nodemailer` when importing `./smtp`
- Disabling mandatory categories
- Passing a template id without a registry
- Not calling `migrate` before using the SQL store

## Uninstall

See `docs/uninstall.md`.
