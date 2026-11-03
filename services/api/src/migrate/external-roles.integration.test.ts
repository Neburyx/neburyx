import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi } from '../testing/start-api.js';

const SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'tools', 'dev', 'external-postgres.sql'), 'utf8');
const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const MIGRATION_PASSWORD = 'migration-pw-1';
const APP_PASSWORD = 'app-pw-2';

let postgres: TestPostgres;
let migrationUrl: string;
let appUrl: string;

beforeAll(async () => {
  postgres = await startPostgres();
  await postgres.runPsql(SQL, { migration_password: MIGRATION_PASSWORD, app_password: APP_PASSWORD });
  const { host, port } = postgres.address();
  migrationUrl = `postgres://neburyx_dev_migrate:${MIGRATION_PASSWORD}@${host}:${port}/neburyx_dev`;
  appUrl = `postgres://neburyx_dev_app:${APP_PASSWORD}@${host}:${port}/neburyx_dev`;
});

afterAll(async () => {
  await postgres.stop();
});

describe('the statements for an external Postgres', () => {
  it('create a database owned by the migration login and two logins with no more rights than they need', async () => {
    const found = await rows(migrationUrl, `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname LIKE 'neburyx_dev_%' ORDER BY 1`);
    expect(found).toEqual([
      { rolname: 'neburyx_dev_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true },
      { rolname: 'neburyx_dev_migrate', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true },
    ]);
    expect(await rows(migrationUrl, `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'neburyx_dev'`)).toEqual([{ owner: 'neburyx_dev_migrate' }]);
  });

  it('let migrate apply every shipped migration as the migration login, including the pg_trgm extension', async () => {
    const result = await runInProcess({ DATABASE_MIGRATION_URL: migrationUrl, DATABASE_APP_ROLE: 'neburyx_dev_app' }, SHIPPED_MIGRATIONS);
    expect(result.code, result.stderr).toBe(0);
    expect(await rows(migrationUrl, `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)).toEqual([{ extname: 'pg_trgm' }]);
    expect((await rows(migrationUrl, 'SELECT count(*)::int AS applied FROM kysely_migration'))[0]?.['applied']).toBeGreaterThan(0);
  });

  it('let the API start as the app login and answer /readyz with 200', async () => {
    const { result, stderr } = await startApi({ DATABASE_URL: appUrl });
    try {
      expect(result.exitCode, stderr).toBe(0);
      if (result.exitCode !== 0) return;
      const response = await result.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
    } finally {
      await stopApi(result);
    }
  });

  it('fail for a login that does not exist or a database that cannot be reached, with a message that holds no connection detail', async () => {
    const { host, port } = postgres.address();
    for (const url of [`postgres://missing_role:pw-secret@${host}:${port}/neburyx_dev`, 'postgres://other-user:pw-secret@127.0.0.1:1/other_db']) {
      const { result, stderr } = await startApi({ DATABASE_URL: url });
      try {
        expect(result.exitCode).not.toBe(0);
        for (const detail of ['missing_role', 'pw-secret', 'other-user', 'other_db', '127.0.0.1', host]) expect(stderr).not.toContain(detail);
      } finally {
        await stopApi(result);
      }
    }
  });
});
