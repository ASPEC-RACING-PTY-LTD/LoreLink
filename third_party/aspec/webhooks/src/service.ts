import { randomUUID } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  parseEncryptionKey,
  signStandardWebhooks,
} from './crypto.js';
import { type DeliverHttpOptions, postWebhook } from './deliver.js';
import { invalidConfig, invalidInput, WebhooksError } from './errors.js';
import { anyEventMatches, payloadMatches } from './filter.js';
import type { Clock, IdGenerator, JobQueue, LoggerLike } from './ports.js';
import { nextRetryDelayMs, type RetryPolicy, resolveRetryPolicy } from './retry.js';
import { assertUrlAllowedForCreate, type SsrfOptions } from './ssrf.js';
import type {
  CreateSubscriptionInput,
  Delivery,
  Page,
  Subscription,
  UpdateSubscriptionInput,
  WebhookEvent,
  WebhooksStore,
} from './types.js';

export const DELIVER_JOB_NAME = 'webhooks.deliver';

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

export interface WebhooksSecurityOptions {
  /** 32-byte key for AES-256-GCM (raw, base64 or hex). Or set WEBHOOKS_ENCRYPTION_KEY. */
  encryptionKey?: string | Buffer;
  ssrf?: SsrfOptions;
  /** Consecutive failure threshold before auto-disable. Default 10. */
  disableAfterFailures?: number;
  delivery?: DeliverHttpOptions;
}

export interface WebhooksOptions {
  store: WebhooksStore;
  jobs?: JobQueue;
  /** Custom fetch is not used for SSRF-safe delivery; kept for interface compatibility. */
  fetch?: typeof fetch;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  security: WebhooksSecurityOptions;
  retry?: Partial<RetryPolicy>;
  /** Called when a subscription is auto-disabled. */
  onSubscriptionDisabled?: (subscription: Subscription, reason: string) => void;
  /** Injectable RNG for retry jitter. */
  random?: () => number;
  /** Max response body stored on attempts. Default 4096. */
  truncateResponseBytes?: number;
  staleSendingMs?: number;
  /** Internal scheduler poll interval when jobs are not configured. Default 1000. */
  schedulerIntervalMs?: number;
}

export interface PublishOptions {
  tenantId?: string;
  idempotencyKey?: string;
}

export interface JobContext {
  signal: AbortSignal;
  attempt: number;
}

export interface WebhooksService {
  createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<{ subscription: Subscription; secret: string }>;
  updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<Subscription>;
  getSubscription(id: string): Promise<Subscription>;
  listSubscriptions(query?: {
    tenantId?: string;
    status?: Subscription['status'];
    limit?: number;
    cursor?: string;
  }): Promise<Page<Subscription>>;
  deleteSubscription(id: string): Promise<void>;
  rotateSecret(
    id: string,
    options?: { expiresInMs?: number },
  ): Promise<{ secret: string; secretId: string }>;
  removeExpiredSecrets(id: string): Promise<Subscription>;
  enableSubscription(id: string): Promise<Subscription>;
  disableSubscription(id: string, reason?: string): Promise<Subscription>;

  publish(
    eventType: string,
    payload: unknown,
    options?: PublishOptions,
  ): Promise<{ event: WebhookEvent; deliveries: Delivery[] }>;
  processDeliveryJob(payload: unknown, context: JobContext): Promise<void>;
  redeliver(deliveryId: string): Promise<Delivery>;
  redeliverFailed(subscriptionId: string, since: number): Promise<number>;
  ping(subscriptionId: string): Promise<Delivery>;

  listDeliveries(query?: {
    subscriptionId?: string;
    eventId?: string;
    status?: Delivery['status'];
    limit?: number;
    cursor?: string;
  }): Promise<Page<Delivery>>;
  getDelivery(
    id: string,
  ): Promise<{ delivery: Delivery; attempts: Awaited<ReturnType<WebhooksStore['listAttempts']>> }>;

  startScheduler(): void;
  stopScheduler(): void;
  close(): Promise<void>;
}

function activeSecrets(sub: Subscription, now: number, key: Buffer): string[] {
  const out: string[] = [];
  for (const s of sub.secrets) {
    if (s.expiresAt !== undefined && s.expiresAt <= now) continue;
    out.push(decryptSecret(s.ciphertext, key));
  }
  return out;
}

