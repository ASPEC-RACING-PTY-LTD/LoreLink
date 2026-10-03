import type { ErrorClass } from './errors.js';
import type { HealthCheckResult } from './ports.js';

/** Who a notification is for. userId is required for in-app delivery and preferences. */
export interface Recipient {
  userId?: string;
  email?: string;
  name?: string;
  locale?: string;
  /** Channel specific addresses, for example { slack: "https://hooks.slack.com/..." }. */
  addresses?: Record<string, string>;
}

/** Rendered email content handed to email providers. */
export interface EmailContent {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Rendered content for non-email channels. */
export interface MessageContent {
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
}

export type DeliveryContent =
  | { kind: 'email'; email: EmailContent }
  | { kind: 'message'; message: MessageContent };

/** Message passed to NotificationProvider.send. */
export interface ProviderMessage {
  deliveryId: string;
  channel: string;
  category: string;
  recipient: Recipient;
  content: DeliveryContent;
  metadata: Record<string, unknown>;
}

export interface ProviderContext {
  signal: AbortSignal;
  attempt: number;
}

export interface ProviderSendResult {
  /** Provider message ID (SMTP Message-ID, in-app notification ID, ...). */
  messageId?: string;
}

/**
 * Interface for delivery channels. Implement it to add providers (SMS gateways, push
 * services, chat tools). Throw NotificationProviderError with errorClass "transient" for
 * failures worth retrying and "permanent" for failures that never succeed on retry. Any
 * other thrown error is treated as transient.
 */
export interface NotificationProvider {
  /** Provider name used in logs and delivery records, for example "smtp" or "slack". */
  readonly name: string;
  /** "email" providers receive rendered email templates; "message" providers receive notification templates. */
  readonly kind: 'email' | 'message';
  send(message: ProviderMessage, context: ProviderContext): Promise<ProviderSendResult>;
  checkHealth?(): Promise<HealthCheckResult>;
  close?(): Promise<void>;
}

/** Minimal email transport consumed by createMailer and the email channel. */
export interface EmailTransport {
  send(email: EmailContent, context?: { signal?: AbortSignal }): Promise<{ messageId?: string }>;
}

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
export type SkipReason = 'preference' | 'no_recipient' | 'no_template';

export interface DeliveryRecord {
  id: string;
  /** Groups the deliveries created by one notify() call. */
  dispatchId: string;
  idempotencyKey?: string;
  userId?: string;
  category: string;
  channel: string;
  template?: string;
  recipient: Recipient;
  /** Rendered content. Cleared when the delivery completes unless retainContent is "always". */
  content?: DeliveryContent;
  status: DeliveryStatus;
  skipReason?: SkipReason;
  attempts: number;
  maxAttempts: number;
  providerMessageId?: string;
  errorClass?: ErrorClass;
  errorCode?: string;
  errorMessage?: string;
  nextAttemptAt?: number;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
  failedAt?: number;
  metadata: Record<string, unknown>;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attempt: number;
  status: 'sent' | 'failed';
  providerMessageId?: string;
  errorClass?: ErrorClass;
  errorCode?: string;
  errorMessage?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

export interface InAppNotification {
  id: string;
  userId: string;
  category: string;
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
  deliveryId?: string;
  createdAt: number;
  readAt?: number;
  archivedAt?: number;
}

export interface PreferenceRecord {
  userId: string;
  /** Category or "*" for every category. */
  category: string;
  /** Channel or "*" for every channel. */
  channel: string;
  enabled: boolean;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, absent on the last page. */
  nextCursor?: string;
}

export interface InAppListOptions {
  limit: number;
  cursor?: string;
  unreadOnly?: boolean;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  category?: string;
}

export interface NotificationQuery {
  userId?: string;
  category?: string;
  /** "unread", "read" or "archived". */
  state?: 'unread' | 'read' | 'archived';
  from?: number;
  to?: number;
  limit: number;
  cursor?: string;
}

export interface DeliveryQuery {
  userId?: string;
  category?: string;
  channel?: string;
  status?: DeliveryStatus;
  dispatchId?: string;
  /** Inclusive lower bound on createdAt (epoch ms). */
  from?: number;
  /** Exclusive upper bound on createdAt (epoch ms). */
  to?: number;
  limit: number;
  cursor?: string;
}

export type DeliveryPatch = Partial<
  Pick<
    DeliveryRecord,
    | 'status'
    | 'attempts'
    | 'providerMessageId'
    | 'errorClass'
    | 'errorCode'
    | 'errorMessage'
    | 'nextAttemptAt'
    | 'sentAt'
    | 'failedAt'
    | 'content'
  >
> & {
  updatedAt: number;
  /** Explicitly remove these optional fields. */
  clear?: ReadonlyArray<'content' | 'nextAttemptAt' | 'errorClass' | 'errorCode' | 'errorMessage'>;
};

/** Persistence for in-app notifications, deliveries, attempts and preferences. */
export interface NotificationsStore {
  createInApp(notification: InAppNotification): Promise<void>;
  getInApp(userId: string, id: string): Promise<InAppNotification | undefined>;
  listInApp(userId: string, options: InAppListOptions): Promise<Page<InAppNotification>>;
  queryInApp(query: NotificationQuery): Promise<Page<InAppNotification>>;
  countUnread(userId: string): Promise<number>;
  markRead(userId: string, id: string, at: number): Promise<boolean>;
  markAllRead(userId: string, at: number): Promise<number>;
  archive(userId: string, id: string, at: number): Promise<boolean>;
  deleteInApp(userId: string, id: string): Promise<boolean>;

  /** Inserts a delivery. When idempotencyKey already exists, returns the existing record and created false. */
  createDelivery(delivery: DeliveryRecord): Promise<{ delivery: DeliveryRecord; created: boolean }>;
  getDelivery(id: string): Promise<DeliveryRecord | undefined>;
  /**
   * Atomically moves a delivery to "sending" and increments attempts when it is queued, or
   * when it has been "sending" since before staleBefore (a crashed worker). Returns the
   * claimed record or undefined when another worker owns it or it is complete.
   */
  claimDelivery(id: string, now: number, staleBefore: number): Promise<DeliveryRecord | undefined>;
  updateDelivery(id: string, patch: DeliveryPatch): Promise<DeliveryRecord | undefined>;
  listDeliveries(query: DeliveryQuery): Promise<Page<DeliveryRecord>>;
  addAttempt(attempt: DeliveryAttempt): Promise<void>;
  listAttempts(deliveryId: string): Promise<DeliveryAttempt[]>;

  listPreferences(userId: string): Promise<PreferenceRecord[]>;
  setPreference(record: PreferenceRecord): Promise<void>;
  deletePreference(userId: string, category: string, channel: string): Promise<boolean>;

  /**
   * Removes in-app notifications, and completed deliveries (sent, failed, skipped) with their
   * attempts, created before the timestamp.
   */
  purge(before: number): Promise<{ notifications: number; deliveries: number }>;
}
