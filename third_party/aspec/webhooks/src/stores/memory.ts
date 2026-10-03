import type {
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Page,
  SeenIdStore,
  Subscription,
  SubscriptionStatus,
  WebhookEvent,
  WebhooksStore,
} from '../types.js';

const clone = <T>(v: T): T => structuredClone(v);

function paginate<T extends { createdAt: number; id: string }>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): Page<T> {
  items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((i) => i.id === cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = items.slice(start, start + limit).map(clone);
  const last = slice[slice.length - 1];
  return items.length > start + limit && last
    ? { items: slice, nextCursor: last.id }
    : { items: slice };
}

export function createMemoryStore(): WebhooksStore {
  const subscriptions = new Map<string, Subscription>();
  const events = new Map<string, WebhookEvent>();
  const idempotency = new Map<string, string>();
  const deliveries = new Map<string, Delivery>();
  const attempts = new Map<string, DeliveryAttempt[]>();

  return {
    async createSubscription(sub) {
      subscriptions.set(sub.id, clone(sub));
      return clone(sub);
    },
    async updateSubscription(id, patch) {
      const cur = subscriptions.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      subscriptions.set(id, next);
      return clone(next);
    },
    async getSubscription(id) {
      const s = subscriptions.get(id);
      return s ? clone(s) : undefined;
    },
    async listSubscriptions(query) {
      let items = [...subscriptions.values()];
      if (query.tenantId !== undefined) items = items.filter((s) => s.tenantId === query.tenantId);
      if (query.status !== undefined) items = items.filter((s) => s.status === query.status);
      return paginate(items, query.limit, query.cursor);
    },
    async deleteSubscription(id) {
      return subscriptions.delete(id);
    },
    async createEvent(event) {
      if (event.idempotencyKey) {
        const key = `${event.tenantId ?? ''}:${event.idempotencyKey}`;
        const existingId = idempotency.get(key);
        if (existingId) {
          const existing = events.get(existingId);
          if (existing) return { event: clone(existing), created: false };
        }
        idempotency.set(key, event.id);
      }
      events.set(event.id, clone(event));
      return { event: clone(event), created: true };
    },
    async getEvent(id) {
      const e = events.get(id);
      return e ? clone(e) : undefined;
    },
    async findEventByIdempotency(tenantId, key) {
      const id = idempotency.get(`${tenantId ?? ''}:${key}`);
      return id ? this.getEvent(id) : undefined;
    },
    async createDelivery(delivery) {
      deliveries.set(delivery.id, clone(delivery));
      return clone(delivery);
    },
    async getDelivery(id) {
      const d = deliveries.get(id);
      return d ? clone(d) : undefined;
    },
    async updateDelivery(id, patch) {
      const cur = deliveries.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      deliveries.set(id, next);
      return clone(next);
    },
    async claimDelivery(id, now, staleBefore) {
      const cur = deliveries.get(id);
      if (!cur) return undefined;
      if (cur.status === 'success' || cur.status === 'cancelled') return undefined;
      if (cur.status === 'sending' && cur.updatedAt >= staleBefore) return undefined;
      if (cur.status === 'pending' && cur.nextAttemptAt !== undefined && cur.nextAttemptAt > now) {
        return undefined;
      }
      const next: Delivery = {
        ...cur,
        status: 'sending',
        attempts: cur.attempts + 1,
        updatedAt: now,
      };
      deliveries.set(id, next);
      return clone(next);
    },
    async listDeliveries(query) {
      let items = [...deliveries.values()];
      if (query.subscriptionId)
        items = items.filter((d) => d.subscriptionId === query.subscriptionId);
      if (query.eventId) items = items.filter((d) => d.eventId === query.eventId);
      if (query.status) items = items.filter((d) => d.status === query.status);
      return paginate(items, query.limit, query.cursor);
    },
    async addAttempt(attempt) {
      const list = attempts.get(attempt.deliveryId) ?? [];
      list.push(clone(attempt));
      attempts.set(attempt.deliveryId, list);
    },
    async listAttempts(deliveryId) {
      return clone(attempts.get(deliveryId) ?? []);
    },
    async listFailedDeliveries(subscriptionId, since, limit) {
      return [...deliveries.values()]
        .filter(
          (d) =>
            d.subscriptionId === subscriptionId && d.status === 'failed' && d.createdAt >= since,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(clone);
    },
  };
}

export function createMemorySeenIdStore(): SeenIdStore {
  const seen = new Map<string, number>();
  return {
    async checkAndStore(id, expiresAt) {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
      if (seen.has(id)) return true;
      seen.set(id, expiresAt);
      return false;
    },
    async purge(now) {
      let n = 0;
      for (const [k, exp] of seen) {
        if (exp <= now) {
          seen.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}

export type { DeliveryStatus, SubscriptionStatus };
