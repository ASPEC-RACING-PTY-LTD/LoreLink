import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, describe, expect, it } from 'vitest';
import { createEmailChannel } from '../src/email.js';
import { classifySmtpError, createSmtpTransport } from '../src/providers/smtp.js';
import { createNotifications } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';
import { fakeClock, noSleep, sequentialIds } from './helpers/fakes.js';

describe('classifySmtpError', () => {
  it('treats 4xx as transient and 5xx as permanent', () => {
    expect(classifySmtpError({ responseCode: 451, message: 'try later' }).errorClass).toBe(
      'transient',
    );
    expect(classifySmtpError({ responseCode: 550, message: 'no mailbox' }).errorClass).toBe(
      'permanent',
    );
    expect(classifySmtpError({ code: 'ETIMEDOUT', message: 'timeout' }).errorClass).toBe(
      'transient',
    );
    expect(classifySmtpError({ code: 'EAUTH', message: 'auth' }).errorClass).toBe('permanent');
  });
});

describe('in-process smtp-server retries', () => {
  it('retries on 4xx and fails immediately on 5xx', async () => {
    let hits = 0;
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        hits++;
        stream.on('data', () => undefined);
        stream.on('end', () => {
          if (hits === 1) {
            callback(Object.assign(new Error('451 Try again'), { responseCode: 451 }));
            return;
          }
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.server.address() as AddressInfo).port;
    try {
      const transport = createSmtpTransport({
        host: '127.0.0.1',
        port,
        secure: false,
        ignoreTLS: true,
        tls: { rejectUnauthorized: false },
        from: 'noreply@example.test',
        connectionTimeoutMs: 2000,
        greetingTimeoutMs: 2000,
        socketTimeoutMs: 2000,
      });
      const service = createNotifications({
        store: createMemoryStore(),
        channels: { email: createEmailChannel(transport) },
        clock: fakeClock(),
        generateId: sequentialIds(),
        sleep: noSleep,
        random: () => 0,
        retry: { maxAttempts: 3, initialDelayMs: 1, multiplier: 1, maxDelayMs: 1, jitter: 0 },
      });
      const result = await service.notify({
        to: { email: 'user@example.test' },
        category: 'security',
        content: { email: { subject: 'Hi', text: 'body' } },
        channels: ['email'],
      });
      expect(result.deliveries[0]?.status).toBe('sent');
      expect(hits).toBe(2);
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    hits = 0;
    const permanent = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        hits++;
        stream.on('data', () => undefined);
        stream.on('end', () => {
          callback(Object.assign(new Error('550 No such user'), { responseCode: 550 }));
        });
      },
    });
    await new Promise<void>((resolve) => permanent.listen(0, '127.0.0.1', () => resolve()));
    const pport = (permanent.server.address() as AddressInfo).port;
    try {
      const transport = createSmtpTransport({
        host: '127.0.0.1',
        port: pport,
        secure: false,
        ignoreTLS: true,
        tls: { rejectUnauthorized: false },
        from: 'noreply@example.test',
      });
      const service = createNotifications({
        store: createMemoryStore(),
        channels: { email: createEmailChannel(transport) },
        clock: fakeClock(),
        generateId: sequentialIds('p'),
        sleep: noSleep,
        random: () => 0,
        retry: { maxAttempts: 3, initialDelayMs: 1, multiplier: 1, maxDelayMs: 1, jitter: 0 },
      });
      const result = await service.notify({
        to: { email: 'user@example.test' },
        category: 'security',
        content: { email: { subject: 'Hi', text: 'body' } },
        channels: ['email'],
      });
      expect(result.deliveries[0]?.status).toBe('failed');
      expect(result.deliveries[0]?.errorClass).toBe('permanent');
      expect(hits).toBe(1);
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => permanent.close(() => resolve()));
    }
  });
});

describe.skipIf(!process.env.ASPEC_TEST_SMTP_HOST || !process.env.ASPEC_TEST_MAILPIT_API)(
  'Mailpit SMTP',
  () => {
    const host = process.env.ASPEC_TEST_SMTP_HOST ?? '';
    const port = Number(process.env.ASPEC_TEST_SMTP_PORT ?? '51025');
    const api = process.env.ASPEC_TEST_MAILPIT_API ?? '';

    afterAll(async () => {
      await fetch(`${api}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);
    });

    it('delivers mail that Mailpit receives', async () => {
      const transport = createSmtpTransport({
        host,
        port,
        secure: false,
        ignoreTLS: true,
        tls: { rejectUnauthorized: false },
        from: 'aspec-test@example.test',
      });
      const service = createNotifications({
        store: createMemoryStore(),
        channels: { email: createEmailChannel(transport) },
        clock: fakeClock(),
        generateId: sequentialIds('mail'),
        sleep: noSleep,
      });
      const token = `mailpit-${Date.now()}`;
      const result = await service.notify({
        to: { email: 'recipient@example.test' },
        category: 'security',
        content: { email: { subject: token, text: `body ${token}`, html: `<p>${token}</p>` } },
        channels: ['email'],
      });
      expect(result.deliveries[0]?.status).toBe('sent');
      await transport.close();

      let found = false;
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${api}/api/v1/search?query=${encodeURIComponent(token)}`);
        const data = (await res.json()) as { messages?: Array<{ Subject?: string }> };
        if (data.messages?.some((m) => m.Subject === token)) {
          found = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(found).toBe(true);
    });

    it('reports healthy SMTP via checkHealth', async () => {
      const transport = createSmtpTransport({
        host,
        port,
        secure: false,
        ignoreTLS: true,
        tls: { rejectUnauthorized: false },
        from: 'aspec-test@example.test',
      });
      const health = await transport.checkHealth();
      expect(health.ok).toBe(true);
      await transport.close();
    });
  },
);
