import { randomUUID } from 'node:crypto';
import { mailMessageToEmail, validateEmailContent } from './email.js';
import {
  invalidConfig,
  invalidInput,
  NotificationProviderError,
  NotificationsError,
} from './errors.js';
import type {
  Clock,
  HealthCheckable,
  HealthCheckResult,
  IdGenerator,
  JobQueue,
  LoggerLike,
  Mailer,
} from './ports.js';
import {
  CATEGORY_PATTERN,
  CHANNEL_PATTERN,
  createPreferenceResolver,
  type EffectivePreference,
  type PreferencesConfig,
} from './preferences.js';
import {
  classifyError,
  computeRetryDelay,
  sleep as defaultSleep,
  type RetryPolicy,
  resolveRetryPolicy,
} from './retry.js';
import type { TemplateRegistry } from './templates.js';
import type {
  DeliveryAttempt,
  DeliveryContent,
  DeliveryQuery,
  DeliveryRecord,
  DeliveryStatus,
  InAppNotification,
  NotificationProvider,
  NotificationQuery,
  NotificationsStore,
  Page,
  PreferenceRecord,
  ProviderMessage,
  Recipient,
  SkipReason,
} from './types.js';

export const DELIVER_JOB_NAME = 'notifications.deliver';
export const IN_APP_CHANNEL = 'in-app';

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TITLE = 500;
const MAX_BODY = 20_000;

export interface NotificationsOptions {
  /** Delivery channels by name, for example { email: createEmailChannel(smtp) }. */
  channels?: Readonly<Record<string, NotificationProvider>>;
  templates?: TemplateRegistry;
  store: NotificationsStore;
  preferences?: PreferencesConfig;
  /** When set, notify() enqueues "notifications.deliver" jobs instead of delivering inline. */
  jobs?: JobQueue;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  retry?: Partial<RetryPolicy>;
  /** Built-in store-backed "in-app" channel. Default true. */
  inApp?: boolean;
  /** Fills missing email, name and locale for a userId. */
  resolveRecipient?: (userId: string) => Promise<Omit<Recipient, 'userId'> | undefined>;
  /** "until-complete" (default) clears rendered content once a delivery is sent or failed. */
  retainContent?: 'until-complete' | 'always';
  /** Per-attempt timeout for providers. Default 30000 ms. */
  sendTimeoutMs?: number;
  /** A delivery stuck in "sending" longer than this is reclaimed. Default 300000 ms. */
  staleSendingMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface NotifyContent {
  email?: { subject: string; text?: string; html?: string };
  message?: { title: string; body: string; url?: string };
}

export interface NotifyInput {
  /** A userId or a recipient object. */
  to: string | Recipient;
  category: string;
  /** Template ID used for every channel (email template or notification template). */
  template?: string;
  /** Template variables. */
  data?: Record<string, unknown>;
  /** Literal content instead of (or as fallback for) a template. */
  content?: NotifyContent;
  /** Structured data stored with in-app notifications and sent to message channels. */
  payload?: Record<string, unknown>;
  /** Explicit channels. Default: category defaults plus channels the user opted into. */
  channels?: readonly string[];
  locale?: string;
  /** Deduplicates notify() calls: the same key never creates a second delivery per channel. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface NotifyResult {
  dispatchId: string;
  deliveries: DeliveryRecord[];
}

export interface PreferenceUpdate {
  category: string;
  channel: string;
  enabled: boolean;
}

export interface CategoryPreferences {
  category: string;
  description?: string;
  mandatory: boolean;
  channels: EffectivePreference[];
}

export interface UserPreferences {
  userId: string;
  categories: CategoryPreferences[];
  /** Explicit preference records, including "*" wildcards. */
  records: PreferenceRecord[];
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface InAppListInput extends ListOptions {
  unreadOnly?: boolean;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  category?: string;
}

export type DeliveryHistoryQuery = Omit<DeliveryQuery, 'limit'> & { limit?: number };
export type NotificationHistoryQuery = Omit<NotificationQuery, 'limit'> & { limit?: number };

export interface DeliveryJobPayload {
  deliveryId: string;
}

export interface JobContext {
  signal: AbortSignal;
  attempt: number;
}

export interface NotificationsService extends HealthCheckable {
  readonly channels: readonly string[];
  /** Mailer port implementation with delivery tracking, preferences and retries. */
  readonly mailer: Mailer;
  notify(input: NotifyInput): Promise<NotifyResult>;
  /** Runs one delivery job. Used by createDeliveryJobHandler. */
  processDeliveryJob(payload: unknown, context: JobContext): Promise<void>;
  /** Delivers queued deliveries left behind by a restart (inline mode) or lost jobs. */
  resumePending(options?: { limit?: number }): Promise<number>;

