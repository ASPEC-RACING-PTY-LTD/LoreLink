// Integration ports (docs/architecture/integration-ports.md), copied verbatim.

export interface CacheLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthCheckable {
  checkHealth(): Promise<HealthCheckResult>;
}

export interface Clock {
  now(): number;
}
