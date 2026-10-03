import type { SqlClient } from '../../src/ports.js';
import { createMemoryBackend } from '../../src/stores/memory.js';
import { createSqlBackend, migrate } from '../../src/stores/sql.js';
import type { JobsBackend } from '../../src/types.js';
import {
  createPostgresClient,
  createSqliteClient,
  POSTGRES_URL,
  type PostgresTestClient,
} from './sql.js';

export interface BackendFixture {
  readonly name: 'memory' | 'sqlite' | 'postgres';
  readonly skip: boolean;
  /** Called once per file. */
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** A fresh, empty backend. */
  create(): Promise<JobsBackend>;
  /** The SQL client of the last backend (SQL fixtures only). */
  client?(): SqlClient;
}

export function backendFixtures(): BackendFixture[] {
  let sqlite: (SqlClient & { close(): void }) | undefined;
  const sqliteClients: (SqlClient & { close(): void })[] = [];
  let pgClient: PostgresTestClient | undefined;
  let pgCounter = 0;

  return [
    {
      name: 'memory',
      skip: false,
      async setup() {},
      async teardown() {},
      async create() {
        return createMemoryBackend();
      },
    },
    {
      name: 'sqlite',
      skip: false,
      async setup() {},
      async teardown() {
        for (const c of sqliteClients) c.close();
      },
      async create() {
        sqlite = createSqliteClient();
        sqliteClients.push(sqlite);
        await migrate(sqlite);
        return createSqlBackend(sqlite);
      },
      client() {
        if (!sqlite) throw new Error('no sqlite client');
        return sqlite;
      },
    },
    {
      name: 'postgres',
      skip: !POSTGRES_URL,
      async setup() {
        if (POSTGRES_URL) pgClient = await createPostgresClient(POSTGRES_URL);
      },
      async teardown() {
        await pgClient?.close();
      },
      async create() {
        if (!pgClient) throw new Error('postgres not configured');
        pgCounter += 1;
        const tablePrefix = `t${pgCounter}_`;
        await migrate(pgClient, { tablePrefix });
        return createSqlBackend(pgClient, { tablePrefix });
      },
      client() {
        if (!pgClient) throw new Error('postgres not configured');
        return pgClient;
      },
    },
  ];
}
