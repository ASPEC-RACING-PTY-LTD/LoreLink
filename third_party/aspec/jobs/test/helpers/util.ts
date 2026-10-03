import type { Clock, LoggerLike } from '../../src/ports.js';

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function fakeClock(start = Date.UTC(2026, 0, 1)): FakeClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string | undefined;
}

export function memoryLogger(): LoggerLike & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until the predicate holds or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
