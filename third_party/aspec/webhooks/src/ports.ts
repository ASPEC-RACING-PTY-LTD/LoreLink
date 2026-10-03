// Structural ports copied verbatim from docs/architecture/integration-ports.md.

export type SqlDialect = 'postgres' | 'sqlite';

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  readonly dialect: SqlDialect;
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
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
  priority?: number;
  maxAttempts?: number;
  jobId?: string;
}

export interface JobQueue {
  add(name: string, payload: unknown, options?: EnqueueOptions): Promise<{ id: string }>;
}

export interface Subject {
  id: string;
  type?: 'user' | 'service' | 'api_key' | (string & {});
  roles?: readonly string[];
  orgId?: string;
  teamIds?: readonly string[];
  attributes?: Record<string, unknown>;
}

export interface ResourceRef {
  type: string;
  id?: string;
  ownerId?: string;
  orgId?: string;
  teamId?: string;
  attributes?: Record<string, unknown>;
}

export interface PermissionChecker {
  can(subject: Subject, permission: string, resource?: ResourceRef): Promise<boolean>;
}

export interface Clock {
  now(): number;
}
export type IdGenerator = () => string;