  listNotifications(userId: string, options?: InAppListInput): Promise<Page<InAppNotification>>;
  getNotification(userId: string, id: string): Promise<InAppNotification>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, id: string): Promise<void>;
  markAllRead(userId: string): Promise<number>;
  archive(userId: string, id: string): Promise<void>;
  deleteNotification(userId: string, id: string): Promise<void>;

  getPreferences(userId: string): Promise<UserPreferences>;
  setPreference(userId: string, update: PreferenceUpdate): Promise<UserPreferences>;
  setPreferences(userId: string, updates: readonly PreferenceUpdate[]): Promise<UserPreferences>;
  resetPreference(userId: string, category: string, channel: string): Promise<UserPreferences>;

  listDeliveries(query?: DeliveryHistoryQuery): Promise<Page<DeliveryRecord>>;
  getDelivery(id: string): Promise<{ delivery: DeliveryRecord; attempts: DeliveryAttempt[] }>;
  queryNotifications(query?: NotificationHistoryQuery): Promise<Page<InAppNotification>>;
  purge(before: number): Promise<{ notifications: number; deliveries: number }>;
  close(): Promise<void>;
}

function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined) return def;
  if (!Number.isInteger(limit) || limit < 1) throw invalidInput('limit must be a positive integer');
  return Math.min(limit, max);
}

function checkUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId === '' || userId.length > 256) {
    throw invalidInput('userId must be a non-empty string of at most 256 characters');
  }
  return userId;
}

