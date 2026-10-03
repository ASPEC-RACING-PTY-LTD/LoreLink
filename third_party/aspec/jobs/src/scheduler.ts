import { Cron } from 'croner';
import { validateBackoff } from './backoff.js';
import { invalidOption, JobsError, JobsErrorCode } from './errors.js';
import { assertJobName, errorInfo, noopLogger, systemClock } from './internal.js';
import type { Clock, LoggerLike } from './ports.js';
import type { AddOptions, SerializableBackoff } from './types.js';

export interface ScheduleDefinition {
  /** Stable schedule identifier. Part of the deterministic job ID of every tick. */
  id: string;
  /** Job name to enqueue. */
  name: string;
  payload?: unknown;
  /** Cron expression (5, 6 or 7 fields, croner syntax). Exactly one of `cron` and `every`. */
  cron?: string;
  /** IANA time zone for `cron`, for example `Europe/Berlin`. Default UTC. */
  timezone?: string;
  /** Interval in milliseconds. Ticks are aligned to `anchor`, so all instances agree. */
  every?: number;
  /** Alignment origin for `every`. Default the Unix epoch. */
  anchor?: Date;
  priority?: number;
  maxAttempts?: number;
  backoff?: SerializableBackoff;
  /**
   * When several ticks were missed (scheduler paused or the event loop blocked), enqueue all
   * of them (up to 100) instead of only the latest. Default false.
   */
  catchUp?: boolean;
}

export interface SchedulerQueue {
  add(name: string, payload: unknown, options?: AddOptions): Promise<{ id: string }>;
}

export interface SchedulerOptions {
  queue: SchedulerQueue;
  schedules: readonly ScheduleDefinition[];
  clock?: Clock;
  logger?: LoggerLike;
  /** How often `start()` checks for due ticks, in milliseconds. Default 1000. */
  pollIntervalMs?: number;
  /**
   * On the first check, also consider ticks this far in the past. Covers ticks missed while
   * every scheduler instance was restarting. Deterministic job IDs prevent duplicates.
   * Default 0.
   */
  initialLookbackMs?: number;
}

export interface EnqueuedTick {
  scheduleId: string;
  jobId: string;
  runAt: Date;
}

export interface Scheduler {
  /** Checks every schedule once and enqueues due ticks. Used by `start()` and by tests. */
  tick(): Promise<EnqueuedTick[]>;
  /** Next tick of a schedule after the current time. */
  nextRun(scheduleId: string): Date | undefined;
  start(): void;
  stop(): Promise<void>;
}

const SCHEDULE_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_CATCH_UP = 100;
const MAX_ITERATIONS = 100_000;

interface CompiledSchedule {
  def: ScheduleDefinition;
  cron?: Cron;
  every?: number;
  anchor: number;
  lastChecked: number;
  addOptions: Omit<AddOptions, 'jobId' | 'runAt'>;
}

/** Job ID for a schedule tick. Identical across instances, so each tick is enqueued once. */
export function scheduleJobId(scheduleId: string, tickMs: number): string {
  return `schedule:${scheduleId}:${tickMs}`;
}

function assertTimezone(tz: string, option: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new JobsError(
      JobsErrorCode.InvalidSchedule,
      `Invalid option "${option}": unknown time zone`,
      {
        status: 500,
        expose: false,
      },
    );
  }
}

function compile(def: ScheduleDefinition, index: number, now: number): CompiledSchedule {
  const at = `schedules[${index}]`;
  if (!def || typeof def !== 'object') throw invalidOption(at, 'must be an object');
  if (typeof def.id !== 'string' || !SCHEDULE_ID.test(def.id)) {
    throw invalidOption(`${at}.id`, 'must be 1 to 100 letters, digits, ".", "_", ":" or "-"');
  }
  assertJobName(def.name);
  const hasCron = def.cron !== undefined;
  const hasEvery = def.every !== undefined;
  if (hasCron === hasEvery) {
    throw new JobsError(
      JobsErrorCode.InvalidSchedule,
      `Schedule "${def.id}" must define exactly one of "cron" and "every"`,
      { status: 500, expose: false },
    );
  }
  const addOptions: Omit<AddOptions, 'jobId' | 'runAt'> = {};
  if (def.priority !== undefined) addOptions.priority = def.priority;
  if (def.maxAttempts !== undefined) addOptions.maxAttempts = def.maxAttempts;
  if (def.backoff !== undefined) {
    addOptions.backoff = validateBackoff(def.backoff, `${at}.backoff`) as SerializableBackoff;
  }
  const compiled: CompiledSchedule = { def, anchor: 0, lastChecked: now, addOptions };
  if (hasCron) {
    if (typeof def.cron !== 'string') throw invalidOption(`${at}.cron`, 'must be a string');
    const timezone = def.timezone ?? 'UTC';
    assertTimezone(timezone, `${at}.timezone`);
    try {
      compiled.cron = new Cron(def.cron, { timezone, paused: true });
    } catch (err) {
      throw new JobsError(
        JobsErrorCode.InvalidSchedule,
        `Schedule "${def.id}" has an invalid cron expression: ${errorInfo(err).message}`,
        { status: 500, expose: false, cause: err },
      );
    }
  } else {
    if (def.timezone !== undefined) {
      throw invalidOption(`${at}.timezone`, 'applies to cron schedules only');
    }
    if (typeof def.every !== 'number' || !Number.isInteger(def.every) || def.every < 1000) {
      throw invalidOption(
        `${at}.every`,
        'must be an integer number of milliseconds, at least 1000',
      );
    }
    compiled.every = def.every;
    if (def.anchor !== undefined) {
      if (!(def.anchor instanceof Date) || Number.isNaN(def.anchor.getTime())) {
        throw invalidOption(`${at}.anchor`, 'must be a valid Date');
      }
      compiled.anchor = def.anchor.getTime();
    }
  }
  return compiled;
}

