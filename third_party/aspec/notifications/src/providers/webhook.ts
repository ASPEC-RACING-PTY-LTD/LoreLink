import { createHmac } from 'node:crypto';
import { invalidConfig, NotificationProviderError } from '../errors.js';
import type { NotificationProvider, ProviderMessage } from '../types.js';
import { checkEndpoint, type FetchLike, postJson } from './http-shared.js';

export interface HttpWebhookProviderOptions {
  /** Fixed endpoint. Either url or resolveUrl is required. */
  url?: string;
  /** Per-recipient endpoint, for example from recipient.addresses.webhook. */
  resolveUrl?: (message: ProviderMessage) => string | undefined;
  /** Extra request headers, for example an authorization header. */
  headers?: Record<string, string>;
  /** When set, the body is signed: X-Notification-Signature: sha256=<hex HMAC-SHA256>. */
  signingSecret?: string;
  /** Default 10000 ms. */
  timeoutMs?: number;
  /** Allow http:// endpoints (local development only). Default false. */
  allowInsecureHttp?: boolean;
  /** Provider name in logs and records. Default "webhook". */
  name?: string;
  fetch?: FetchLike;
}

/**
 * Generic HTTP webhook channel: POSTs a JSON document per notification. Redirects are not
 * followed. Only point it at endpoints the application controls or trusts; for
 * user-supplied URLs use @aspec/webhooks, which adds SSRF protection.
 */
export function createHttpWebhookProvider(
  options: HttpWebhookProviderOptions,
): NotificationProvider {
  const allowInsecure = options.allowInsecureHttp ?? false;
  if (options.url === undefined && options.resolveUrl === undefined) {
    throw invalidConfig('webhook.url', 'url or resolveUrl is required');
  }
  if (options.url !== undefined) checkEndpoint(options.url, 'webhook.url', allowInsecure);
  if (options.signingSecret !== undefined && options.signingSecret.length < 16) {
    throw invalidConfig('webhook.signingSecret', 'must be at least 16 characters');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const name = options.name ?? 'webhook';
  return {
    name,
    kind: 'message',
    async send(message, context) {
      const target = options.resolveUrl ? options.resolveUrl(message) : options.url;
      if (target === undefined) {
        throw new NotificationProviderError('No webhook URL for recipient', {
          errorClass: 'permanent',
          providerCode: 'NO_RECIPIENT',
        });
      }
      try {
        checkEndpoint(target, 'webhook.url', allowInsecure);
      } catch (err) {
        throw new NotificationProviderError((err as Error).message, {
          errorClass: 'permanent',
          providerCode: 'INVALID_ENDPOINT',
        });
      }
      if (message.content.kind !== 'message') {
        throw new NotificationProviderError('Webhook channel needs message content', {
          errorClass: 'permanent',
          providerCode: 'INVALID_MESSAGE',
        });
      }
      const body = JSON.stringify({
        id: message.deliveryId,
        category: message.category,
        userId: message.recipient.userId,
        title: message.content.message.title,
        body: message.content.message.body,
        url: message.content.message.url,
        data: message.content.message.data,
      });
      const headers: Record<string, string> = {
        ...options.headers,
        'x-notification-id': message.deliveryId,
      };
      if (options.signingSecret !== undefined) {
        headers['x-notification-signature'] =
          `sha256=${createHmac('sha256', options.signingSecret).update(body).digest('hex')}`;
      }
      await postJson(fetchImpl, target, body, headers, timeoutMs, context.signal, name);
      return { messageId: message.deliveryId };
    },
  };
}
