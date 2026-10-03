import { errorInfo, noopLogger } from './internal.js';
import type { LoggerLike } from './ports.js';

/** Anything with a graceful `stop()`: workers and schedulers. */
export interface Stoppable {
  stop(options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ShutdownOptions {
  /** Signals to handle. Default SIGTERM and SIGINT. */
  signals?: readonly NodeJS.Signals[];
  /** Passed to `worker.stop()`. Default 30000. */
  timeoutMs?: number;
  /** Call `process.exit()` once everything stopped. Default true. */
  exit?: boolean;
  logger?: LoggerLike;
  /** Called after all targets stopped and before exiting. */
  onShutdown?(): void | Promise<void>;
}

/**
 * Installs signal handlers that stop the given workers and schedulers gracefully. A second
 * signal while stopping exits immediately with code 1. Returns a function that removes the
 * handlers.
 */
export function installShutdownHandlers(
  targets: Stoppable | readonly Stoppable[],
  options: ShutdownOptions = {},
): () => void {
  const list: readonly Stoppable[] = Array.isArray(targets)
    ? (targets as readonly Stoppable[])
    : [targets as Stoppable];
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exit = options.exit ?? true;
  const logger = options.logger ?? noopLogger;
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'jobs: second signal received, exiting immediately');
      if (exit) process.exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal, timeoutMs }, 'jobs: shutting down');
    void (async () => {
      let code = 0;
      const results = await Promise.allSettled(list.map((t) => t.stop({ timeoutMs })));
      for (const r of results) {
        if (r.status === 'rejected') {
          code = 1;
          logger.error({ err: errorInfo(r.reason) }, 'jobs: stop failed during shutdown');
        }
      }
      try {
        await options.onShutdown?.();
      } catch (err) {
        code = 1;
        logger.error({ err: errorInfo(err) }, 'jobs: onShutdown hook failed');
      }
      logger.info({ code }, 'jobs: shutdown complete');
      if (exit) process.exit(code);
    })();
  };

  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