function notFound(what: string): NotificationsError {
  return new NotificationsError('NOTIFICATIONS_NOT_FOUND', `${what} not found`, {
    status: 404,
    expose: true,
  });
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Creates the notification service. */
export function createNotifications(options: NotificationsOptions): NotificationsService {
  if (options === null || typeof options !== 'object')
    throw invalidConfig('options', 'must be an object');
  const { store, templates } = options;
  if (!store || typeof store.createDelivery !== 'function') {
    throw invalidConfig('store', 'a NotificationsStore is required');
  }
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? { now: () => Date.now() };
  const generateId = options.generateId ?? randomUUID;
  const policy = resolveRetryPolicy(options.retry);
  const wait = options.sleep ?? defaultSleep;
  const retainContent = options.retainContent ?? 'until-complete';
  const sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
  const staleSendingMs = options.staleSendingMs ?? 300_000;
  if (!Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw invalidConfig('sendTimeoutMs', 'must be a positive number');
  }
  if (!Number.isFinite(staleSendingMs) || staleSendingMs <= 0) {
    throw invalidConfig('staleSendingMs', 'must be a positive number');
  }
  if (retainContent !== 'until-complete' && retainContent !== 'always') {
    throw invalidConfig('retainContent', 'must be "until-complete" or "always"');
  }
  const resolver = createPreferenceResolver(options.preferences);

  const channels = new Map<string, NotificationProvider>();
  for (const [name, provider] of Object.entries(options.channels ?? {})) {
    if (!CHANNEL_PATTERN.test(name))
      throw invalidConfig(`channels.${name}`, 'invalid channel name');
    if (
      !provider ||
      typeof provider.send !== 'function' ||
      (provider.kind !== 'email' && provider.kind !== 'message')
    ) {
      throw invalidConfig(`channels.${name}`, 'must be a NotificationProvider');
    }
    channels.set(name, provider);
  }
  if (options.inApp !== false && !channels.has(IN_APP_CHANNEL)) {
    channels.set(IN_APP_CHANNEL, {
      name: IN_APP_CHANNEL,
      kind: 'message',
      async send(message) {
        const userId = message.recipient.userId;
        if (userId === undefined) {
          throw new NotificationProviderError('In-app delivery needs a userId', {
            errorClass: 'permanent',
            providerCode: 'NO_RECIPIENT',
          });
        }
        if (message.content.kind !== 'message') {
          throw new NotificationProviderError('In-app channel needs message content', {
            errorClass: 'permanent',
            providerCode: 'INVALID_MESSAGE',
          });
        }
        const existing = await store.getInApp(userId, message.deliveryId);
        if (existing) return { messageId: existing.id };
        const content = message.content.message;
        const notification: InAppNotification = {
          id: message.deliveryId,
          userId,
          category: message.category,
          title: content.title,
          body: content.body,
          deliveryId: message.deliveryId,
          createdAt: clock.now(),
        };
        if (content.url !== undefined) notification.url = content.url;
        if (content.data !== undefined) notification.data = content.data;
        await store.createInApp(notification);
        return { messageId: notification.id };
      },
    });
  }
  const channelNames = [...channels.keys()];

  const now = () => clock.now();

  async function recordAttempt(
    delivery: DeliveryRecord,
    startedAt: number,
    outcome: Pick<DeliveryAttempt, 'status'> & Partial<DeliveryAttempt>,
  ): Promise<void> {
    const finishedAt = now();
    const attempt: DeliveryAttempt = {
      id: generateId(),
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      status: outcome.status,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    };
    if (outcome.providerMessageId !== undefined)
      attempt.providerMessageId = outcome.providerMessageId;
    if (outcome.errorClass !== undefined) attempt.errorClass = outcome.errorClass;
    if (outcome.errorCode !== undefined) attempt.errorCode = outcome.errorCode;
    if (outcome.errorMessage !== undefined) attempt.errorMessage = outcome.errorMessage;
    await store.addAttempt(attempt);
  }

  /** Runs one attempt of a claimed delivery. Returns the retry delay when another attempt is due. */
  async function attemptDelivery(
    delivery: DeliveryRecord,
    signal: AbortSignal | undefined,
  ): Promise<{ record: DeliveryRecord; retryInMs?: number }> {
    const startedAt = now();
    const provider = channels.get(delivery.channel);
    let failure: unknown;
    let messageId: string | undefined;
    try {
      if (!provider) {
        throw new NotificationProviderError(`Channel "${delivery.channel}" is not configured`, {
          errorClass: 'permanent',
          providerCode: 'CHANNEL_NOT_FOUND',
        });
      }
      if (!delivery.content) {
        throw new NotificationProviderError('Delivery content is no longer available', {
          errorClass: 'permanent',
          providerCode: 'CONTENT_UNAVAILABLE',
        });
      }
      const timeout = AbortSignal.timeout(sendTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const message: ProviderMessage = {
        deliveryId: delivery.id,
        channel: delivery.channel,
        category: delivery.category,
        recipient: delivery.recipient,
        content: delivery.content,
        metadata: delivery.metadata,
      };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          const reason: unknown = combined.reason;
          reject(
            reason instanceof Error && reason.name === 'TimeoutError'
              ? new NotificationProviderError(`Provider timed out after ${sendTimeoutMs} ms`, {
                  errorClass: 'transient',
                  providerCode: 'TIMEOUT',
                })
              : reason,
          );
        };
        if (combined.aborted) onAbort();
        else combined.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([
          provider.send(message, { signal: combined, attempt: delivery.attempts }),
          aborted,
        ]);
        messageId = result.messageId;
      } finally {
        if (onAbort) combined.removeEventListener('abort', onAbort);
        aborted.catch(() => undefined);
      }
    } catch (err) {
      failure = err;
    }

    if (failure === undefined) {
      await recordAttempt(delivery, startedAt, {
        status: 'sent',
        ...(messageId === undefined ? {} : { providerMessageId: messageId }),
      });
      const updated = await store.updateDelivery(delivery.id, {
        status: 'sent',
        sentAt: now(),
        updatedAt: now(),
        ...(messageId === undefined ? {} : { providerMessageId: messageId }),
        clear: [
          'nextAttemptAt',
          'errorClass',
          'errorCode',
          'errorMessage',
          ...(retainContent === 'until-complete' ? (['content'] as const) : []),
        ],
      });
      logger.info(
        {
          deliveryId: delivery.id,
          channel: delivery.channel,
          category: delivery.category,
          attempt: delivery.attempts,
        },
        'notifications: delivered',
      );
      return { record: updated ?? delivery };
    }

    const info = classifyError(failure);
    const errorMessage = truncate(info.message, 1000);
    await recordAttempt(delivery, startedAt, {
      status: 'failed',
      errorClass: info.errorClass,
      errorCode: info.errorCode,
      errorMessage,
    });
    const retry = info.errorClass === 'transient' && delivery.attempts < delivery.maxAttempts;
    const logEntry = {
      deliveryId: delivery.id,
      channel: delivery.channel,
      category: delivery.category,
      attempt: delivery.attempts,
      errorClass: info.errorClass,
      errorCode: info.errorCode,
      willRetry: retry,
    };
    if (retry) {
      const delay = computeRetryDelay(delivery.attempts, policy, options.random);
      logger.warn(logEntry, 'notifications: delivery attempt failed, retrying');
      const updated = await store.updateDelivery(delivery.id, {
        status: 'queued',
        errorClass: info.errorClass,
        errorCode: info.errorCode,
        errorMessage,
        nextAttemptAt: now() + delay,
        updatedAt: now(),
      });
      return { record: updated ?? delivery, retryInMs: delay };
    }
    logger.error(logEntry, 'notifications: delivery failed');
    const updated = await store.updateDelivery(delivery.id, {
      status: 'failed',
      failedAt: now(),
      errorClass: info.errorClass,
      errorCode: info.errorCode,
      errorMessage,
      updatedAt: now(),
      clear: [
        'nextAttemptAt',
        ...(retainContent === 'until-complete' ? (['content'] as const) : []),
      ],
    });
    return { record: updated ?? delivery };
  }

  async function deliverInline(
    id: string,
    signal?: AbortSignal,
  ): Promise<DeliveryRecord | undefined> {
    let latest: DeliveryRecord | undefined;
    for (;;) {
      const claimed = await store.claimDelivery(id, now(), now() - staleSendingMs);
      if (!claimed) return latest ?? (await store.getDelivery(id));
      const outcome = await attemptDelivery(claimed, signal);
      latest = outcome.record;
      if (outcome.retryInMs === undefined) return latest;
      await wait(outcome.retryInMs, signal);
    }
  }

  async function enqueue(deliveryId: string, attempt: number, delayMs?: number): Promise<void> {
    if (!options.jobs) throw invalidConfig('jobs', 'no JobQueue configured');
    const payload: DeliveryJobPayload = { deliveryId };
    await options.jobs.add(DELIVER_JOB_NAME, payload, {
      jobId: `${DELIVER_JOB_NAME}:${deliveryId}:${attempt}`,
      maxAttempts: 5,
      ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
    });
  }

  async function resolveRecipient(to: NotifyInput['to']): Promise<Recipient> {
    let recipient: Recipient;
    if (typeof to === 'string') {
      recipient = { userId: checkUserId(to) };
    } else if (to !== null && typeof to === 'object') {
      recipient = { ...to };
      if (recipient.userId !== undefined) checkUserId(recipient.userId);
      if (recipient.email !== undefined && typeof recipient.email !== 'string') {
        throw invalidInput('to.email must be a string');
      }
    } else {
      throw invalidInput('to must be a userId or a recipient object');
    }
    if (
      options.resolveRecipient &&
      recipient.userId !== undefined &&
      (recipient.email === undefined ||
        recipient.locale === undefined ||
        recipient.name === undefined)
    ) {
      const extra = await options.resolveRecipient(recipient.userId);
      if (extra) {
        for (const key of ['email', 'name', 'locale'] as const) {
          const value = extra[key];
          if (recipient[key] === undefined && value !== undefined) recipient[key] = value;
        }
        if (extra.addresses) recipient.addresses = { ...extra.addresses, ...recipient.addresses };
      }
    }
    return recipient;
  }

  function renderFor(
    provider: NotificationProvider,
    channel: string,
    input: NotifyInput,
    recipient: Recipient,
  ): DeliveryContent | SkipReason {
    const data = input.data ?? {};
    const renderOptions = input.locale ?? recipient.locale;
    const localeOpt = renderOptions === undefined ? {} : { locale: renderOptions };
    if (provider.kind === 'email') {
      if (recipient.email === undefined) return 'no_recipient';
      if (input.template !== undefined && templates?.hasEmail(input.template)) {
        const r = templates.renderEmail(input.template, data, localeOpt);
        const email: DeliveryContent = {
          kind: 'email',
          email: { to: recipient.email, subject: r.subject, text: r.text },
        };
        if (r.html !== undefined) email.email.html = r.html;
        return email;
      }
      const literal = input.content?.email;
      if (literal) {
        const message = mailMessageToEmail(
          {
            to: recipient.email,
            subject: literal.subject,
            text: literal.text ?? '',
            ...(literal.html === undefined ? {} : { html: literal.html }),
          },
          {},
        );
        return { kind: 'email', email: message };
      }
      return 'no_template';
    }
    if (channel === IN_APP_CHANNEL && recipient.userId === undefined) return 'no_recipient';
    let message: { title: string; body: string; url?: string } | undefined;
    if (input.template !== undefined && templates?.hasNotification(input.template, channel)) {
      message = templates.renderNotification(input.template, channel, data, localeOpt);
    } else if (input.content?.message) {
      message = { ...input.content.message };
    }
    if (!message) return 'no_template';
    const content: DeliveryContent = {
      kind: 'message',
      message: {
        title: truncate(message.title, MAX_TITLE),
        body: truncate(message.body, MAX_BODY),
      },
    };
    if (message.url !== undefined) content.message.url = message.url;
    if (input.payload !== undefined) content.message.data = input.payload;
    return content;
  }

  async function notify(input: NotifyInput): Promise<NotifyResult> {
    if (input === null || typeof input !== 'object')
      throw invalidInput('notify input must be an object');
    if (typeof input.category !== 'string' || !CATEGORY_PATTERN.test(input.category)) {
      throw invalidInput('category must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
    }
    if (
      input.template !== undefined &&
      (typeof input.template !== 'string' || !ID_PATTERN.test(input.template))
    ) {
      throw invalidInput('template must be a template ID');
    }
    if (input.template === undefined && input.content === undefined) {
      throw invalidInput('notify needs a template or content');
    }
    if (input.idempotencyKey !== undefined && !ID_PATTERN.test(input.idempotencyKey)) {
      throw invalidInput('idempotencyKey must match [A-Za-z0-9][A-Za-z0-9._:-]{0,255}');
    }
    if (input.template !== undefined && !templates) {
      throw invalidConfig('templates', 'notify() with a template needs a template registry');
    }
    const recipient = await resolveRecipient(input.to);
    const records =
      recipient.userId === undefined ? [] : await store.listPreferences(recipient.userId);
    const mandatory = resolver.isMandatory(input.category);
    let candidates: string[];
    if (input.channels !== undefined) {
      if (!Array.isArray(input.channels) || input.channels.length === 0) {
        throw invalidInput('channels must be a non-empty array');
      }
      for (const ch of input.channels) {
        if (!channels.has(ch)) {
          throw new NotificationsError(
            'NOTIFICATIONS_CHANNEL_NOT_FOUND',
            `Channel "${ch}" is not configured`,
            {
              status: 400,
              expose: true,
            },
          );
        }
      }
      candidates = [...new Set(input.channels)];
    } else {
      candidates = resolver.candidateChannels(input.category, records, channelNames);
    }

    const dispatchId = generateId();
    const createdAt = now();
    const planned: DeliveryRecord[] = [];
    for (const channel of candidates) {
      const provider = channels.get(channel) as NotificationProvider;
      const pref = resolver.resolve(input.category, channel, records, channelNames);
      const optedOut = mandatory
        ? false
        : input.channels !== undefined
          ? pref.source === 'user' && !pref.enabled
          : !pref.enabled;
      const rendered: DeliveryContent | SkipReason = optedOut
        ? 'preference'
        : renderFor(provider, channel, input, recipient);
      const delivery: DeliveryRecord = {
        id: generateId(),
        dispatchId,
        category: input.category,
        channel,
        recipient,
        status: typeof rendered === 'string' ? 'skipped' : 'queued',
        attempts: 0,
        maxAttempts: policy.maxAttempts,
        createdAt,
        updatedAt: createdAt,
        metadata: input.metadata ?? {},
      };
      if (typeof rendered === 'string') delivery.skipReason = rendered;
      else delivery.content = rendered;
      if (recipient.userId !== undefined) delivery.userId = recipient.userId;
      if (input.template !== undefined) delivery.template = input.template;
      if (input.idempotencyKey !== undefined)
        delivery.idempotencyKey = `${input.idempotencyKey}:${channel}`;
      planned.push(delivery);
    }

    const results: DeliveryRecord[] = [];
    const work: Promise<void>[] = [];
    const enqueueErrors: unknown[] = [];
    for (const d of planned) {
      const { delivery, created } = await store.createDelivery(d);
      const index = results.push(delivery) - 1;
      if (!created) continue;
      if (delivery.status === 'skipped') {
        logger.info(
          {
            deliveryId: delivery.id,
            channel: delivery.channel,
            category: delivery.category,
            reason: delivery.skipReason,
          },
          'notifications: delivery skipped',
        );
        continue;
      }
      if (options.jobs && delivery.channel !== IN_APP_CHANNEL) {
        work.push(
          enqueue(delivery.id, 1).catch((err: unknown) => {
            enqueueErrors.push(err);
            logger.error(
              { deliveryId: delivery.id, err: err instanceof Error ? err.message : String(err) },
              'notifications: failed to enqueue delivery job',
            );
          }),
        );
      } else {
        work.push(
          deliverInline(delivery.id).then((latest) => {
            if (latest) results[index] = latest;
          }),
        );
      }
    }
    await Promise.all(work);
    if (enqueueErrors.length > 0) {
      throw new NotificationsError(
        'NOTIFICATIONS_DELIVERY_FAILED',
        'Failed to enqueue notification delivery; resumePending() can retry queued deliveries',
        { status: 503, expose: false, cause: enqueueErrors[0], details: { dispatchId } },
      );
    }
    return { dispatchId, deliveries: results };
  }

  async function effectivePreferences(userId: string): Promise<UserPreferences> {
    const records = await store.listPreferences(userId);
    const categories = new Set<string>(resolver.configuredCategories.filter((c) => c !== '*'));
    for (const r of records) if (r.category !== '*') categories.add(r.category);
    const list: CategoryPreferences[] = [...categories].sort().map((category) => {
      const cfg = resolver.categoryConfig(category);
      const entry: CategoryPreferences = {
        category,
        mandatory: cfg?.mandatory === true,
        channels: channelNames.map((ch) => resolver.resolve(category, ch, records, channelNames)),
      };
      if (cfg?.description !== undefined) entry.description = cfg.description;
      return entry;
    });
    return { userId, categories: list, records };
  }

  function checkPreferenceUpdate(update: PreferenceUpdate): void {
    if (update === null || typeof update !== 'object')
      throw invalidInput('preference update must be an object');
    const { category, channel, enabled } = update;
    if (typeof category !== 'string' || (category !== '*' && !CATEGORY_PATTERN.test(category))) {
      throw invalidInput('category must be "*" or a valid category');
    }
    if (typeof channel !== 'string' || (channel !== '*' && !channels.has(channel))) {
      throw invalidInput(`channel must be "*" or one of: ${channelNames.join(', ')}`);
    }
    if (typeof enabled !== 'boolean') throw invalidInput('enabled must be a boolean');
    if (!enabled && category !== '*' && resolver.isMandatory(category)) {
      throw new NotificationsError(
        'NOTIFICATIONS_PREFERENCE_MANDATORY',
        `Category "${category}" is mandatory and cannot be disabled`,
        { status: 409, expose: true },
      );
    }
  }

  const service: NotificationsService = {
    channels: channelNames,
    mailer: {
      async send(message) {
        const email = mailMessageToEmail(message, {});
        try {
          validateEmailContent(email);
        } catch (err) {
          throw invalidInput((err as Error).message);
        }
        const userId = message.metadata?.userId;
        const emailChannel = [...channels.entries()].find(([, p]) => p.kind === 'email')?.[0];
        if (emailChannel === undefined) {
          throw invalidConfig('channels', 'the mailer needs an email channel');
        }
        const content: NotifyContent = { email: { subject: email.subject, text: email.text } };
        if (email.html !== undefined && content.email) content.email.html = email.html;
        const result = await notify({
          to: {
            email: email.to,
            ...(typeof userId === 'string' && userId !== '' ? { userId } : {}),
          },
          category: message.category ?? 'transactional',
          content,
          channels: [emailChannel],
          ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
        });
        const delivery = result.deliveries[0];
        if (delivery?.status === 'failed') {
          throw new NotificationsError(
            'NOTIFICATIONS_DELIVERY_FAILED',
            `Email delivery failed: ${delivery.errorCode ?? 'UNKNOWN'}`,
            {
              status: 502,
              expose: false,
              details: {
                deliveryId: delivery.id,
                errorClass: delivery.errorClass,
                errorCode: delivery.errorCode,
              },
            },
          );
        }
        return delivery === undefined ? {} : { id: delivery.id };
      },
    },
    notify,

    async processDeliveryJob(payload, context) {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        typeof (payload as { deliveryId?: unknown }).deliveryId !== 'string'
      ) {
        throw invalidInput('notifications.deliver payload must be { deliveryId: string }');
      }
      const { deliveryId } = payload as DeliveryJobPayload;
      const claimed = await store.claimDelivery(deliveryId, now(), now() - staleSendingMs);
      if (!claimed) {
        const current = await store.getDelivery(deliveryId);
        if (current?.status === 'sending') {
          throw new NotificationsError(
            'NOTIFICATIONS_DELIVERY_FAILED',
            'Delivery is being sent by another worker; retry later',
            { status: 409, expose: false },
          );
        }
        return;
      }
      const outcome = await attemptDelivery(claimed, context.signal);
      if (outcome.retryInMs !== undefined) {
        await enqueue(deliveryId, claimed.attempts + 1, outcome.retryInMs);
      }
    },

    async resumePending(opts = {}) {
      const limit = clampLimit(opts.limit, 100, 1000);
      const pending: DeliveryRecord[] = [];
      for (const status of ['queued', 'sending'] as DeliveryStatus[]) {
        const page = await store.listDeliveries({ status, limit });
        pending.push(...page.items);
      }
      let resumed = 0;
      const t = now();
      for (const d of pending.slice(0, limit)) {
        if (d.status === 'sending' && d.updatedAt >= t - staleSendingMs) continue;
        if (d.nextAttemptAt !== undefined && d.nextAttemptAt > t && options.jobs) {
          await enqueue(d.id, d.attempts + 1, d.nextAttemptAt - t);
        } else if (options.jobs && d.channel !== IN_APP_CHANNEL) {
          await enqueue(d.id, d.attempts + 1);
        } else {
          await deliverInline(d.id);
        }
        resumed++;
      }
      return resumed;
    },

    async listNotifications(userId, opts = {}) {
      checkUserId(userId);
      const query: Parameters<NotificationsStore['listInApp']>[1] = {
        limit: clampLimit(opts.limit, 20, 100),
      };
      if (opts.cursor !== undefined) query.cursor = opts.cursor;
      if (opts.unreadOnly !== undefined) query.unreadOnly = opts.unreadOnly;
      if (opts.includeArchived !== undefined) query.includeArchived = opts.includeArchived;
      if (opts.archivedOnly !== undefined) query.archivedOnly = opts.archivedOnly;
      if (opts.category !== undefined) query.category = opts.category;
      return store.listInApp(userId, query);
    },
    async getNotification(userId, id) {
      const n = await store.getInApp(checkUserId(userId), id);
      if (!n) throw notFound('Notification');
      return n;
    },
    async unreadCount(userId) {
      return store.countUnread(checkUserId(userId));
    },
    async markRead(userId, id) {
      if (!(await store.markRead(checkUserId(userId), id, now()))) throw notFound('Notification');
    },
    async markAllRead(userId) {
      return store.markAllRead(checkUserId(userId), now());
    },
    async archive(userId, id) {
      if (!(await store.archive(checkUserId(userId), id, now()))) throw notFound('Notification');
    },
    async deleteNotification(userId, id) {
      if (!(await store.deleteInApp(checkUserId(userId), id))) throw notFound('Notification');
    },

    async getPreferences(userId) {
      return effectivePreferences(checkUserId(userId));
    },
    async setPreference(userId, update) {
      return service.setPreferences(userId, [update]);
    },
    async setPreferences(userId, updates) {
      checkUserId(userId);
      if (!Array.isArray(updates) || updates.length === 0 || updates.length > 200) {
        throw invalidInput('updates must be an array of 1 to 200 preference updates');
      }
      for (const u of updates) checkPreferenceUpdate(u);
      for (const u of updates) {
        await store.setPreference({
          userId,
          category: u.category,
          channel: u.channel,
          enabled: u.enabled,
          updatedAt: now(),
        });
      }
      return effectivePreferences(userId);
    },
    async resetPreference(userId, category, channel) {
      await store.deletePreference(checkUserId(userId), category, channel);
      return effectivePreferences(userId);
    },

    async listDeliveries(query = {}) {
      const { limit, ...rest } = query;
      return store.listDeliveries({ ...rest, limit: clampLimit(limit, 50, 200) });
    },
    async getDelivery(id) {
      const delivery = await store.getDelivery(id);
      if (!delivery) throw notFound('Delivery');
      return { delivery, attempts: await store.listAttempts(id) };
    },
    async queryNotifications(query = {}) {
      const { limit, ...rest } = query;
      return store.queryInApp({ ...rest, limit: clampLimit(limit, 50, 200) });
    },
    async purge(before) {
      if (!Number.isFinite(before))
        throw invalidInput('before must be an epoch millisecond timestamp');
      return store.purge(before);
    },

    async checkHealth(): Promise<HealthCheckResult> {
      const started = now();
      const details: Record<string, unknown> = {};
      let ok = true;
      for (const [name, provider] of channels) {
        if (!provider.checkHealth) continue;
        try {
          const result = await provider.checkHealth();
          details[name] = result;
          if (!result.ok) ok = false;
        } catch (err) {
          ok = false;
          details[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { ok, latencyMs: now() - started, details };
    },
    async close() {
      for (const provider of channels.values()) await provider.close?.();
    },
  };
  return service;
}

/**
 * Job handler for "notifications.deliver" with the JobQueue port handler signature.
 * Register it with your job worker: worker.register(DELIVER_JOB_NAME, createDeliveryJobHandler(service)).
 */
export function createDeliveryJobHandler(
  service: Pick<NotificationsService, 'processDeliveryJob'>,
): (payload: unknown, ctx: { signal: AbortSignal; attempt: number }) => Promise<void> {
  return (payload, ctx) => service.processDeliveryJob(payload, ctx);
}
