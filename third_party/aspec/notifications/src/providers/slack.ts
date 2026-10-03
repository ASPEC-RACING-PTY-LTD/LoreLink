import { invalidConfig, NotificationProviderError } from '../errors.js';
import type { NotificationProvider, ProviderMessage } from '../types.js';
import { checkEndpoint, type FetchLike, postJson } from './http-shared.js';

export interface SlackProviderOptions {
  /** Incoming webhook URL (keep it secret). Either webhookUrl or resolveWebhookUrl is required. */
  webhookUrl?: string;
  /** Per-recipient webhook, for example recipient.addresses.slack. */
  resolveWebhookUrl?: (message: ProviderMessage) => string | undefined;
  /** Default 10000 ms. */
  timeoutMs?: number;
  /** Allow http:// endpoints (local development and tests only). Default false. */
  allowInsecureHttp?: boolean;
  fetch?: FetchLike;
}

/** Escapes the characters Slack mrkdwn treats as control characters. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Slack-compatible incoming webhook channel (also accepted by Mattermost and Rocket.Chat
 * incoming webhooks). Free to use; no paid service is required.
 */
export function createSlackProvider(options: SlackProviderOptions): NotificationProvider {
  const allowInsecure = options.allowInsecureHttp ?? false;
  if (options.webhookUrl === undefined && options.resolveWebhookUrl === undefined) {
    throw invalidConfig('slack.webhookUrl', 'webhookUrl or resolveWebhookUrl is required');
  }
  if (options.webhookUrl !== undefined)
    checkEndpoint(options.webhookUrl, 'slack.webhookUrl', allowInsecure);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    name: 'slack',
    kind: 'message',
    async send(message, context) {
      const target = options.resolveWebhookUrl
        ? options.resolveWebhookUrl(message)
        : options.webhookUrl;
      if (target === undefined) {
        throw new NotificationProviderError('No Slack webhook for recipient', {
          errorClass: 'permanent',
          providerCode: 'NO_RECIPIENT',
        });
      }
      try {
        checkEndpoint(target, 'slack.webhookUrl', allowInsecure);
      } catch (err) {
        throw new NotificationProviderError((err as Error).message, {
          errorClass: 'permanent',
          providerCode: 'INVALID_ENDPOINT',
        });
      }
      if (message.content.kind !== 'message') {
        throw new NotificationProviderError('Slack channel needs message content', {
          errorClass: 'permanent',
          providerCode: 'INVALID_MESSAGE',
        });
      }
      const { title, body, url } = message.content.message;
      const safeTitle = escapeSlackText(title);
      const safeBody = escapeSlackText(body);
      const link =
        url !== undefined && /^https?:\/\//i.test(url)
          ? `\n<${url.replace(/[<>|]/g, '')}|Open>`
          : '';
      const payload = {
        text: `${safeTitle}\n${safeBody}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${safeTitle}*\n${safeBody}${link}` } },
        ],
      };
      await postJson(
        fetchImpl,
        target,
        JSON.stringify(payload),
        {},
        timeoutMs,
        context.signal,
        'Slack',
      );
      return { messageId: message.deliveryId };
    },
  };
}
