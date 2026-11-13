import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { runCli } from './cli.js';
import { rows } from './database.js';
import type { TestDatabase, TestPostgres } from './postgres.js';

export interface SeededDatabase {
  readonly database: TestDatabase;
  readonly sourceId: string;
  readonly otherSourceId: string;
  readonly actorId: string;
}

/** A migrated database with two sources and one user, so a test can write and read events. */
export async function seededDatabase(postgres: TestPostgres): Promise<SeededDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  const actorId = randomUUID();
  for (const id of ['alpha', 'beta']) {
    await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ($1, $1, 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`, [id]);
  }
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'subject', 'Person')`, [actorId]);
  return { database, sourceId: 'alpha', otherSourceId: 'beta', actorId };
}
