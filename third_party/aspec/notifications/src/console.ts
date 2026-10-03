import type { LoggerLike } from './ports.js';
import type { NotificationProvider } from './types.js';

export interface ConsoleChannelOptions {
  /** Logger receiving the messages. Defaults to console.info with JSON output. */
  logger?: LoggerLike;
  /** Which templates the channel renders. Default "email". */
  kind?: 'email' | 'message';
  /** Include rendered bodies in the log entry. Default true (development only). */
  logContent?: boolean;
}

let counter = 0;

/**
 * Development channel: logs rendered notifications instead of delivering them. Never use it
 * in production, because message bodies (which may contain links with tokens) are logged.
 */
export function createConsoleChannel(options: ConsoleChannelOptions = {}): NotificationProvider {
  const logContent = options.logContent ?? true;
  const log = (obj: Record<string, unknown>, msg: string) => {
    if (options.logger) options.logger.info(obj, msg);
    else console.info(msg, JSON.stringify(obj));
  };
  return {
    name: 'console',
    kind: options.kind ?? 'email',
    async send(message) {
      counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
      const entry: Record<string, unknown> = {
        deliveryId: message.deliveryId,
        channel: message.channel,
        category: message.category,
        userId: message.recipient.userId,
      };
      if (message.content.kind === 'email') {
        entry.to = message.content.email.to;
        entry.subject = message.content.email.subject;
        if (logContent) entry.text = message.content.email.text;
      } else {
        entry.title = message.content.message.title;
        if (logContent) entry.body = message.content.message.body;
        if (logContent && message.content.message.url !== undefined)
          entry.url = message.content.message.url;
      }
      log(entry, 'notifications: console delivery (not sent)');
      return { messageId: `console-${message.deliveryId}-${counter}` };
    },
    async checkHealth() {
      return { ok: true, details: { provider: 'console' } };
    },
  };
}
