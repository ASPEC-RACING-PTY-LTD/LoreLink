# @aspec/notifications

Email and in-app notifications for Node.js: SMTP delivery, transactional templates,
preferences, delivery tracking, retries, history and optional background delivery.

## Install

```bash
aspec add aspec/notifications
# or
pnpm add @aspec/notifications
```

Peers: `nodemailer` for SMTP (`@aspec/notifications/smtp`), and Express, Fastify or Hono
for the optional HTTP routers.

## Quick start

```ts
import { createNotifications, createEmailChannel, createTemplateRegistry } from '@aspec/notifications';
import { createMemoryStore } from '@aspec/notifications/memory';
import { createSmtpTransport } from '@aspec/notifications/smtp';

const transport = createSmtpTransport({ host: process.env.SMTP_HOST!, from: 'noreply@example.com' });
const notifications = createNotifications({
  store: createMemoryStore(),
  templates: createTemplateRegistry({
    email: [{ id: 'welcome', subject: 'Welcome {{ name }}', text: 'Hi {{ name }}' }],
  }),
  channels: { email: createEmailChannel(transport) },
  preferences: { categories: { security: { mandatory: true } } },
});

await notifications.notify({
  to: { userId: 'u1', email: 'ada@example.com' },
  category: 'security',
  template: 'welcome',
  data: { name: 'Ada' },
});
```

The service also implements the shared Mailer port as `notifications.mailer`.

## Docs

See [docs/summary.md](docs/summary.md) and the sections linked from `aspec.module.json`.
