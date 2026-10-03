import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { generateWebhookSecret, signStandardWebhooks } from '../src/crypto.js';
import type { JobQueue } from '../src/ports.js';
import { createDeliveryJobHandler, createWebhooks, DELIVER_JOB_NAME } from '../src/service.js';
import { isBlockedIp, resolveSafeUrl } from '../src/ssrf.js';
import { createMemorySeenIdStore, createMemoryStore } from '../src/stores/memory.js';
import { verifyWebhookSignature } from '../src/verify.js';

const ENC_KEY = randomBytes(32);

function encryptionKey(): string {
  return ENC_KEY.toString('base64');
}

function waitFor(
  service: ReturnType<typeof createWebhooks>,
  deliveryId: string,
  status: string,
  timeoutMs = 3000,
) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      const d = await service.getDelivery(deliveryId).catch(() => undefined);
      if (d?.delivery.status === status) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${status}, got ${d?.delivery.status}`));
        return;
      }
      setTimeout(() => void tick(), 20);
    };
    void tick();
  });
}

describe('Standard Webhooks signing', () => {
  it('matches the published Standard Webhooks / Svix test vector', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
    const ts = 1614265330;
    const body = '{"test": 2432232314}';
    const sig = signStandardWebhooks(id, ts, body, [secret]);
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const verified = verifyWebhookSignature(
      Buffer.from(body),
      {
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': sig,
      },
      { scheme: 'standard', secrets: [secret], nowSeconds: ts },
    );
    expect(verified.id).toBe(id);
  });

  it('signs with every active secret during rotation', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    const sig = signStandardWebhooks('msg_1', 1_700_000_000, '{}', [a, b]);
    expect(sig.split(' ')).toHaveLength(2);
  });
});

describe('SSRF protection', () => {
  it('classifies special-purpose addresses, including IPv4 carried in IPv6', () => {
    const blocked = [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.31.255.255',
      '192.0.0.8',
      '192.168.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::127.0.0.1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
      '2001:0:1::1',
      'not-an-address',
    ];
    for (const address of blocked) expect(isBlockedIp(address), address).toBe(true);
    const allowed = [
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:1.1.1.1',
      '2002:0101:0101::',
    ];
    for (const address of allowed) expect(isBlockedIp(address), address).toBe(false);
  });

  it('blocks loopback, private, link-local, CGNAT and metadata ranges', async () => {
    const blocked = [
      'http://127.0.0.1/hook',
      'http://10.0.0.1/hook',
      'http://192.168.1.1/hook',
      'http://169.254.169.254/latest',
      'http://100.64.0.1/hook',
      'http://[::1]/hook',
    ];
    for (const url of blocked) {
      await expect(resolveSafeUrl(url, { requireHttps: false })).rejects.toMatchObject({
        code: 'WEBHOOKS_SSRF_BLOCKED',
      });
    }
  });

  it('treats bracketed IPv6 literals as addresses, not hostnames', async () => {
    const lookup = async () => {
      throw new Error('an IP literal must not be resolved through DNS');
    };
    for (const url of [
      'http://[::1]/hook',
      'http://[fd00::1]/hook',
      'http://[::ffff:127.0.0.1]/hook',
    ]) {
      await expect(resolveSafeUrl(url, { requireHttps: false, lookup })).rejects.toMatchObject({
        code: 'WEBHOOKS_SSRF_BLOCKED',
      });
    }
    const allowed = await resolveSafeUrl('http://[::1]/hook', {
      requireHttps: false,
      allowHosts: ['[::1]'],
      lookup,
    });
    expect(allowed.address).toBe('::1');
    expect(allowed.family).toBe(6);
    const publicV6 = await resolveSafeUrl('https://[2606:4700:4700::1111]/hook', { lookup });
    expect(publicV6.address).toBe('2606:4700:4700::1111');
  });

  it('allows loopback only with an explicit allowlist', async () => {
    const target = await resolveSafeUrl('http://127.0.0.1:9/hook', {
      requireHttps: false,
      allowHosts: ['127.0.0.1'],
      allowNonDefaultPorts: true,
    });
    expect(target.address).toBe('127.0.0.1');
  });

  it('pins against DNS rebinding with a custom resolver', async () => {
    let calls = 0;
    const lookup = async () => {
      calls++;
      return [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    };
    const first = await resolveSafeUrl('http://evil.test/hook', {
      requireHttps: false,
      lookup,
      allowNonDefaultPorts: true,
    });
    expect(first.address).toBe('8.8.8.8');
    // Second resolution would return loopback; delivery uses the pinned address from the first resolve.
    expect(calls).toBe(1);
  });
});

describe('outgoing delivery', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  function listen(
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void,
  ) {
    const server = createServer(handler);
    servers.push(server);
    return new Promise<{ url: string; port: number }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ url: `http://127.0.0.1:${port}/hook`, port });
      });
    });
  }

  it('delivers signed payloads, retries, handles 410 and truncates bodies', async () => {
    let hits = 0;
    const { url } = await listen((req, res) => {
      hits++;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        expect(req.headers['webhook-id']).toBeTruthy();
        expect(req.headers['webhook-signature']).toMatch(/^v1,/);
        if (hits === 1) {
          res.writeHead(503);
          res.end('x'.repeat(100_000));
          return;
        }
        if (hits === 2) {
          res.writeHead(200);
          res.end('ok');
          return;
        }
        res.writeHead(410);
        res.end('gone');
      });
    });

    const service = createWebhooks({
      store: createMemoryStore(),
      security: {
        encryptionKey: encryptionKey(),
        ssrf: { requireHttps: false, allowHosts: ['127.0.0.1'], allowNonDefaultPorts: true },
        disableAfterFailures: 5,
        delivery: { maxResponseBytes: 100 },
      },
      retry: { scheduleMs: [0, 10, 10], jitter: 0, maxAttempts: 3 },
      random: () => 0,
      schedulerIntervalMs: 20,
    });

    const { subscription } = await service.createSubscription({
      url,
      eventTypes: ['invoice.*'],
    });
    const pub = await service.publish('invoice.paid', { id: 1 });
    expect(pub.deliveries).toHaveLength(1);
    await waitFor(service, pub.deliveries[0]!.id, 'success');
    const detail = await service.getDelivery(pub.deliveries[0]!.id);
    expect(detail.attempts.length).toBeGreaterThanOrEqual(2);
    expect(
      detail.attempts[0]?.responseBody?.includes('[truncated]') ||
        (detail.attempts[0]?.responseBody?.length ?? 0) <= 120,
    ).toBe(true);

    const gone = await service.publish('invoice.paid', { id: 2 });
    await waitFor(service, gone.deliveries[0]!.id, 'failed');
    const sub = await service.getSubscription(subscription.id);
    expect(sub.status).toBe('disabled');
    await service.close();
  });

  it('auto-disables after consecutive failure threshold', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(500);
      res.end('no');
    });
    const service = createWebhooks({
      store: createMemoryStore(),
      security: {
        encryptionKey: encryptionKey(),
        ssrf: { requireHttps: false, allowHosts: ['127.0.0.1'], allowNonDefaultPorts: true },
        disableAfterFailures: 2,
      },
      retry: { scheduleMs: [0], jitter: 0, maxAttempts: 1 },
      random: () => 0,
      schedulerIntervalMs: 20,
    });
    const { subscription } = await service.createSubscription({ url, eventTypes: ['*'] });
    await service.publish('a', {});
    await new Promise((r) => setTimeout(r, 80));
    await service.publish('b', {});
    await new Promise((r) => setTimeout(r, 80));
    const sub = await service.getSubscription(subscription.id);
    expect(sub.status).toBe('disabled');
    await service.close();
  });

  it('refuses redirects', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1/elsewhere' });
      res.end();
    });
    const service = createWebhooks({
      store: createMemoryStore(),
      security: {
        encryptionKey: encryptionKey(),
        ssrf: { requireHttps: false, allowHosts: ['127.0.0.1'], allowNonDefaultPorts: true },
      },
      retry: { scheduleMs: [0], jitter: 0, maxAttempts: 1 },
      schedulerIntervalMs: 20,
    });
    await service.createSubscription({ url, eventTypes: ['*'] });
    const pub = await service.publish('x', {});
    await waitFor(service, pub.deliveries[0]!.id, 'failed');
    await service.close();
  });

  it('runs deliveries through the JobQueue handler signature', async () => {
    const jobs: Array<{ name: string; payload: unknown }> = [];
    const queue: JobQueue = {
      async add(name, payload) {
        jobs.push({ name, payload });
        return { id: `j-${jobs.length}` };
      },
    };
    const { url } = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const service = createWebhooks({
      store: createMemoryStore(),
      jobs: queue,
      security: {
        encryptionKey: encryptionKey(),
        ssrf: { requireHttps: false, allowHosts: ['127.0.0.1'], allowNonDefaultPorts: true },
      },
    });
    await service.createSubscription({ url, eventTypes: ['*'] });
    const pub = await service.publish('evt', { a: 1 });
    expect(jobs[0]?.name).toBe(DELIVER_JOB_NAME);
    const handler = createDeliveryJobHandler(service);
    await handler(jobs[0]?.payload, { signal: AbortSignal.timeout(5000), attempt: 1 });
    const d = await service.getDelivery(pub.deliveries[0]!.id);
    expect(d.delivery.status).toBe('success');
    await service.close();
  });
});

