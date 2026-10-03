import { NotificationProviderError } from '../../src/errors.js';
import type { EnqueueOptions, JobQueue } from '../../src/ports.js';
import type {
  EmailContent,
  EmailTransport,
  NotificationProvider,
  ProviderMessage,
} from '../../src/types.js';

export function fakeClock(start = 1_750_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

export function sequentialIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, '0')}`;
}

export function recordingTransport(
  script: Array<'ok' | 'transient' | 'permanent'> = [],
): EmailTransport & { sent: EmailContent[]; calls: number } {
  const transport = {
    sent: [] as EmailContent[],
    calls: 0,
    async send(email: EmailContent) {
      const step = script[transport.calls] ?? 'ok';
      transport.calls++;
      if (step === 'transient') {
        throw new NotificationProviderError('451 try again later', {
          errorClass: 'transient',
          providerCode: 'SMTP_4XX',
          responseCode: 451,
        });
      }
      if (step === 'permanent') {
        throw new NotificationProviderError('550 mailbox unavailable', {
          errorClass: 'permanent',
          providerCode: 'SMTP_5XX',
          responseCode: 550,
        });
      }
      transport.sent.push(email);
      return { messageId: `<msg-${transport.calls}@test>` };
    },
  };
  return transport;
}

export function recordingProvider(
  kind: 'email' | 'message' = 'message',
  script: Array<'ok' | 'transient' | 'permanent' | 'hang'> = [],
): NotificationProvider & { messages: ProviderMessage[]; calls: number } {
  const provider = {
    name: 'recording',
    kind,
    messages: [] as ProviderMessage[],
    calls: 0,
    async send(message: ProviderMessage, ctx: { signal: AbortSignal }) {
      const step = script[provider.calls] ?? 'ok';
      provider.calls++;
      if (step === 'hang') {
        await new Promise((resolve) =>
          ctx.signal.addEventListener('abort', resolve, { once: true }),
        );
        throw new Error('aborted');
      }
      if (step === 'transient') {
        throw new NotificationProviderError('503 unavailable', {
          errorClass: 'transient',
          providerCode: 'HTTP_503',
        });
      }
      if (step === 'permanent') {
        throw new NotificationProviderError('400 bad request', {
          errorClass: 'permanent',
          providerCode: 'HTTP_400',
        });
      }
      provider.messages.push(message);
      return { messageId: `m-${provider.calls}` };
    },
  };
  return provider;
}

export interface QueuedJob {
  name: string;
  payload: unknown;
  options: EnqueueOptions | undefined;
}

export function memoryQueue(): JobQueue & { jobs: QueuedJob[]; fail: boolean } {
  const ids = new Set<string>();
  const queue = {
    jobs: [] as QueuedJob[],
    fail: false,
    async add(name: string, payload: unknown, options?: EnqueueOptions) {
      if (queue.fail) throw new Error('queue unavailable');
      const id = options?.jobId ?? `job-${queue.jobs.length + 1}`;
      if (!ids.has(id)) {
        ids.add(id);
        queue.jobs.push({ name, payload, options });
      }
      return { id };
    },
  };
  return queue;
}

export const noSleep = async () => {};
