// Structural ports copied verbatim from docs/architecture/integration-ports.md (v1).

export type SqlDialect = 'postgres' | 'sqlite';

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  readonly dialect: SqlDialect;
  /**
   * Positional placeholders are always $1, $2, ... regardless of dialect.
   * A query without parameters may contain several statements separated by semicolons
   * (used by migrations); a query with parameters must contain exactly one statement.
   */
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  /** Runs fn inside a transaction. Nested calls use savepoints or join the outer transaction. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface EnqueueOptions {
  delayMs?: number;
  runAt?: Date;
  priority?: number; // lower runs first, default 0
  maxAttempts?: number;
  jobId?: string; // idempotency key; duplicate adds return the existing job
}

export interface JobQueue {
  add(name: string, payload: unknown, options?: EnqueueOptions): Promise<{ id: string }>;
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
} // epoch ms
export type IdGenerator = () => string;