/** Creates the outbound webhooks service. */
export function createWebhooks(options: WebhooksOptions): WebhooksService {
  if (!options?.store) throw invalidConfig('store', 'is required');
  if (!options.security) throw invalidConfig('security', 'is required');
  const encRaw = options.security.encryptionKey ?? process.env.WEBHOOKS_ENCRYPTION_KEY;
  if (encRaw === undefined)
    throw invalidConfig('security.encryptionKey', 'or WEBHOOKS_ENCRYPTION_KEY is required');
  const key = Buffer.isBuffer(encRaw) ? encRaw : parseEncryptionKey(encRaw);
  if (key.length !== 32) throw invalidConfig('security.encryptionKey', 'must be 32 bytes');

  const store = options.store;
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? { now: () => Date.now() };
  const generateId = options.generateId ?? randomUUID;
  const policy = resolveRetryPolicy(options.retry);
  const disableAfter = options.security.disableAfterFailures ?? 10;
  const truncate = options.truncateResponseBytes ?? 4096;
  const staleSendingMs = options.staleSendingMs ?? 300_000;
  const ssrfDefaults: SsrfOptions = {
    requireHttps: options.security.ssrf?.requireHttps ?? true,
    allowHosts: options.security.ssrf?.allowHosts,
    allowNonDefaultPorts: options.security.ssrf?.allowNonDefaultPorts,
    lookup: options.security.ssrf?.lookup,
  };
  const deliverOpts: DeliverHttpOptions = {
    ...options.security.delivery,
    requireHttps: options.security.delivery?.requireHttps ?? ssrfDefaults.requireHttps,
    allowHosts: options.security.delivery?.allowHosts ?? ssrfDefaults.allowHosts,
    ssrf: ssrfDefaults,
    lookup: ssrfDefaults.lookup,
  };
  const random = options.random ?? Math.random;
  let timer: ReturnType<typeof setInterval> | undefined;

  const now = () => clock.now();

  async function enqueue(deliveryId: string, attempt: number, delayMs?: number): Promise<void> {
    if (!options.jobs) return;
    await options.jobs.add(
      DELIVER_JOB_NAME,
      { deliveryId },
      {
        jobId: `${DELIVER_JOB_NAME}:${deliveryId}:${attempt}`,
        maxAttempts: 5,
        ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
      },
    );
  }

  async function createSubscription(input: CreateSubscriptionInput) {
    if (!input || typeof input.url !== 'string') throw invalidInput('url is required');
    assertUrlAllowedForCreate(input.url, ssrfDefaults);
    // Also resolve to catch SSRF at create time when possible (skip DNS failures for hostnames in dry configs)
    try {
      await resolveSafeUrlForCreate(input.url, ssrfDefaults);
    } catch (err) {
      if (err instanceof WebhooksError && err.code === 'WEBHOOKS_SSRF_BLOCKED') throw err;
      // DNS may fail offline; URL shape already validated.
    }
    const plaintext = input.secret ?? generateWebhookSecret();
    if (!plaintext.startsWith('whsec_')) throw invalidInput('secret must start with whsec_');
    const t = now();
    const secretId = generateId();
    const sub: Subscription = {
      id: generateId(),
      url: input.url,
      status: 'active',
      eventTypes: input.eventTypes ? [...input.eventTypes] : [],
      secrets: [{ id: secretId, ciphertext: encryptSecret(plaintext, key), createdAt: t }],
      metadata: input.metadata ?? {},
      consecutiveFailures: 0,
      createdAt: t,
      updatedAt: t,
    };
    if (input.description !== undefined) sub.description = input.description;
    if (input.payloadFilter !== undefined) sub.payloadFilter = { ...input.payloadFilter };
    if (input.tenantId !== undefined) sub.tenantId = input.tenantId;
    if (input.ownerId !== undefined) sub.ownerId = input.ownerId;
    if (input.headers !== undefined) sub.headers = { ...input.headers };
    await store.createSubscription(sub);
    return { subscription: publicSubscription(sub), secret: plaintext };
  }

  function publicSubscription(sub: Subscription): Subscription {
    return {
      ...sub,
      secrets: sub.secrets.map((s) => ({
        id: s.id,
        ciphertext: '[redacted]',
        createdAt: s.createdAt,
        ...(s.expiresAt === undefined ? {} : { expiresAt: s.expiresAt }),
      })),
    };
  }

  async function getSubscription(id: string): Promise<Subscription> {
    const sub = await store.getSubscription(id);
    if (!sub)
      throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
        status: 404,
        expose: true,
      });
    return publicSubscription(sub);
  }

  async function updateSubscription(
    id: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    const cur = await store.getSubscription(id);
    if (!cur)
      throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
        status: 404,
        expose: true,
      });
    const patch: Partial<Subscription> = { updatedAt: now() };
    if (input.url !== undefined) {
      assertUrlAllowedForCreate(input.url, ssrfDefaults);
      patch.url = input.url;
    }
    if (input.description === null) patch.description = undefined;
    else if (input.description !== undefined) patch.description = input.description;
    if (input.eventTypes !== undefined) patch.eventTypes = [...input.eventTypes];
    if (input.payloadFilter === null) patch.payloadFilter = undefined;
    else if (input.payloadFilter !== undefined) patch.payloadFilter = { ...input.payloadFilter };
    if (input.status !== undefined) patch.status = input.status;
    if (input.metadata !== undefined) patch.metadata = { ...input.metadata };
    if (input.headers === null) patch.headers = undefined;
    else if (input.headers !== undefined) patch.headers = { ...input.headers };
    const updated = await store.updateSubscription(id, patch);
    return publicSubscription(updated!);
  }

  async function attemptDeliver(delivery: Delivery): Promise<{ retryInMs?: number }> {
    const sub = await store.getSubscription(delivery.subscriptionId);
    const event = await store.getEvent(delivery.eventId);
    if (!sub || !event) {
      await store.updateDelivery(delivery.id, {
        status: 'cancelled',
        lastError: 'missing subscription or event',
        updatedAt: now(),
      });
      return {};
    }
    if (sub.status !== 'active') {
      await store.updateDelivery(delivery.id, {
        status: 'cancelled',
        lastError: `subscription is ${sub.status}`,
        updatedAt: now(),
      });
      return {};
    }

    const body = JSON.stringify(event.payload);
    const msgId = `msg_${delivery.id}`;
    const ts = Math.floor(now() / 1000);
    const secrets = activeSecrets(sub, now(), key);
    if (secrets.length === 0) {
      await store.updateDelivery(delivery.id, {
        status: 'failed',
        lastError: 'no active signing secrets',
        updatedAt: now(),
      });
      return {};
    }
    const signature = signStandardWebhooks(msgId, ts, body, secrets);
    const requestHeaders: Record<string, string> = {
      'webhook-id': msgId,
      'webhook-timestamp': String(ts),
      'webhook-signature': signature,
      'user-agent': 'aspec-webhooks/1.0',
      ...(sub.headers ?? {}),
    };
    // Never log secrets
    const safeHeaders = { ...requestHeaders };
    delete (safeHeaders as { authorization?: string }).authorization;

    let result: Awaited<ReturnType<typeof postWebhook>> | undefined;
    let errorMessage: string | undefined;
    try {
      result = await postWebhook(sub.url, body, requestHeaders, deliverOpts);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const attempt = {
      id: generateId(),
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      requestHeaders: {
        'webhook-id': msgId,
        'webhook-timestamp': String(ts),
        'webhook-signature': '[redacted]',
        'user-agent': requestHeaders['user-agent'] ?? '',
      },
      durationMs: result?.durationMs ?? 0,
      createdAt: now(),
      ...(result
        ? {
            responseStatus: result.status,
            responseBody: result.body.slice(0, truncate),
          }
        : { error: errorMessage }),
    };
    await store.addAttempt(attempt);

    if (result && result.status >= 200 && result.status < 300) {
      await store.updateDelivery(delivery.id, {
        status: 'success',
        lastStatusCode: result.status,
        updatedAt: now(),
        nextAttemptAt: undefined,
        lastError: undefined,
      });
      await store.updateSubscription(sub.id, {
        consecutiveFailures: 0,
        updatedAt: now(),
        disabledReason: undefined,
      });
      logger.info({ deliveryId: delivery.id, subscriptionId: sub.id }, 'webhooks: delivered');
      return {};
    }

    if (result?.status === 410) {
      await store.updateDelivery(delivery.id, {
        status: 'failed',
        lastStatusCode: 410,
        lastError: 'endpoint gone',
        updatedAt: now(),
      });
      const disabled = await store.updateSubscription(sub.id, {
        status: 'disabled',
        disabledReason: 'receiver returned 410 Gone',
        updatedAt: now(),
      });
      if (disabled) options.onSubscriptionDisabled?.(disabled, '410');
      return {};
    }

    const failures = sub.consecutiveFailures + 1;
    const delay = nextRetryDelayMs(delivery.attempts, policy, random);
    const statusCode = result?.status;
    if (delay === undefined) {
      await store.updateDelivery(delivery.id, {
        status: 'failed',
        lastStatusCode: statusCode,
        lastError: errorMessage ?? `HTTP ${statusCode}`,
        updatedAt: now(),
      });
      if (failures >= disableAfter) {
        const disabled = await store.updateSubscription(sub.id, {
          status: 'disabled',
          consecutiveFailures: failures,
          disabledReason: `auto-disabled after ${failures} consecutive failures`,
          updatedAt: now(),
        });
        if (disabled) options.onSubscriptionDisabled?.(disabled, 'threshold');
      } else {
        await store.updateSubscription(sub.id, { consecutiveFailures: failures, updatedAt: now() });
      }
      return {};
    }

    await store.updateDelivery(delivery.id, {
      status: 'pending',
      lastStatusCode: statusCode,
      lastError: errorMessage ?? `HTTP ${statusCode}`,
      nextAttemptAt: now() + delay,
      updatedAt: now(),
    });
    await store.updateSubscription(sub.id, { consecutiveFailures: failures, updatedAt: now() });
    if (options.jobs) await enqueue(delivery.id, delivery.attempts + 1, delay);
    return { retryInMs: delay };
  }

  async function processDeliveryJob(payload: unknown, _ctx: JobContext): Promise<void> {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      typeof (payload as { deliveryId?: unknown }).deliveryId !== 'string'
    ) {
      throw invalidInput('webhooks.deliver payload must be { deliveryId: string }');
    }
    const { deliveryId } = payload as { deliveryId: string };
    const claimed = await store.claimDelivery(deliveryId, now(), now() - staleSendingMs);
    if (!claimed) return;
    await attemptDeliver(claimed);
  }

  async function scheduleOrRun(delivery: Delivery): Promise<void> {
    if (options.jobs) {
      await enqueue(delivery.id, 1);
    } else {
      const claimed = await store.claimDelivery(delivery.id, now(), now() - staleSendingMs);
      if (claimed) await attemptDeliver(claimed);
    }
  }

  async function publish(eventType: string, payload: unknown, publishOpts: PublishOptions = {}) {
    if (typeof eventType !== 'string' || eventType === '')
      throw invalidInput('eventType is required');
    const t = now();
    const event: WebhookEvent = {
      id: generateId(),
      type: eventType,
      payload,
      createdAt: t,
    };
    if (publishOpts.tenantId !== undefined) event.tenantId = publishOpts.tenantId;
    if (publishOpts.idempotencyKey !== undefined) event.idempotencyKey = publishOpts.idempotencyKey;

    const { event: stored, created } = await store.createEvent(event);
    if (!created) {
      const existing = await store.listDeliveries({ eventId: stored.id, limit: 200 });
      return { event: stored, deliveries: existing.items };
    }

    const list = await store.listSubscriptions({
      tenantId: publishOpts.tenantId,
      status: 'active',
      limit: 1000,
    });
    // Also match subscriptions without tenant when tenantId filter is set: list only tenant-scoped above.
    // Include global (no tenant) subscriptions by listing without tenant filter when needed.
    const global = publishOpts.tenantId
      ? (await store.listSubscriptions({ status: 'active', limit: 1000 })).items.filter(
          (s) => s.tenantId === undefined,
        )
      : [];
    const candidates = [...list.items, ...global];
    const deliveries: Delivery[] = [];
    for (const sub of candidates) {
      if (publishOpts.tenantId && sub.tenantId && sub.tenantId !== publishOpts.tenantId) continue;
      if (!anyEventMatches(sub.eventTypes, eventType)) continue;
      if (!payloadMatches(sub.payloadFilter, payload)) continue;
      const delivery: Delivery = {
        id: generateId(),
        subscriptionId: sub.id,
        eventId: stored.id,
        status: 'pending',
        attempts: 0,
        createdAt: t,
        updatedAt: t,
      };
      await store.createDelivery(delivery);
      deliveries.push(delivery);
      await scheduleOrRun(delivery);
    }
    return { event: stored, deliveries };
  }

  const service: WebhooksService = {
    createSubscription,
    updateSubscription,
    getSubscription,
    async listSubscriptions(query = {}) {
      return store
        .listSubscriptions({
          limit: Math.min(query.limit ?? 50, 200),
          ...(query.tenantId !== undefined ? { tenantId: query.tenantId } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        })
        .then((page) => ({ ...page, items: page.items.map(publicSubscription) }));
    },
    async deleteSubscription(id) {
      if (!(await store.deleteSubscription(id))) {
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
          status: 404,
          expose: true,
        });
      }
    },
    async rotateSecret(id, rotateOpts = {}) {
      const cur = await store.getSubscription(id);
      if (!cur)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
          status: 404,
          expose: true,
        });
      const plaintext = generateWebhookSecret();
      const secretId = generateId();
      const t = now();
      const expiresInMs = rotateOpts.expiresInMs ?? 24 * 60 * 60_000;
      const secrets = cur.secrets.map((s) =>
        s.expiresAt === undefined ? { ...s, expiresAt: t + expiresInMs } : s,
      );
      secrets.push({ id: secretId, ciphertext: encryptSecret(plaintext, key), createdAt: t });
      await store.updateSubscription(id, { secrets, updatedAt: t });
      return { secret: plaintext, secretId };
    },
    async removeExpiredSecrets(id) {
      const cur = await store.getSubscription(id);
      if (!cur)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
          status: 404,
          expose: true,
        });
      const t = now();
      const secrets = cur.secrets.filter((s) => s.expiresAt === undefined || s.expiresAt > t);
      const updated = await store.updateSubscription(id, { secrets, updatedAt: t });
      return publicSubscription(updated!);
    },
    async enableSubscription(id) {
      const updated = await store.updateSubscription(id, {
        status: 'active',
        consecutiveFailures: 0,
        disabledReason: undefined,
        updatedAt: now(),
      });
      if (!updated)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
          status: 404,
          expose: true,
        });
      return publicSubscription(updated);
    },
    async disableSubscription(id, reason) {
      const updated = await store.updateSubscription(id, {
        status: 'disabled',
        disabledReason: reason ?? 'manual',
        updatedAt: now(),
      });
      if (!updated)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
          status: 404,
          expose: true,
        });
      return publicSubscription(updated);
    },
    publish,
    processDeliveryJob,
    async redeliver(deliveryId) {
      const cur = await store.getDelivery(deliveryId);
      if (!cur)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Delivery not found', {
          status: 404,
          expose: true,
        });
      const reset = await store.updateDelivery(deliveryId, {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
        updatedAt: now(),
      });
      await scheduleOrRun(reset!);
      return (await store.getDelivery(deliveryId))!;
    },
    async redeliverFailed(subscriptionId, since) {
      const failed = await store.listFailedDeliveries(subscriptionId, since, 500);
      for (const d of failed) await service.redeliver(d.id);
      return failed.length;
    },
    async ping(subscriptionId) {
      const result = await publish('webhooks.ping', { ping: true, at: now() }, {});
      const delivery = result.deliveries.find((d) => d.subscriptionId === subscriptionId);
      if (!delivery) {
        // Force a delivery even if filters would skip: create directly
        const sub = await store.getSubscription(subscriptionId);
        if (!sub)
          throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Subscription not found', {
            status: 404,
            expose: true,
          });
        const d: Delivery = {
          id: generateId(),
          subscriptionId,
          eventId: result.event.id,
          status: 'pending',
          attempts: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        await store.createDelivery(d);
        await scheduleOrRun(d);
        return (await store.getDelivery(d.id))!;
      }
      return (await store.getDelivery(delivery.id))!;
    },
    async listDeliveries(query = {}) {
      return store.listDeliveries({
        limit: Math.min(query.limit ?? 50, 200),
        ...(query.subscriptionId !== undefined ? { subscriptionId: query.subscriptionId } : {}),
        ...(query.eventId !== undefined ? { eventId: query.eventId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
    },
    async getDelivery(id) {
      const delivery = await store.getDelivery(id);
      if (!delivery)
        throw new WebhooksError('WEBHOOKS_NOT_FOUND', 'Delivery not found', {
          status: 404,
          expose: true,
        });
      return { delivery, attempts: await store.listAttempts(id) };
    },
    startScheduler() {
      if (options.jobs || timer) return;
      const interval = options.schedulerIntervalMs ?? 1000;
      timer = setInterval(() => {
        void (async () => {
          const pending = await store.listDeliveries({ status: 'pending', limit: 50 });
          const t = now();
          for (const d of pending.items) {
            if (d.nextAttemptAt !== undefined && d.nextAttemptAt > t) continue;
            const claimed = await store.claimDelivery(d.id, t, t - staleSendingMs);
            if (claimed) await attemptDeliver(claimed);
          }
        })().catch((err) => logger.error({ err: String(err) }, 'webhooks: scheduler tick failed'));
      }, interval);
      timer.unref?.();
    },
    stopScheduler() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async close() {
      service.stopScheduler();
    },
  };

  if (!options.jobs) service.startScheduler();
  return service;
}

async function resolveSafeUrlForCreate(url: string, ssrf: SsrfOptions) {
  const { resolveSafeUrl } = await import('./ssrf.js');
  return resolveSafeUrl(url, ssrf);
}

export function createDeliveryJobHandler(
  service: Pick<WebhooksService, 'processDeliveryJob'>,
): (payload: unknown, ctx: { signal: AbortSignal; attempt: number }) => Promise<void> {
  return (payload, ctx) => service.processDeliveryJob(payload, ctx);
}
