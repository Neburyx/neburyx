import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investigationResponseSchema, MAX_REFERENCE_VALUE_CHARACTERS, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { makeToken } from '../reference/token.js';
import { initialDraftDocuments } from './draft.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'handle', label: 'Handle', stable_id: 'handleValue', pii: [{ property: 'handleValue', class: 'text' }] },
        { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
        { type: 'named', label: 'Named', stable_id: 'spelledForm', pii: [{ property: 'spelledForm', class: 'name' }] },
      ],
      relationships: [{ type: 'LINKS', from: 'widget', to: 'handle' }],
    }),
  ),
  'neburyx.yaml',
);
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function started() {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    const stableId = call.parameters['stableId'];
    if (call.cypher.includes('`Named`')) return Promise.resolve(entityRows(plainNode(['Named'], { spelledForm: stableId })));
    return Promise.resolve(call.cypher.includes('`Handle`') ? entityRows(plainNode(['Handle'], { handleValue: stableId })) : entityRows(plainNode(['Widget'], { widgetId: stableId })));
  };
  const executor = new TestExecutor(withOnlineIndexes(demo, answer));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
  const open = (entity: object, caseRef: string) => app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef, entity: { sourceId: 'demo', ...entity } } });
  return { database, app, open };
}

describe('an investigation that starts at a long reference, on PostgreSQL', () => {
  it.each([
    ['a value of a keyed type of 100 characters (a token of 291)', { entityType: 'handle', value: 'h'.repeat(100) }],
    ['a value of a keyed type of the largest size (a token of 266,691)', { entityType: 'handle', value: 'h'.repeat(MAX_REFERENCE_VALUE_CHARACTERS) }],
    ['an ID of a type that is not keyed of 500 characters', { entityType: 'widget', value: 'w'.repeat(500) }],
    ['an ID of a type that is not keyed of 3,000 characters', { entityType: 'widget', value: 'w'.repeat(3000) }],
  ])('is created, found again by its case reference, listed and read for %s', async (_name, entity) => {
    const { database, app, open } = await started();
    const first = await open(entity, 'CASE-LONG');
    expect(first.statusCode).toBe(201);
    const created = openInvestigationResponseSchema.parse(first.json());
    const second = await open(entity, 'CASE-LONG');
    expect(second.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(second.json()).investigation.id).toBe(created.investigation.id);
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n'])).toBe(1);
    const read = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` })).json());
    expect(read.investigation.startingEntity?.stableId).toBe(created.investigation.startingEntity?.stableId);
    expect((await app.inject({ method: 'GET', url: '/v1/investigations' })).statusCode).toBe(200);
    if (entity.entityType === 'handle') expect(JSON.stringify([created.investigation, read])).not.toContain(entity.value.slice(0, 50));
    await app.close();
  });

  it.each([['a NUL', 'a\u0000b'], ['an unpaired surrogate', 'a\ud800b']])('is created and found again by its case reference for a value of a keyed type with %s, which only its token carries', async (_name, value) => {
    const { database, app, open } = await started();
    const first = await open({ entityType: 'handle', value }, 'CASE-NUL');
    expect(first.statusCode).toBe(201);
    const second = await open({ entityType: 'handle', value }, 'CASE-NUL');
    expect(second.statusCode).toBe(200);
    expect(second.json().investigation.id).toBe(first.json().investigation.id);
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n'])).toBe(1);
    expect(String((await rows(database.ownerUrl, 'SELECT starting_stable_id AS id FROM investigations'))[0]?.['id'])).toMatch(/^p1\./);
    await app.close();
  });

  it('is created for a keyed value of a name class that starts with a NUL, whose masked display title keeps that character, with the title made storable', async () => {
    const { database, app, open } = await started();
    const first = await open({ entityType: 'named', value: '\u0000Ann Lee' }, 'CASE-NAME');
    expect(first.statusCode).toBe(201);
    const second = await open({ entityType: 'named', value: '\u0000Ann Lee' }, 'CASE-NAME');
    expect(second.statusCode).toBe(200);
    const stored = String((await rows(database.ownerUrl, 'SELECT title FROM investigations'))[0]?.['title']);
    expect(stored).not.toContain('\u0000');
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n'])).toBe(1);
    await app.close();
  });

  it.each([
    ['a NUL', 'a\u0000b'],
    ['an unpaired high surrogate', 'a\ud800b'],
    ['an unpaired low surrogate', 'a\udc00b'],
    ['text that starts like the stored marker', '~e1:abc'],
    ['a very long value with a NUL in it', `${'w'.repeat(49_999)}\u0000${'v'.repeat(49_999)}`],
  ])('keeps an ID of a type that is not keyed with %s exact through look up, open, reuse, list and read', async (_name, value) => {
    const { database, app, open } = await started();
    const lookup = await app.inject({ method: 'POST', url: '/v1/entities/lookup', payload: { sourceId: 'demo', value: { entityType: 'widget', value } } });
    expect(lookup.statusCode).toBe(200);
    const first = await open({ entityType: 'widget', value }, 'CASE-ODD');
    expect(first.statusCode).toBe(201);
    const second = await open({ entityType: 'widget', value }, 'CASE-ODD');
    expect(second.statusCode).toBe(200);
    expect(second.json().investigation.id).toBe(first.json().investigation.id);
    expect(first.json().investigation.startingEntity.stableId).toBe(value);
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n'])).toBe(1);
    const read = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: `/v1/investigations/${first.json().investigation.id}` })).json());
    expect(read.investigation.startingEntity?.stableId).toBe(value);
    expect(read.draft.layout.nodes[0]?.id).toBe(value);
    expect((await app.inject({ method: 'GET', url: '/v1/investigations' })).statusCode).toBe(200);
    await app.close();
  });

  it('stores an ID of the largest size, 100,000 code units with a NUL in it, and refuses one unit more with the error of any oversized value', async () => {
    const { app, open } = await started();
    const value = `${'x'.repeat(99_999)}\u0000`;
    const created = await open({ entityType: 'widget', value }, 'CASE-MAX');
    expect(created.statusCode).toBe(201);
    expect(created.json().investigation.startingEntity.stableId).toBe(value);
    expect((await open({ entityType: 'widget', value: `${value}x` }, 'CASE-OVER')).statusCode).toBe(400);
    await app.close();
  });

  it('finds an investigation stored with an ID PostgreSQL cannot hold, while the type was not keyed, once the type is keyed', async () => {
    const { database, app, open } = await started();
    await app.close();
    const unkeyed = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'handle', label: 'Handle', stable_id: 'handleValue' }, { type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'handle' }] })), 'neburyx.yaml');
    const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
    let closing: Promise<void> | undefined;
    const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
    stores.push(store);
    const executor = new TestExecutor(withOnlineIndexes(unkeyed.sources[0] ?? demo, (call) => Promise.resolve(entityRows(plainNode(['Handle'], { handleValue: call.parameters['stableId'] })))));
    const before = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: unkeyed, gate: testSourceGate(unkeyed, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const value = 'a\u0000b';
    const payload = { sourceId: 'demo', caseRef: 'CASE-SWITCH', entity: { sourceId: 'demo', entityType: 'handle', value } };
    const first = await before.inject({ method: 'POST', url: '/v1/investigations', payload });
    expect(first.statusCode).toBe(201);
    const keyedExecutor = new TestExecutor(withOnlineIndexes(demo, (call) => Promise.resolve(entityRows(plainNode(['Handle'], { handleValue: call.parameters['stableId'] })))));
    const keyedNow = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: { ...store, close: async () => undefined }, mapping, gate: testSourceGate(mapping, { executor: keyedExecutor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const second = await keyedNow.inject({ method: 'POST', url: '/v1/investigations', payload });
    expect(second.statusCode).toBe(200);
    expect(second.json().investigation.id).toBe(first.json().investigation.id);
    expect(Number((await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM investigations'))[0]?.['n'])).toBe(1);
    await before.close();
  });

  it('answers 400, not 500, for a NUL in the case reference or the entity type', async () => {
    const { app, open } = await started();
    expect((await open({ entityType: 'widget', value: 'w' }, 'C\u0000')).statusCode).toBe(400);
    expect((await open({ entityType: 'wid\u0000get', value: 'w' }, 'C')).statusCode).toBe(400);
    await app.close();
  });

  it('opens a node of a type that was keyed and no longer is, from an investigation stored under its token', async () => {
    const database = await postgres.newDatabase();
    expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
    const unkeyed = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'handle', label: 'Handle', stable_id: 'handleValue' }, { type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'handle' }] })), 'neburyx.yaml');
    const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
    let closing: Promise<void> | undefined;
    const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
    stores.push(store);
    await store.initialize();
    await store.syncSources(unkeyed.sources);
    const executor = new TestExecutor(withOnlineIndexes(unkeyed.sources[0] ?? demo, (call) => Promise.resolve(entityRows(plainNode(['Handle'], { handleValue: call.parameters['stableId'] })))));
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: unkeyed, gate: testSourceGate(unkeyed, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'handle' }, 'h-1');
    const principal = (await store.current()).principal.id;
    const id = '0192f000-0000-7000-8000-0000000000d1';
    const [first] = unkeyed.sources;
    await rows(database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title, case_ref, starting_entity_type, starting_stable_id) VALUES ('${id}', 'demo', '${identityHashOf(first ?? demo)}', '${principal}', 'Handle', 'CASE-K', 'handle', '${token}')`);
    const initial = initialDraftDocuments({ entityType: 'handle', stableId: token });
    await rows(database.ownerUrl, `INSERT INTO saved_views (id, investigation_id, kind, layout, query_context, mapping_hash, content_hash, counts_policy_version, created_by) VALUES ('0192f000-0000-7000-8000-0000000000d2', '${id}', 'draft', '${JSON.stringify(initial.layout)}', '${JSON.stringify(initial.queryContext)}', 'h', 'c', 'v1', '${principal}')`);
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(read.json().investigation.startingEntity.stableId).toBe('h-1');
    expect(read.json().draft.layout.nodes[0].id).toBe('h-1');
    expect((await app.inject({ method: 'GET', url: '/v1/entities/demo/handle/h-1' })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: 'CASE-K', entity: { sourceId: 'demo', entityType: 'handle', value: 'h-1' } } });
    expect(again.statusCode).toBe(200);
    expect(again.json().investigation.id).toBe(id);
    await app.close();
  });
});
