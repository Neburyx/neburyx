import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:16.15';

export interface TestDatabase {
  readonly ownerUrl: string;
  readonly appRole: string;
  readonly appUrl: string;
  readonly adminUrl: string;
}

export interface TestPostgres {
  newDatabase(): Promise<TestDatabase>;
  stop(): Promise<void>;
}

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const host = container.getHost();
  const port = container.getPort();
  const adminUrl = container.getConnectionUri();

  async function admin(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    return client;
  }

  return {
    async newDatabase(): Promise<TestDatabase> {
      const name = identifier('db');
      const owner = identifier('mig');
      const appRole = identifier('app');
      const client = await admin();
      try {
        await client.query(`CREATE ROLE ${owner} LOGIN PASSWORD 'owner-password'`);
        await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD 'app-password'`);
        await client.query(`CREATE DATABASE ${name} OWNER ${owner}`);
      } finally {
        await client.end();
      }
      const urlFor = (role: string, password: string): string => `postgres://${role}:${password}@${host}:${port}/${name}`;
      return {
        ownerUrl: urlFor(owner, 'owner-password'),
        appRole,
        appUrl: urlFor(appRole, 'app-password'),
        adminUrl: urlFor('test', 'test'),
      };
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}
