import { compareDesc, decodeCursor, encodeCursor, isAfterCursor } from '../cursor.js';
import { invalidConfig } from '../errors.js';
import type {
  DeliveryAttempt,
  DeliveryPatch,
  DeliveryQuery,
  DeliveryRecord,
  InAppListOptions,
  InAppNotification,
  NotificationQuery,
  NotificationsStore,
  Page,
  PreferenceRecord,
} from '../types.js';

export interface MemoryStoreOptions {
  /** Maximum in-app notifications kept per user; the oldest are evicted. Default 1000. */
  maxNotificationsPerUser?: number;
  /** Maximum delivery records kept; the oldest completed ones are evicted. Default 10000. */
  maxDeliveries?: number;
}

const clone = <T>(value: T): T => structuredClone(value);

function paginate<T extends { createdAt: number; id: string }>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): Page<T> {
  items.sort(compareDesc);
  const position = cursor === undefined ? undefined : decodeCursor(cursor);
  const filtered = position === undefined ? items : items.filter((i) => isAfterCursor(i, position));
  const page = filtered.slice(0, limit).map(clone);
  const last = page[page.length - 1];
  return filtered.length > limit && last !== undefined
    ? { items: page, nextCursor: encodeCursor(last) }
    : { items: page };
}

/** In-memory store for development and tests. State is lost on restart. */
export function createMemoryStore(options: MemoryStoreOptions = {}): NotificationsStore {
  const maxPerUser = options.maxNotificationsPerUser ?? 1000;
  const maxDeliveries = options.maxDeliveries ?? 10_000;
  if (!Number.isInteger(maxPerUser) || maxPerUser < 1) {
    throw invalidConfig('maxNotificationsPerUser', 'must be a positive integer');
  }
  if (!Number.isInteger(maxDeliveries) || maxDeliveries < 1) {
    throw invalidConfig('maxDeliveries', 'must be a positive integer');
  }
  const inApp = new Map<string, Map<string, InAppNotification>>();
  const deliveries = new Map<string, DeliveryRecord>();
  const idempotency = new Map<string, string>();
  const attempts = new Map<string, DeliveryAttempt[]>();
  const preferences = new Map<string, Map<string, PreferenceRecord>>();

  const userItems = (userId: string): Map<string, InAppNotification> => {
    let items = inApp.get(userId);
    if (!items) {
      items = new Map();
      inApp.set(userId, items);
    }
    return items;
  };

  const removeDelivery = (id: string) => {
    const d = deliveries.get(id);
    if (!d) return;
    deliveries.delete(id);
    attempts.delete(id);
    if (d.idempotencyKey !== undefined) idempotency.delete(d.idempotencyKey);
  };

  const evictDeliveries = () => {
    if (deliveries.size <= maxDeliveries) return;
    const done = [...deliveries.values()]
      .filter((d) => d.status === 'sent' || d.status === 'failed' || d.status === 'skipped')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const d of done) {
      if (deliveries.size <= maxDeliveries) break;
      removeDelivery(d.id);
    }
  };

  return {
    async createInApp(notification) {
      const items = userItems(notification.userId);
      items.set(notification.id, clone(notification));
      if (items.size > maxPerUser) {
        const oldest = [...items.values()].sort((a, b) => -compareDesc(a, b));
        for (const n of oldest.slice(0, items.size - maxPerUser)) items.delete(n.id);
      }
    },
    async getInApp(userId, id) {
      const n = inApp.get(userId)?.get(id);
      return n ? clone(n) : undefined;
    },
    async listInApp(userId, opts: InAppListOptions) {
      const items = [...(inApp.get(userId)?.values() ?? [])].filter((n) => {
        if (opts.category !== undefined && n.category !== opts.category) return false;
        if (opts.archivedOnly) return n.archivedAt !== undefined;
        if (!opts.includeArchived && n.archivedAt !== undefined) return false;
        if (opts.unreadOnly && n.readAt !== undefined) return false;
        return true;
      });
      return paginate(items, opts.limit, opts.cursor);
    },
    async queryInApp(query: NotificationQuery) {
      const source =
        query.userId === undefined
          ? [...inApp.values()].flatMap((m) => [...m.values()])
          : [...(inApp.get(query.userId)?.values() ?? [])];
      const items = source.filter((n) => {
        if (query.category !== undefined && n.category !== query.category) return false;
        if (query.from !== undefined && n.createdAt < query.from) return false;
        if (query.to !== undefined && n.createdAt >= query.to) return false;
        if (query.state === 'archived') return n.archivedAt !== undefined;
        if (query.state === 'read') return n.readAt !== undefined && n.archivedAt === undefined;
        if (query.state === 'unread') return n.readAt === undefined && n.archivedAt === undefined;
        return true;
      });
      return paginate(items, query.limit, query.cursor);
    },
    async countUnread(userId) {
      let count = 0;
      for (const n of inApp.get(userId)?.values() ?? []) {
        if (n.readAt === undefined && n.archivedAt === undefined) count++;
      }
      return count;
    },
    async markRead(userId, id, at) {
      const n = inApp.get(userId)?.get(id);
      if (!n) return false;
      if (n.readAt === undefined) n.readAt = at;
      return true;
    },
    async markAllRead(userId, at) {
      let count = 0;
      for (const n of inApp.get(userId)?.values() ?? []) {
        if (n.readAt === undefined && n.archivedAt === undefined) {
          n.readAt = at;
          count++;
        }
      }
      return count;
    },
    async archive(userId, id, at) {
      const n = inApp.get(userId)?.get(id);
      if (!n) return false;
      if (n.archivedAt === undefined) n.archivedAt = at;
      if (n.readAt === undefined) n.readAt = at;
      return true;
    },
    async deleteInApp(userId, id) {
      return inApp.get(userId)?.delete(id) ?? false;
    },

    async createDelivery(delivery) {
      if (delivery.idempotencyKey !== undefined) {
        const existingId = idempotency.get(delivery.idempotencyKey);
        const existing = existingId === undefined ? undefined : deliveries.get(existingId);
        if (existing) return { delivery: clone(existing), created: false };
        idempotency.set(delivery.idempotencyKey, delivery.id);
      }
      deliveries.set(delivery.id, clone(delivery));
      evictDeliveries();
      return { delivery: clone(delivery), created: true };
    },
    async getDelivery(id) {
      const d = deliveries.get(id);
      return d ? clone(d) : undefined;
    },
    async claimDelivery(id, now, staleBefore) {
      const d = deliveries.get(id);
      if (!d) return undefined;
      const claimable =
        d.status === 'queued' || (d.status === 'sending' && d.updatedAt < staleBefore);
      if (!claimable) return undefined;
      d.status = 'sending';
      d.attempts += 1;
      d.updatedAt = now;
      return clone(d);
    },
    async updateDelivery(id, patch: DeliveryPatch) {
      const d = deliveries.get(id);
      if (!d) return undefined;
      const { clear, ...fields } = patch;
      Object.assign(d, clone(fields));
      for (const key of clear ?? []) delete d[key];
      return clone(d);
    },
    async listDeliveries(query: DeliveryQuery) {
      const items = [...deliveries.values()].filter((d) => {
        if (query.userId !== undefined && d.userId !== query.userId) return false;
        if (query.category !== undefined && d.category !== query.category) return false;
        if (query.channel !== undefined && d.channel !== query.channel) return false;
        if (query.status !== undefined && d.status !== query.status) return false;
        if (query.dispatchId !== undefined && d.dispatchId !== query.dispatchId) return false;
        if (query.from !== undefined && d.createdAt < query.from) return false;
        if (query.to !== undefined && d.createdAt >= query.to) return false;
        return true;
      });
      return paginate(items, query.limit, query.cursor);
    },
    async addAttempt(attempt) {
      const list = attempts.get(attempt.deliveryId) ?? [];
      list.push(clone(attempt));
      attempts.set(attempt.deliveryId, list);
    },
    async listAttempts(deliveryId) {
      return (attempts.get(deliveryId) ?? []).map(clone).sort((a, b) => a.attempt - b.attempt);
    },

    async listPreferences(userId) {
      return [...(preferences.get(userId)?.values() ?? [])].map(clone);
    },
    async setPreference(record) {
      let map = preferences.get(record.userId);
      if (!map) {
        map = new Map();
        preferences.set(record.userId, map);
      }
      map.set(`${record.category}\u0000${record.channel}`, clone(record));
    },
    async deletePreference(userId, category, channel) {
      return preferences.get(userId)?.delete(`${category}\u0000${channel}`) ?? false;
    },

    async purge(before) {
      let notifications = 0;
      for (const items of inApp.values()) {
        for (const n of [...items.values()]) {
          if (n.createdAt < before) {
            items.delete(n.id);
            notifications++;
          }
        }
      }
      let removed = 0;
      for (const d of [...deliveries.values()]) {
        if (d.createdAt < before && d.status !== 'queued' && d.status !== 'sending') {
          removeDelivery(d.id);
          removed++;
        }
      }
      return { notifications, deliveries: removed };
    },
  };
}
