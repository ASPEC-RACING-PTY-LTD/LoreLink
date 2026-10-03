import type { Clock } from './ports.js';

export interface CircuitBreakerOptions {
  /** Failures before opening. Default 5. */
  threshold?: number;
  /** Milliseconds to stay open before a trial. Default 5000. */
  coolDownMs?: number;
  clock?: Clock;
}

/**
 * Simple consecutive-failure circuit breaker. While open, callers should fail fast without
 * contacting the remote store.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly coolDownMs: number;
  private readonly clock: Clock;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.coolDownMs = options.coolDownMs ?? 5000;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  get open(): boolean {
    if (this.failures < this.threshold) return false;
    if (this.clock.now() - this.openedAt >= this.coolDownMs) {
      // Half-open: allow one trial.
      return false;
    }
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.clock.now();
  }
}
