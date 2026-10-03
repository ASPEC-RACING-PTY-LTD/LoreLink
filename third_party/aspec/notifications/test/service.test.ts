import { describe, expect, it } from 'vitest';
import { createEmailChannel } from '../src/email.js';
import { createDeliveryJobHandler, createNotifications, DELIVER_JOB_NAME } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';
import { createTemplateRegistry } from '../src/templates.js';
import {
  fakeClock,
  memoryQueue,
  noSleep,
  recordingProvider,
  recordingTransport,
  sequentialIds,
} from './helpers/fakes.js';

function build(
  opts: {
    store?: ReturnType<typeof createMemoryStore>;
    jobs?: ReturnType<typeof memoryQueue>;
    emailScript?: Array<'ok' | 'transient' | 'permanent'>;
    messageScript?: Array<'ok' | 'transient' | 'permanent'>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const clock = fakeClock();
  const store = opts.store ?? createMemoryStore();
  const transport = recordingTransport(opts.emailScript ?? []);
  const message = recordingProvider('message', opts.messageScript ?? []);
  const templates = createTemplateRegistry({
    defaultLocale: 'en',
    email: [
      {
        id: 'welcome',
        subject: 'Hi {{ name }}',
        text: 'Hello {{ name }}',
        html: '<p>Hello {{ name }}</p>',
        requiredVariables: ['name'],
      },
    ],
    notifications: [
      { id: 'alert', title: 'Alert', body: '{{ message }}', requiredVariables: ['message'] },
      {
        id: 'alert',
        channel: 'push',
        title: 'Alert',
        body: '{{ message }}',
        requiredVariables: ['message'],
      },
    ],
  });
  const service = createNotifications({
    store,
    templates,
    channels: {
      email: createEmailChannel(transport, { from: 'noreply@example.test' }),
      push: message,
    },
    preferences: {
      categories: {
        security: {
          mandatory: true,
          description: 'Security notices',
          channels: ['email', 'in-app'],
        },
        marketing: { channels: ['in-app'] },
      },
      defaultChannels: ['email', 'in-app'],
    },
    clock,
    generateId: sequentialIds(),
    sleep: opts.sleep ?? noSleep,
    random: () => 0,
    retry: { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100, jitter: 0 },
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
  });
  return { service, store, transport, message, clock, templates };
}

describe('createNotifications', () => {
  it('delivers email and in-app inline with tracking', async () => {
    const { service, transport } = build();
    const result = await service.notify({
      to: { userId: 'u1', email: 'u1@example.test' },
      category: 'security',
      template: 'welcome',
      data: { name: 'Ada' },
      content: { message: { title: 'Welcome Ada', body: 'Thanks for joining' } },
      channels: ['email', 'in-app'],
    });
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.every((d) => d.status === 'sent')).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.subject).toBe('Hi Ada');
    const inbox = await service.listNotifications('u1');
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.title).toBe('Welcome Ada');
  });

  it('skips opted-out channels and refuses mandatory opt-out', async () => {
    const { service } = build();
    await expect(
      service.setPreference('u1', { category: 'security', channel: 'email', enabled: false }),
    ).rejects.toMatchObject({ code: 'NOTIFICATIONS_PREFERENCE_MANDATORY' });

    await service.setPreference('u1', { category: 'marketing', channel: 'email', enabled: false });
    const result = await service.notify({
      to: { userId: 'u1', email: 'u1@example.test' },
      category: 'marketing',
      content: { email: { subject: 'Sale', text: 'Buy' }, message: { title: 'Sale', body: 'Buy' } },
      channels: ['email', 'in-app'],
    });
    const email = result.deliveries.find((d) => d.channel === 'email');
    const inApp = result.deliveries.find((d) => d.channel === 'in-app');
    expect(email?.status).toBe('skipped');
    expect(email?.skipReason).toBe('preference');
    expect(inApp?.status).toBe('sent');
  });

  it('retries transient failures and fails permanently on 5xx class', async () => {
    const transient = build({ emailScript: ['transient', 'ok'] });
    const ok = await transient.service.notify({
      to: { email: 'a@example.test' },
      category: 'security',
      content: { email: { subject: 't', text: 't' } },
      channels: ['email'],
    });
    expect(ok.deliveries[0]?.status).toBe('sent');
    expect(transient.transport.calls).toBe(2);

    const permanent = build({ emailScript: ['permanent'] });
    const fail = await permanent.service.notify({
      to: { email: 'a@example.test' },
      category: 'security',
      content: { email: { subject: 't', text: 't' } },
      channels: ['email'],
    });
    expect(fail.deliveries[0]?.status).toBe('failed');
    expect(fail.deliveries[0]?.errorClass).toBe('permanent');
    expect(permanent.transport.calls).toBe(1);
  });

  it('enqueues delivery jobs and processes them with the JobQueue handler', async () => {
    const jobs = memoryQueue();
    const { service, transport } = build({ jobs });
    const result = await service.notify({
      to: { email: 'a@example.test' },
      category: 'security',
      content: { email: { subject: 't', text: 'body' } },
      channels: ['email'],
    });
    expect(result.deliveries[0]?.status).toBe('queued');
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]?.name).toBe(DELIVER_JOB_NAME);
    const handler = createDeliveryJobHandler(service);
    await handler(jobs.jobs[0]?.payload, { signal: AbortSignal.timeout(5000), attempt: 1 });
    const delivery = await service.getDelivery(result.deliveries[0]!.id);
    expect(delivery.delivery.status).toBe('sent');
    expect(transport.sent).toHaveLength(1);
  });

  it('implements the Mailer port with tracking', async () => {
    const { service, transport } = build();
    const sent = await service.mailer.send({
      to: 'mailer@example.test',
      subject: 'Hello',
      text: 'World',
      category: 'security',
      metadata: { userId: 'u9' },
    });
    expect(sent.id).toBeTruthy();
    expect(transport.sent[0]?.to).toBe('mailer@example.test');
    const history = await service.listDeliveries({ userId: 'u9' });
    expect(history.items.length).toBeGreaterThanOrEqual(1);
  });

  it('supports in-app mark read, unread count, archive and delete', async () => {
    const { service } = build();
    await service.notify({
      to: { userId: 'u1' },
      category: 'security',
      content: { message: { title: 'T', body: 'B' } },
      channels: ['in-app'],
    });
    expect(await service.unreadCount('u1')).toBe(1);
    const list = await service.listNotifications('u1');
    const id = list.items[0]!.id;
    await service.markRead('u1', id);
    expect(await service.unreadCount('u1')).toBe(0);
    await service.archive('u1', id);
    const archived = await service.listNotifications('u1', {
      includeArchived: true,
      archivedOnly: true,
    });
    expect(archived.items).toHaveLength(1);
    await service.deleteNotification('u1', id);
    expect((await service.listNotifications('u1', { includeArchived: true })).items).toHaveLength(
      0,
    );
  });

  it('deduplicates by idempotencyKey per channel', async () => {
    const { service, transport } = build();
    const a = await service.notify({
      to: { email: 'a@example.test' },
      category: 'security',
      content: { email: { subject: '1', text: '1' } },
      channels: ['email'],
      idempotencyKey: 'once',
    });
    const b = await service.notify({
      to: { email: 'a@example.test' },
      category: 'security',
      content: { email: { subject: '2', text: '2' } },
      channels: ['email'],
      idempotencyKey: 'once',
    });
    expect(a.deliveries[0]?.id).toBe(b.deliveries[0]?.id);
    expect(transport.sent).toHaveLength(1);
  });

  it('queries delivery history by category, channel and status', async () => {
    const { service } = build();
    await service.notify({
      to: { userId: 'u1', email: 'u1@example.test' },
      category: 'security',
      content: { email: { subject: 's', text: 't' }, message: { title: 't', body: 'b' } },
      channels: ['email', 'in-app'],
    });
    const page = await service.listDeliveries({
      category: 'security',
      channel: 'email',
      status: 'sent',
    });
    expect(page.items).toHaveLength(1);
    const detail = await service.getDelivery(page.items[0]!.id);
    expect(detail.attempts.length).toBeGreaterThanOrEqual(1);
  });
});
