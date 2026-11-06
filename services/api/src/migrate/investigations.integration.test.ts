import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourcesResponseSchema, type SourceTestReport } from '@neburyx/contracts';
import { createAppStore, type AppStore } from '../app-store.js';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { reportFromServer } from '../source-test/report.js';
import { runCli } from '../testing/cli.js';
import { attempt, rows, runInProcess } from '../testing/database.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const EARLIEST_SEVEN = ['0001-baseline', '0002-deployment-and-users', '0003-applied-migrations-function', '0004-sources', '0005-source-checks', '0006-source-check-identity', '0007-source-check-config'];

let postgres: TestPostgres;
const folders: string[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

function envFor(database: TestDatabase): Record<string, string> {
  return { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
}

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], envFor(database)).done).code).toBe(0);
  return database;
}

const OWNER = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const SECOND = '0192f000-0000-7000-8000-0000000000a2';
const DRAFT = '0192f000-0000-7000-8000-0000000000b1';
const NAMED = '0192f000-0000-7000-8000-0000000000b2';

async function seeded(): Promise<TestDatabase> {
  const database = await migrated();
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ('${OWNER}', 'issuer', 'one', 'One'), ('${OTHER}', 'issuer', 'two', 'Two')`);
  await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('alpha', 'alpha', 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`);
  return database;
}

function investigation(columns: Readonly<Record<string, string>> = {}): string {
  const values = { id: `'${INVESTIGATION}'`, source_id: `'alpha'`, source_identity_hash: `'i'`, owner_id: `'${OWNER}'`, title: `'Account A-1'`, ...columns };
  return `INSERT INTO investigations (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')})`;
}

function view(columns: Readonly<Record<string, string>> = {}): string {
  const values = {
    id: `'${DRAFT}'`,
    investigation_id: `'${INVESTIGATION}'`,
    kind: `'draft'`,
    layout: `'{}'`,
    query_context: `'{}'`,
    mapping_hash: `'h'`,
    content_hash: `'c'`,
    counts_policy_version: `'none'`,
    created_by: `'${OWNER}'`,
    ...columns,
  };
  return `INSERT INTO saved_views (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')})`;
}