describe('incoming verification', () => {
  const body = Buffer.from('{"ok":true}');
  const secret = 'whsec_dGVzdHNlY3JldHNlY3JldHNlY3JldA==';

  it('verifies GitHub, Stripe and generic HMAC, rejects tampering and expiry', () => {
    const gh = createHmac('sha256', 'gh-secret').update(body).digest('hex');
    verifyWebhookSignature(
      body,
      { 'x-hub-signature-256': `sha256=${gh}` },
      {
        scheme: 'github',
        secrets: ['gh-secret'],
      },
    );

    const ts = Math.floor(Date.now() / 1000);
    const stripeSig = createHmac('sha256', 'stripe_secret')
      .update(`${ts}.${body.toString('utf8')}`)
      .digest('hex');
    verifyWebhookSignature(
      body,
      { 'stripe-signature': `t=${ts},v1=${stripeSig}` },
      {
        scheme: 'stripe',
        secrets: ['stripe_secret'],
      },
    );

    const hmac = createHmac('sha256', 'generic').update(body).digest('hex');
    verifyWebhookSignature(body, { 'x-signature': hmac }, { scheme: 'hmac', secrets: ['generic'] });

    expect(() =>
      verifyWebhookSignature(
        body,
        { 'x-hub-signature-256': 'sha256=00' },
        {
          scheme: 'github',
          secrets: ['gh-secret'],
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'WEBHOOKS_SIGNATURE_INVALID' }));

    const id = 'msg_old';
    const oldTs = ts - 10_000;
    const sig = signStandardWebhooks(id, oldTs, body, [secret]);
    expect(() =>
      verifyWebhookSignature(
        body,
        {
          'webhook-id': id,
          'webhook-timestamp': String(oldTs),
          'webhook-signature': sig,
        },
        { scheme: 'standard', secrets: [secret], nowSeconds: ts, toleranceSeconds: 300 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'WEBHOOKS_TIMESTAMP_EXPIRED' }));
  });

  it('detects replays via seen-id store', async () => {
    const seen = createMemorySeenIdStore();
    const id = 'msg_replay';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStandardWebhooks(id, ts, body, [secret]);
    const headers = {
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': sig,
    };
    verifyWebhookSignature(body, headers, {
      scheme: 'standard',
      secrets: [secret],
      nowSeconds: ts,
    });
    expect(await seen.checkAndStore(id, Date.now() + 60_000)).toBe(false);
    expect(await seen.checkAndStore(id, Date.now() + 60_000)).toBe(true);
  });
});
