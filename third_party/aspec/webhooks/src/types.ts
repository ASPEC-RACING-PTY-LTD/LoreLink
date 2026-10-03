export type SubscriptionStatus = 'active' | 'disabled' | 'paused';

export interface WebhookSecretRecord {
  id: string;
  /** AES-GCM ciphertext of the whsec_ secret. */
  ciphertext: string;
  createdAt: number;
  /** When set, secret remains valid for verification/signing until this time. */
  expiresAt?: number | undefined;
}

export interface Subscription {
  id: string;
  url: string;
  description?: string | undefined;
  status: SubscriptionStatus;
  /** Event type filters with optional wildcards. Empty means all events. */
  eventTypes: readonly string[];
  /** Optional declarative payload equality filter. */
  payloadFilter?: Record<string, unknown> | undefined;
  secrets: readonly WebhookSecretRecord[];
  tenantId?: string | undefined;
  ownerId?: string | undefined;
  metadata: Record<string, unknown>;
  headers?: Record<string, string> | undefined;
  consecutiveFailures: number;
  disabledReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSubscriptionInput {
  url: string;
  description?: string | undefined;
  eventTypes?: readonly string[] | undefined;
  payloadFilter?: Record<string, unknown> | undefined;
  tenantId?: string | undefined;
  ownerId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /** Initial plaintext secret; generated when omitted. Returned only once. */
  secret?: string | undefined;
}

export interface UpdateSubscriptionInput {
  url?: string | undefined;
  description?: string | null | undefined;
  eventTypes?: readonly string[] | undefined;
  payloadFilter?: Record<string, unknown> | null | undefined;
  status?: SubscriptionStatus | undefined;
  metadata?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | null | undefined;
}

export interface WebhookEvent {
  id: string;
  type: string;
  payload: unknown;
  tenantId?: string | undefined;
  idempotencyKey?: string | undefined;
  createdAt: number;
}

export type DeliveryStatus = 'pending' | 'sending' | 'success' | 'failed' | 'cancelled';

export interface Delivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt?: number | undefined;
  lastStatusCode?: number | undefined;
  lastError?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attempt: number;
  requestHeaders: Record<string, string>;
  responseStatus?: number | undefined;
  /** Truncated response body. */
  responseBody?: string | undefined;
  durationMs: number;
  error?: string | undefined;
  createdAt: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

export interface WebhooksStore {
  createSubscription(sub: Subscription): Promise<Subscription>;
  updateSubscription(id: string, patch: Partial<Subscription>): Promise<Subscription | undefined>;
  getSubscription(id: string): Promise<Subscription | undefined>;
  listSubscriptions(query: {
    tenantId?: string | undefined;
    status?: SubscriptionStatus | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<Subscription>>;
  deleteSubscription(id: string): Promise<boolean>;

  createEvent(event: WebhookEvent): Promise<{ event: WebhookEvent; created: boolean }>;
  getEvent(id: string): Promise<WebhookEvent | undefined>;
  findEventByIdempotency(
    tenantId: string | undefined,
    key: string,
  ): Promise<WebhookEvent | undefined>;

  createDelivery(delivery: Delivery): Promise<Delivery>;
  getDelivery(id: string): Promise<Delivery | undefined>;
  updateDelivery(id: string, patch: Partial<Delivery>): Promise<Delivery | undefined>;
  claimDelivery(id: string, now: number, staleBefore: number): Promise<Delivery | undefined>;
  listDeliveries(query: {
    subscriptionId?: string | undefined;
    eventId?: string | undefined;
    status?: DeliveryStatus | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<Delivery>>;
  addAttempt(attempt: DeliveryAttempt): Promise<void>;
  listAttempts(deliveryId: string): Promise<DeliveryAttempt[]>;
  listFailedDeliveries(subscriptionId: string, since: number, limit: number): Promise<Delivery[]>;
}

export interface SeenIdStore {
  /** Returns true if the id was already seen (replay). Otherwise records it. */
  checkAndStore(id: string, expiresAt: number): Promise<boolean>;
  purge(now: number): Promise<number>;
}