describe('the investigations and saved_views tables', () => {
  it('have the columns of the data model', async () => {
    const database = await migrated();
    const columnsOf = async (table: string) =>
      (await rows(database.ownerUrl, `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`)).map(
        (column) => `${String(column['column_name'])} ${String(column['data_type'])} ${column['is_nullable'] === 'YES' ? 'null' : 'not null'}`,
      );
    expect(await columnsOf('investigations')).toEqual([
      'id uuid not null',
      'source_id text not null',
      'source_identity_hash text not null',
      'owner_id uuid not null',
      'title text not null',
      'case_ref text null',
      'starting_entity_type text null',
      'starting_stable_id text null',
      'status text not null',
      'created_at timestamp with time zone not null',
      'last_edited_at timestamp with time zone not null',
      'closed_at timestamp with time zone null',
      'archived_at timestamp with time zone null',
      'deleted_at timestamp with time zone null',
      'purge_after timestamp with time zone null',
      'deleted_by uuid null',
      'version integer not null',
    ]);
    expect(await columnsOf('saved_views')).toEqual([
      'id uuid not null',
      'investigation_id uuid not null',
      'kind text not null',
      'name text null',
      'notes text null',
      'ai_notes jsonb null',
      'layout jsonb not null',
      'query_context jsonb not null',
      'mapping_hash text not null',
      'content_hash text not null',
      'based_on_view_id uuid null',
      'node_count integer not null',
      'edge_count integer not null',
      'counts_policy_version text not null',
      'created_by uuid not null',
      'created_at timestamp with time zone not null',
      'updated_at timestamp with time zone not null',
      'version integer not null',
    ]);
  });

  it('have the indexes of the data model, with their conditions', async () => {
    const database = await migrated();
    const indexes = await rows(database.ownerUrl, `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('investigations', 'saved_views') ORDER BY indexname`);
    const definition = (name: string): string => String(indexes.find((index) => index['indexname'] === name)?.['indexdef']);
    expect(definition('investigations_owner_edited')).toMatch(/\(owner_id, last_edited_at DESC\) WHERE \(deleted_at IS NULL\)/);
    expect(definition('investigations_source_edited')).toMatch(/\(source_id, last_edited_at DESC\) WHERE \(deleted_at IS NULL\)/);
    expect(definition('investigations_title_trigram')).toMatch(/USING gin \(title gin_trgm_ops\)/);
    expect(definition('investigations_case_ref_trigram')).toMatch(/USING gin \(case_ref gin_trgm_ops\)/);
    expect(definition('investigations_open_case_ref')).toMatch(/\(owner_id, source_id, case_ref\) WHERE \(\(status = 'open'::text\) AND \(deleted_at IS NULL\)\)/);
    expect(definition('saved_views_one_draft')).toMatch(/CREATE UNIQUE INDEX .* \(investigation_id, created_by\) WHERE \(kind = 'draft'::text\)/);
  });

  it('let the app role select, insert, update and delete', async () => {
    const database = await seeded();
    expect(await attempt(database.appUrl, investigation())).toBe('allowed');
    expect(await attempt(database.appUrl, view())).toBe('allowed');
    expect(await attempt(database.appUrl, `UPDATE investigations SET title = 'Renamed', version = version + 1`)).toBe('allowed');
    expect(await attempt(database.appUrl, `UPDATE saved_views SET notes = 'a note'`)).toBe('allowed');
    expect((await rows(database.appUrl, 'SELECT title FROM investigations')).map((row) => row['title'])).toEqual(['Renamed']);
    expect(await attempt(database.appUrl, `DELETE FROM investigations WHERE id = '${INVESTIGATION}'`)).toBe('allowed');
    expect(await rows(database.appUrl, 'SELECT id FROM saved_views')).toEqual([]);
  });

  it('refuse a source, an owner or an investigation that does not exist', async () => {
    const database = await seeded();
    expect(await attempt(database.ownerUrl, investigation({ source_id: `'missing'` }))).toMatch(/investigations_source_id_fkey/);
    expect(await attempt(database.ownerUrl, investigation({ owner_id: `'${'0192f000-0000-7000-8000-0000000000ff'}'` }))).toMatch(/investigations_owner_id_fkey/);
    expect(await attempt(database.ownerUrl, view())).toMatch(/saved_views_investigation_id_fkey/);
  });

  it('refuse a second draft for the same investigation and user, and allow one for another user', async () => {
    const database = await seeded();
    expect(await attempt(database.ownerUrl, investigation())).toBe('allowed');
    expect(await attempt(database.ownerUrl, view())).toBe('allowed');
    expect(await attempt(database.ownerUrl, view({ id: `'${NAMED}'` }))).toMatch(/saved_views_one_draft/);
    expect(await attempt(database.ownerUrl, view({ id: `'${NAMED}'`, created_by: `'${OTHER}'` }))).toBe('allowed');
  });

  it('refuse an unknown status, an unknown kind and a named view with no name', async () => {
    const database = await seeded();
    expect(await attempt(database.ownerUrl, investigation({ status: `'paused'` }))).toMatch(/investigations_status_known/);
    expect(await attempt(database.ownerUrl, investigation())).toBe('allowed');
    expect(await attempt(database.ownerUrl, view({ kind: `'snapshot'` }))).toMatch(/saved_views_kind_known/);
    expect(await attempt(database.ownerUrl, view({ kind: `'named'` }))).toMatch(/saved_views_named_has_name/);
    expect(await attempt(database.ownerUrl, view({ kind: `'named'`, name: `'First look'` }))).toBe('allowed');
  });

  it('refuse a starting entity with only one of its two parts', async () => {
    const database = await seeded();
    expect(await attempt(database.ownerUrl, investigation({ starting_entity_type: `'account'` }))).toMatch(/investigations_starting_entity_whole/);
    expect(await attempt(database.ownerUrl, investigation({ starting_entity_type: `'account'`, starting_stable_id: `'A-1'` }))).toBe('allowed');
  });

  it('count the text limits in characters, not bytes', async () => {
    const database = await seeded();
    const repeated = (character: string, count: number): string => `repeat('${character}', ${count})`;
    expect(await attempt(database.ownerUrl, investigation({ title: repeated('😀', 200) }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, investigation({ id: `'${SECOND}'`, title: repeated('😀', 201) }))).toMatch(/investigations_title_length/);
    expect(await attempt(database.ownerUrl, investigation({ id: `'${SECOND}'`, title: `''` }))).toMatch(/investigations_title_length/);
    expect(await attempt(database.ownerUrl, investigation({ id: `'${SECOND}'`, case_ref: repeated('é', 100) }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, investigation({ id: `'0192f000-0000-7000-8000-0000000000a3'`, case_ref: repeated('é', 101) }))).toMatch(/investigations_case_ref_length/);
    expect(await attempt(database.ownerUrl, view({ kind: `'named'`, name: repeated('€', 120) }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, view({ id: `'${NAMED}'`, kind: `'named'`, name: repeated('€', 121) }))).toMatch(/saved_views_name_length/);
    expect(await attempt(database.ownerUrl, view({ id: `'${NAMED}'`, created_by: `'${OTHER}'`, notes: repeated('😀', 10000) }))).toBe('allowed');
    expect(await attempt(database.ownerUrl, view({ id: `'0192f000-0000-7000-8000-0000000000b3'`, kind: `'named'`, name: `'Other'`, notes: repeated('😀', 10001) }))).toMatch(/saved_views_notes_length/);
  });

  it('set a view that was restored from to null when that view is deleted, and delete the views with their investigation', async () => {
    const database = await seeded();
    await rows(database.ownerUrl, investigation());
    await rows(database.ownerUrl, view({ id: `'${NAMED}'`, kind: `'named'`, name: `'First look'` }));
    await rows(database.ownerUrl, view({ based_on_view_id: `'${NAMED}'` }));
    await rows(database.ownerUrl, `DELETE FROM saved_views WHERE id = '${NAMED}'`);
    expect((await rows(database.ownerUrl, `SELECT based_on_view_id FROM saved_views WHERE id = '${DRAFT}'`))[0]?.['based_on_view_id']).toBeNull();
    await rows(database.ownerUrl, `DELETE FROM investigations WHERE id = '${INVESTIGATION}'`);
    expect(await rows(database.ownerUrl, 'SELECT id FROM saved_views')).toEqual([]);
  });
});

describe('an earlier release', () => {
  const mapping = mappingOf(sourceWith('alpha'));
  const [alpha] = mapping.sources;
  if (alpha === undefined) throw new Error('the fixture mapping has a source');
  const SERVER: CapabilitiesItem = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };

  function earlierSet(): string {
    const folder = mkdtempSync(join(tmpdir(), 'earlier-migrations-'));
    folders.push(folder);
    mkdirSync(folder, { recursive: true });
    for (const name of EARLIEST_SEVEN) cpSync(join(SHIPPED, `${name}.sql`), join(folder, `${name}.sql`));
    return folder;
  }

  it('reads what it stored, and starts, against the database after this migration', async () => {
    const earlier = earlierSet();
    const database = await postgres.newDatabase();
    expect((await runInProcess(envFor(database), earlier)).code).toBe(0);
    const before = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: earlier });
    let stored: { sources: unknown; checks: unknown; identity: unknown };
    try {
      await before.initialize();
      await before.syncSources(mapping.sources);
      const report: SourceTestReport = reportFromServer(alpha, SERVER, null, new Date(Date.UTC(2026, 10, 2, 10, 0, 0)).toISOString());
      await before.recordSourceCheck({ id: '0192f000-0000-7000-8000-0000000000c1', report, triggeredBy: null, identityHash: identityHashOf(alpha), configHash: alpha.configHash });
      const checked = [{ id: alpha.id, identityHash: identityHashOf(alpha), configHash: alpha.configHash }];
      stored = { sources: await before.listSources(), checks: await before.latestChecksFor(checked), identity: await before.current() };
    } finally {
      await before.close();
    }

    expect((await runCli(['migrate'], envFor(database)).done).code).toBe(0);

    const after = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: earlier });
    try {
      const checked = [{ id: alpha.id, identityHash: identityHashOf(alpha), configHash: alpha.configHash }];
      expect({ sources: await after.listSources(), checks: await after.latestChecksFor(checked), identity: await after.current() }).toEqual(stored);
      expect((await after.readiness()).migrations).toBe('ok');
    } finally {
      await after.close();
    }

    const { result } = await startApi({ DATABASE_URL: database.appUrl }, earlier);
    if (result.exitCode !== 0) throw new Error('the earlier release did not start against the migrated database');
    try {
      const ready = await result.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ checks: { migrations: 'ok' } });
      expect((await result.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
      const sources = await result.app.inject({ method: 'GET', url: '/v1/sources' });
      expect(sources.statusCode).toBe(200);
      expect(sourcesResponseSchema.parse(sources.json()).items).toEqual([]);
    } finally {
      await stopApi(result);
    }
  });
});
