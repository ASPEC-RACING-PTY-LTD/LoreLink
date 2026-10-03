# Integrate

```ts
import { createNotifications, createEmailChannel, createTemplateRegistry, createDeliveryJobHandler, DELIVER_JOB_NAME } from '@aspec/notifications';
import { createMemoryStore } from '@aspec/notifications/memory';
import { createSmtpTransport, smtpOptionsFromEnv } from '@aspec/notifications/smtp';

const transport = createSmtpTransport(smtpOptionsFromEnv());
const store = createMemoryStore();
const templates = createTemplateRegistry({
  email: [{ id: 'password-reset', subject: 'Reset {{ app }}', text: 'Code: {{ code }}', requiredVariables: ['app', 'code'] }],
  notifications: [{ id: 'password-reset', title: 'Password reset', body: 'Use code {{ code }}' }],
});

export const notifications = createNotifications({
  store,
  templates,
  channels: { email: createEmailChannel(transport) },
  preferences: {
    categories: {
      security: { mandatory: true, channels: ['email', 'in-app'] },
      marketing: { channels: ['in-app'] },
    },
  },
  // jobs: jobQueue, // optional background delivery
});

// Mailer port for @aspec/auth and similar consumers
export const mailer = notifications.mailer;

// With a JobQueue worker:
// worker.register(DELIVER_JOB_NAME, createDeliveryJobHandler(notifications));

await notifications.notify({
  to: { userId: 'u1', email: 'ada@example.com' },
  category: 'security',
  template: 'password-reset',
  data: { app: 'Acme', code: '123456' },
});
```

Wire the generated setup file into your app (mount routers, register the job handler).
The CLI never edits existing application files.