/** Tick times in (from, to], oldest first, at most `max` of the most recent ones. */
function ticksBetween(s: CompiledSchedule, from: number, to: number, max: number): number[] {
  if (to <= from) return [];
  if (s.every !== undefined) {
    const first = Math.floor((from - s.anchor) / s.every) + 1;
    const last = Math.floor((to - s.anchor) / s.every);
    const start = Math.max(first, last - max + 1);
    const out: number[] = [];
    for (let k = start; k <= last; k++) out.push(s.anchor + k * s.every);
    return out;
  }
  const cron = s.cron;
  if (!cron) return [];
  const out: number[] = [];
  let cursor = new Date(from);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > to) break;
    out.push(next.getTime());
    if (out.length > max) out.shift();
    cursor = next;
  }
  return out;
}

/**
 * Enqueues recurring jobs. Run it in as many processes as you like: every tick maps to a
 * deterministic job ID, so the queue stores exactly one job per schedule and tick.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  if (!options || typeof options !== 'object') throw invalidOption('options', 'must be an object');
  if (!options.queue || typeof options.queue.add !== 'function') {
    throw invalidOption('queue', 'must provide add()');
  }
  if (!Array.isArray(options.schedules)) throw invalidOption('schedules', 'must be an array');
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw invalidOption('pollIntervalMs', 'must be an integer of at least 10');
  }
  const lookback = options.initialLookbackMs ?? 0;
  if (!Number.isFinite(lookback) || lookback < 0) {
    throw invalidOption('initialLookbackMs', 'must be a non-negative number');
  }
  const now = clock.now();
  const schedules = new Map<string, CompiledSchedule>();
  options.schedules.forEach((def, i) => {
    const compiled = compile(def, i, now - lookback);
    if (schedules.has(compiled.def.id)) {
      throw invalidOption(`schedules[${i}].id`, `duplicate schedule id "${compiled.def.id}"`);
    }
    schedules.set(compiled.def.id, compiled);
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<EnqueuedTick[]> | undefined;

  const runTick = async (): Promise<EnqueuedTick[]> => {
    const current = clock.now();
    const out: EnqueuedTick[] = [];
    for (const s of schedules.values()) {
      const ticks = ticksBetween(s, s.lastChecked, current, s.def.catchUp ? MAX_CATCH_UP : 1);
      try {
        for (const tickMs of ticks) {
          const jobId = scheduleJobId(s.def.id, tickMs);
          await options.queue.add(s.def.name, s.def.payload ?? null, {
            ...s.addOptions,
            jobId,
            runAt: new Date(tickMs),
          });
          out.push({ scheduleId: s.def.id, jobId, runAt: new Date(tickMs) });
        }
        s.lastChecked = current;
      } catch (err) {
        // lastChecked stays put, so the tick is retried; the job ID keeps it idempotent.
        logger.error(
          { err: errorInfo(err), scheduleId: s.def.id },
          'jobs: scheduler failed to enqueue a tick',
        );
      }
    }
    return out;
  };

  return {
    tick() {
      if (!running) {
        running = runTick().finally(() => {
          running = undefined;
        });
      }
      return running;
    },

    nextRun(scheduleId) {
      const s = schedules.get(scheduleId);
      if (!s) return undefined;
      const current = clock.now();
      if (s.every !== undefined) {
        const k = Math.floor((current - s.anchor) / s.every) + 1;
        return new Date(s.anchor + k * s.every);
      }
      return s.cron?.nextRun(new Date(current)) ?? undefined;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick();
      }, pollIntervalMs);
      void this.tick();
      logger.info({ schedules: [...schedules.keys()] }, 'jobs: scheduler started');
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await running;
    },
  };
}
