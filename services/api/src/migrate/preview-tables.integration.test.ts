import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRegisteredExtension, type ExtensionLoader } from '../profile/extension.js';
import { attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const PREVIEW_MIGRATIONS = fileURLToPath(new URL('../../../../ee/migrations', import.meta.url));
const PREVIEW_FILE = join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ai: { preview: true } }) }), 'neburyx.yaml');
const loader: ExtensionLoader = { load: () => Promise.resolve({ name: 'preview', routeGroups: [], migrationsDirectory: PREVIEW_MIGRATIONS }) };

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

const environment = (database: TestDatabase) => ({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole });
const previewOn = (database: TestDatabase) => ({ ...environment(database), NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' });

async function migratedWithPreview(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return database;
}

const columnsOf = async (database: TestDatabase, table: string) =>
  rows(database.ownerUrl, `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);

const AUDIT_ROW = (over: Record<string, unknown> = {}): readonly unknown[] => {
  const row = { id: randomUUID(), actor: randomUUID(), role: 'administrator', action: 'graph.expand', result: 'success', trace: 'tr-1', ...over };
  return [row.id, row.actor, row.role, row.action, row.result, row.trace];
};
const INSERT_AUDIT = 'INSERT INTO audit_events (id, actor_id, actor_role, action, result, trace_id) VALUES ($1, $2, $3, $4, $5, $6)';

describe('the audit_events table of the preview', () => {
  it('has the columns of the data model, with null allowed on the optional ones only, and the primary key (at, id)', async () => {
    const database = await migratedWithPreview();
    expect(await columnsOf(database, 'audit_events')).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actor_role', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'action', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'result', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'source_id', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'investigation_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'resource_type', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'resource_ref', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'trace_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'detail', data_type: 'jsonb', is_nullable: 'YES' },
    ]);
    const key = await rows(database.ownerUrl, `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = 'audit_events'::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`);
    expect(key.map((entry) => entry['attname'])).toEqual(['at', 'id']);
    const defaulted = await rows(database.ownerUrl, `SELECT column_default FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'at'`);
    expect(defaulted[0]?.['column_default']).toBe('clock_timestamp()');
  });

  it('has one index on each of actor, action, investigation and source with the time descending, and no foreign key', async () => {
    const database = await migratedWithPreview();
    const indexes = await rows(database.ownerUrl, `SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_events' AND indexname <> 'audit_events_pkey' ORDER BY indexname`);
    expect(indexes.map((entry) => String(entry['indexdef']).replace(/^.*\((.*)\)$/, '$1'))).toEqual(['action, at DESC', 'actor_id, at DESC', 'investigation_id, at DESC', 'source_id, at DESC']);
    expect(await rows(database.ownerUrl, `SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_events'::regclass AND contype = 'f'`)).toEqual([]);
  });

  it.each(['success', 'denied', 'partial', 'refused', 'failed'])('accepts the result %s from the application role, and reads the row back', async (result) => {
    const database = await migratedWithPreview();
    const values = AUDIT_ROW({ result });
    expect(await attempt(database.appUrl, INSERT_AUDIT, values)).toBe('allowed');
    expect(await rows(database.appUrl, 'SELECT result FROM audit_events WHERE id = $1', [values[0]])).toEqual([{ result }]);
  });

  it('refuses a result outside the five, and a null in any required column', async () => {
    const database = await migratedWithPreview();
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW({ result: 'ok' }))).toMatch(/audit_events_result_known/);
    for (const [index, column] of ['id', 'actor_id', 'actor_role', 'action', 'result', 'trace_id'].entries()) {
      const values = [...AUDIT_ROW()];
      values[index] = null;
      expect(await attempt(database.appUrl, INSERT_AUDIT, values), column).toMatch(/null value|violates not-null/);
    }
  });

  it('refuses the application role an update, a delete and a truncate, on the first migrate and after a second one', async () => {
    const database = await migratedWithPreview();
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW())).toBe('allowed');
    const second = await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader });
    expect([second.code, second.stdout]).toEqual([0, 'nothing to apply\n']);
    for (const statement of ["UPDATE audit_events SET action = 'x'", 'DELETE FROM audit_events', 'TRUNCATE audit_events']) {
      expect(await attempt(database.appUrl, statement), statement).toMatch(/permission denied/);
    }
  });

  it('gives the application role nothing, and grants nothing silently, when the default rights were removed before the preview migration', async () => {
    const database = await postgres.newDatabase();
    expect((await runInProcess(environment(database), SHIPPED)).code).toBe(0);
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${owner.escapeIdentifier(database.appRole)}`);
    } finally {
      await owner.end();
    }
    expect((await runInProcess(previewOn(database), SHIPPED, { extensionLoader: loader })).code).toBe(0);
    expect(await attempt(database.appUrl, INSERT_AUDIT, AUDIT_ROW())).toMatch(/permission denied/);
    expect(await attempt(database.appUrl, 'SELECT * FROM audit_events')).toMatch(/permission denied/);
  });
});

describe('the ask_runs table of the preview', () => {
  const user = async (database: TestDatabase): Promise<string> => {
    const id = randomUUID();
    await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'local', $2, 'Test user')`, [id, id]);
    return id;
  };
  const INSERT_RUN = 'INSERT INTO ask_runs (id, plan_id, actor_id, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, $4, $5, $6)';

  it('has the columns of the data model, all required, with the id as primary key and created_at defaulting to the database clock', async () => {
    const database = await migratedWithPreview();
    expect(await columnsOf(database, 'ask_runs')).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'plan_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'outcome', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'row_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'elapsed_ms', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
    const constraints = await rows(database.ownerUrl, `SELECT contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'ask_runs'::regclass AND contype IN ('p', 'f') ORDER BY contype`);
    expect(constraints).toEqual([
      { contype: 'f', definition: 'FOREIGN KEY (actor_id) REFERENCES users(id)' },
      { contype: 'p', definition: 'PRIMARY KEY (id)' },
    ]);
  });

  it.each(['complete', 'partial', 'failed'])('lets the application role insert a run with the outcome %s and read it back', async (outcome) => {
    const database = await migratedWithPreview();
    const actor = await user(database);
    const id = randomUUID();
    expect(await attempt(database.appUrl, INSERT_RUN, [id, randomUUID(), actor, outcome, 3, 120])).toBe('allowed');
    expect(await rows(database.appUrl, 'SELECT outcome, row_count, elapsed_ms FROM ask_runs WHERE id = $1', [id])).toEqual([{ outcome, row_count: 3, elapsed_ms: 120 }]);
  });

  it('refuses an actor that is no user, an unknown outcome and a negative count, and needs no plan: plan_id is any uuid', async () => {
    const database = await migratedWithPreview();
    const actor = await user(database);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), randomUUID(), 'complete', 1, 1])).toMatch(/foreign key/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), actor, 'ok', 1, 1])).toMatch(/ask_runs_outcome_known/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), actor, 'complete', -1, 1])).toMatch(/ask_runs_row_count_not_negative/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), actor, 'complete', 1, -1])).toMatch(/ask_runs_elapsed_not_negative/);
    expect(await attempt(database.appUrl, INSERT_RUN, [randomUUID(), randomUUID(), actor, 'complete', 1, 1])).toBe('allowed');
  });
});

describe('a start of the Community product', () => {
  it('creates neither table, and loads no preview migration', async () => {
    const database = await postgres.newDatabase();
    const result = await runInProcess(environment(database), SHIPPED);
    expect(result.code).toBe(0);
    const found = await rows(database.ownerUrl, `SELECT to_regclass('public.audit_events') IS NOT NULL AS audit, to_regclass('public.ask_runs') IS NOT NULL AS runs`);
    expect(found).toEqual([{ audit: false, runs: false }]);
  });
});
