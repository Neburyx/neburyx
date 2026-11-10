import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrateCommand } from '../migrate/command.js';
import type { TestDatabase } from './postgres.js';

const folders: string[] = [];

export function fixtureFolder(files: Readonly<Record<string, string>>): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  folders.push(folder);
  addFiles(folder, files);
  return folder;
}

export function addFiles(folder: string, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
}

export function removeFixtureFolders(): void {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
}

export async function rows(url: string, query: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(query, [...parameters])).rows;
  } finally {
    await client.end();
  }
}

export async function runInProcess(
  env: Readonly<Record<string, string | undefined>>,
  directory: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runMigrateCommand(env, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    directory,
  });
  return { code, stdout, stderr };
}

export async function attempt(url: string, statement: string, parameters: readonly unknown[] = []): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement, [...parameters]);
    return 'allowed';
  } catch (error) {
    return error instanceof Error ? error.message : 'refused';
  } finally {
    await client.end();
  }
}

export async function waiters(url: string, lockId: string): Promise<readonly number[]> {
  const found = await rows(
    url,
    `SELECT DISTINCT l.pid::int AS pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = current_database()
       AND ((l.classid::bigint << 32) | l.objid::bigint) = ${lockId}::bigint ORDER BY 1`,
  );
  return found.map((row) => Number(row['pid']));
}

/** Everything a migrate run could change: tables, history, queue ids, privileges, schemas, policies and default privileges. */
export async function snapshot(database: TestDatabase): Promise<string> {
  const tables = await rows(
    database.ownerUrl,
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'graphile_worker') ORDER BY 1, 2`,
  );
  const history = await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name');
  const queue = await rows(database.ownerUrl, 'SELECT id FROM graphile_worker.migrations ORDER BY id');
  const privileges = await rows(
    database.ownerUrl,
    `SELECT n.nspname, c.relname, c.relkind, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'graphile_worker') AND c.relkind IN ('r', 'S', 'v') ORDER BY 1, 2`,
  );
  const schemas = await rows(database.ownerUrl, `SELECT nspname, nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('public', 'graphile_worker') ORDER BY 1`);
  const policies = await rows(
    database.ownerUrl,
    `SELECT schemaname, tablename, policyname, roles::text AS roles, cmd, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`,
  );
  const defaults = await rows(database.ownerUrl, `SELECT defaclobjtype, defaclacl::text AS acl FROM pg_default_acl ORDER BY 1`);
  return JSON.stringify({ tables, history, queue, privileges, schemas, policies, defaults });
}
