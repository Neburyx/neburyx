import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

let counter = 0;
function user(columns: Readonly<Record<string, string>> = {}): string {
  counter += 1;
  const values = { id: `'00000000-0000-7000-8000-${String(counter).padStart(12, '0')}'`, issuer: `'issuer'`, subject: `'subject-${counter}'`, display_name: `'Name'`, ...columns };
  return `INSERT INTO users (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')})`;
}

describe('the deployment table', () => {
  it('refuses a second row, a false id, an unknown edition and an unknown identity mode, each by constraint name', async () => {
    const database = await migrated();
    expect(await attempt(database.ownerUrl, `INSERT INTO deployment (edition, identity_mode) VALUES ('community', 'none')`)).toBe('allowed');
    expect(await attempt(database.ownerUrl, `INSERT INTO deployment (edition, identity_mode) VALUES ('community', 'none')`)).toMatch(/deployment_pkey/);
    expect(await attempt(database.ownerUrl, `INSERT INTO deployment (id, edition, identity_mode) VALUES (false, 'community', 'none')`)).toMatch(/deployment_single_row/);
    expect(await attempt(database.ownerUrl, `UPDATE deployment SET edition = 'free'`)).toMatch(/deployment_edition_known/);
    expect(await attempt(database.ownerUrl, `UPDATE deployment SET identity_mode = 'password'`)).toMatch(/deployment_identity_mode_known/);
  });
});

describe('the users table', () => {
  it('refuses a duplicate issuer and subject, an unknown role and an unknown status; accepts a null role', async () => {
    const database = await migrated();
    expect(await attempt(database.ownerUrl, user({ subject: `'same'` }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, user({ subject: `'same'` }))).toMatch(/users_identity_unique/);
    expect(await attempt(database.ownerUrl, user({ role: `'owner'` }))).toMatch(/users_role_known/);
    expect(await attempt(database.ownerUrl, user({ status: `'locked'` }))).toMatch(/users_status_known/);
    expect(await attempt(database.ownerUrl, user({ role: 'NULL' }))).toBe('allowed');
  });

  it('refuses a second active local account with the same login name until the first is disabled, and a second break-glass row', async () => {
    const database = await migrated();
    const local = (columns: Readonly<Record<string, string>>): string => user({ issuer: `'local'`, login_name: `'ana'`, ...columns });
    expect(await attempt(database.ownerUrl, local({}))).toBe('allowed');
    expect(await attempt(database.ownerUrl, local({}))).toMatch(/users_active_local_login_name/);
    expect(await attempt(database.ownerUrl, `UPDATE users SET status = 'disabled' WHERE login_name = 'ana'`)).toBe('allowed');
    expect(await attempt(database.ownerUrl, local({}))).toBe('allowed');

    expect(await attempt(database.ownerUrl, user({ break_glass: 'true' }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, user({ break_glass: 'true' }))).toMatch(/users_single_break_glass/);
  });
});

describe('the migration and the app role', () => {
  it('creates both tables with the listed columns and a second run changes nothing', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    expect((await runCli(['migrate'], env).done).code).toBe(0);
    const columns = async (): Promise<string> =>
      JSON.stringify(
        await rows(
          database.ownerUrl,
          `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name IN ('deployment', 'users') ORDER BY 1, ordinal_position`,
        ),
      );
    const first = await columns();
    expect(JSON.parse(first).map((column: { column_name: string }) => column.column_name)).toEqual([
      'id', 'edition', 'identity_mode', 'initialized_at',
      'id', 'issuer', 'subject', 'login_name', 'break_glass', 'display_name', 'email', 'role', 'status', 'grants_version', 'last_active_at', 'created_at', 'updated_at',
    ]);
    const second = await runCli(['migrate'], env).done;
    expect(second.stdout).toContain('nothing to apply');
    expect(await columns()).toBe(first);
  });

  it('lets the app role select, insert and update both tables, but not alter or drop them', async () => {
    const database = await migrated();
    expect(await attempt(database.appUrl, `INSERT INTO deployment (edition, identity_mode) VALUES ('community', 'none')`)).toBe('allowed');
    expect(await attempt(database.appUrl, `UPDATE deployment SET identity_mode = 'none'`)).toBe('allowed');
    expect(await attempt(database.appUrl, 'SELECT * FROM deployment')).toBe('allowed');
    expect(await attempt(database.appUrl, user())).toBe('allowed');
    expect(await attempt(database.appUrl, `UPDATE users SET display_name = 'Other'`)).toBe('allowed');
    expect(await attempt(database.appUrl, 'SELECT * FROM users')).toBe('allowed');
    expect(await attempt(database.appUrl, 'ALTER TABLE users ADD COLUMN extra text')).toMatch(/must be owner/);
    expect(await attempt(database.appUrl, 'DROP TABLE deployment')).toMatch(/must be owner/);
  });
});
