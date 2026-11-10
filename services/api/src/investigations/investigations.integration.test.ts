import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investigationResponseSchema, layoutDocumentSchema, openInvestigationResponseSchema, queryContextDocumentSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { uuidv7 } from '../identity/uuid.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { TestExecutor } from '../testing/gate.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'gizmo' }] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const INITIAL_CONTENT_HASH = 'a5de85ae95f682f027744f9592c68417fd631c2706bad57870b404a5ddafc1b2';
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });

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

function openStore(database: TestDatabase): AppStore {
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  return store;
}

async function appOn(database: TestDatabase, appMapping = mapping, answer: ExecuteOutcome | (() => Promise<ExecuteOutcome>) = entityRows(WIDGET), wrap: (store: AppStore) => AppStore = (store) => store) {
  const store = wrap(openStore(database));
  const data = typeof answer === 'function' ? answer : () => Promise.resolve(answer);
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), data));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { executor }).gate });
  return { app, store, executor };
}

async function running(answer: ExecuteOutcome | (() => Promise<ExecuteOutcome>) = entityRows(WIDGET)) {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const first = await appOn(database, mapping, answer);
  await first.store.initialize();
  await first.store.syncSources(mapping.sources);
  const post = (payload: object) => first.app.inject({ method: 'POST', url: '/v1/investigations', payload });
  return { database, ...first, post };
}

const body = (overrides: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, ...overrides });
const count = async (database: TestDatabase, table: 'investigations' | 'saved_views') => Number((await rows(database.ownerUrl, `SELECT count(*)::int AS n FROM ${table}`))[0]?.['n']);

function asUser(store: AppStore, id: string): AppStore {
  return { ...store, current: async () => ({ ...(await store.current()), principal: { ...(await store.current()).principal, id } }) };
}

async function secondUser(database: TestDatabase): Promise<string> {
  const id = uuidv7();
  await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [id]);
  return id;
}

describe('opening an investigation against Postgres', () => {
  it('stores the investigation and its draft as the data model says', async () => {
    const { database, app, post } = await running();
    const response = await post(body());
    expect(response.statusCode).toBe(201);
    const answer = openInvestigationResponseSchema.parse(response.json());
    const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
    const [row] = await rows(database.ownerUrl, 'SELECT * FROM investigations');
    expect(row).toMatchObject({ id: answer.investigation.id, source_id: 'demo', source_identity_hash: identityHashOf(demo), owner_id: owner?.['id'], title: 'Widget W-1', case_ref: null, starting_entity_type: 'widget', starting_stable_id: 'W-1', status: 'open', version: 1, deleted_at: null });
    expect(String(row?.['id'])[14]).toBe('7');
    const [draft] = await rows(database.ownerUrl, 'SELECT * FROM saved_views');
    expect(draft).toMatchObject({ investigation_id: answer.investigation.id, kind: 'draft', name: null, mapping_hash: demo.configHash, content_hash: INITIAL_CONTENT_HASH, node_count: 1, edge_count: 0, counts_policy_version: 'none', created_by: owner?.['id'], based_on_view_id: null, version: 1 });
    expect(String(draft?.['id'])[14]).toBe('7');
    expect(layoutDocumentSchema.parse(draft?.['layout'])).toEqual(initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }).layout);
    expect(queryContextDocumentSchema.parse(draft?.['query_context'])).toEqual(initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }).queryContext);
    await app.close();
  });

  it('leaves neither an investigation nor a draft when the draft cannot be written, and leaves the rows that exist as they were', async () => {
    const { database, store, app, post } = await running();
    await post(body());
    const before = JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM investigations'));
    const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
    const draft = { id: uuidv7(), ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-9' }), mappingHash: 'h', contentHash: 'c', nodeCount: 1, edgeCount: -1, countsPolicyVersion: 'none' };
    const failure = await store.createInvestigation({ id: uuidv7(), sourceId: 'demo', sourceIdentityHash: 'i', ownerId: String(owner?.['id']), title: 'T', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-9', draft }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(await count(database, 'investigations')).toBe(1);
    expect(await count(database, 'saved_views')).toBe(1);
    expect(JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM investigations'))).toBe(before);
    await app.close();
  });

  it('refuses a draft whose documents do not fit their schemas, and leaves no investigation and no draft', async () => {
    const { database, store, app } = await running();
    const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
    const valid = { id: uuidv7(), ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-9' }), mappingHash: 'h', contentHash: 'c', nodeCount: 1, edgeCount: 0, countsPolicyVersion: 'none' };
    for (const overrides of [{ layout: { schemaVersion: 2 } }, { layout: {} }, { queryContext: { ...valid.queryContext, loaded: 'all' } }]) {
      const draft = JSON.parse(JSON.stringify({ ...valid, ...overrides }));
      await expect(store.createInvestigation({ id: uuidv7(), sourceId: 'demo', sourceIdentityHash: 'i', ownerId: String(owner?.['id']), title: 'T', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-9', draft })).rejects.toThrow();
    }
    expect(await count(database, 'investigations')).toBe(0);
    expect(await count(database, 'saved_views')).toBe(0);
    await app.close();
  });

  it('writes nothing when the entity is not in the source', async () => {
    const { database, app, post } = await running(entityRows());
    expect((await post(body())).statusCode).toBe(404);
    expect(await count(database, 'investigations')).toBe(0);
    expect(await count(database, 'saved_views')).toBe(0);
    await app.close();
  });

  it('refuses a source the database does not know, as a foreign key', async () => {
    const { database } = await running();
    expect(await attempt(database.appUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) VALUES ('${uuidv7()}', 'nowhere', 'i', (SELECT id FROM users LIMIT 1), 'T')`)).toMatch(/investigations_source_id_fkey/);
  });
});

describe('resuming by case reference against Postgres', () => {
  it('returns the caller’s own open investigation, and a new one when it is closed or deleted', async () => {
    const { database, app, post } = await running();
    const first = openInvestigationResponseSchema.parse((await post(body({ caseRef: 'CASE-1' }))).json());
    const again = await post(body({ caseRef: 'CASE-1' }));
    expect(again.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(again.json()).investigation.id).toBe(first.investigation.id);
    expect(await count(database, 'investigations')).toBe(1);
    await rows(database.ownerUrl, `UPDATE investigations SET status = 'closed'`);
    expect((await post(body({ caseRef: 'CASE-1' }))).statusCode).toBe(201);
    await rows(database.ownerUrl, `UPDATE investigations SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE status = 'open'`);
    expect((await post(body({ caseRef: 'CASE-1' }))).statusCode).toBe(201);
    expect(await count(database, 'investigations')).toBe(3);
    await app.close();
  });

  it('gives each of two users their own investigation when each calls, and neither reads the other’s', async () => {
    const { database, app, post } = await running();
    const other = await secondUser(database);
    const second = await appOn(database, mapping, entityRows(WIDGET), (store) => asUser(store, other));
    const postAsOther = (payload: object) => second.app.inject({ method: 'POST', url: '/v1/investigations', payload });
    const mine = openInvestigationResponseSchema.parse((await post(body({ caseRef: 'CASE-1' }))).json());
    const theirs = openInvestigationResponseSchema.parse((await postAsOther(body({ caseRef: 'CASE-1' }))).json());
    expect(theirs.investigation.id).not.toBe(mine.investigation.id);
    expect(await count(database, 'investigations')).toBe(2);
    const again = await post(body({ caseRef: 'CASE-1' }));
    const theirsAgain = await postAsOther(body({ caseRef: 'CASE-1' }));
    expect([again.statusCode, theirsAgain.statusCode]).toEqual([200, 200]);
    expect(openInvestigationResponseSchema.parse(again.json()).investigation.id).toBe(mine.investigation.id);
    expect(openInvestigationResponseSchema.parse(theirsAgain.json()).investigation.id).toBe(theirs.investigation.id);
    expect(await count(database, 'investigations')).toBe(2);
    expect(await count(database, 'saved_views')).toBe(2);
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${theirs.investigation.id}` })).statusCode).toBe(404);
    expect((await second.app.inject({ method: 'GET', url: `/v1/investigations/${mine.investigation.id}` })).statusCode).toBe(404);
    expect((await second.app.inject({ method: 'GET', url: `/v1/investigations/${theirs.investigation.id}` })).statusCode).toBe(200);
    await app.close();
    await second.app.close();
  });

  it('makes one investigation when two calls with the same case reference are made at once, both having found none to reuse', async () => {
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const { database, app, post } = await running(async () => {
      arrivals += 1;
      if (arrivals >= 2) release();
      await bothRead;
      return entityRows(WIDGET);
    });
    const answers = await Promise.all([post(body({ caseRef: 'CASE-1' })), post(body({ caseRef: 'CASE-1' }))]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 201]);
    const ids = answers.map((answer) => openInvestigationResponseSchema.parse(answer.json()).investigation.id);
    expect(ids[0]).toBe(ids[1]);
    expect(answers.map((answer) => openInvestigationResponseSchema.parse(answer.json())).every((answer) => 'entity' in answer)).toBe(true);
    expect(await count(database, 'investigations')).toBe(1);
    expect(await count(database, 'saved_views')).toBe(1);
    await app.close();
  });

  it('makes one investigation for each call at once when there is no case reference', async () => {
    const { database, app, post } = await running();
    const answers = await Promise.all([post(body()), post(body())]);
    expect(answers.map((answer) => answer.statusCode)).toEqual([201, 201]);
    expect(await count(database, 'investigations')).toBe(2);
    await app.close();
  });

  it('answers a repointed investigation also when the mapping that replaced its source no longer has the entity type it started with', async () => {
    const { database, app, post } = await running();
    await post(body({ caseRef: 'CASE-1' }));
    await rows(database.ownerUrl, `UPDATE investigations SET source_identity_hash = 'another-database'`);
    const replaced = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'gadget', to: 'gizmo' }] })), 'neburyx.yaml');
    const onReplaced = await appOn(database, replaced);
    const response = await onReplaced.app.inject({ method: 'POST', url: '/v1/investigations', payload: body({ caseRef: 'CASE-1' }) });
    expect(response.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ created: false, investigation: { sourceState: 'repointed' } });
    expect(onReplaced.executor.calls).toEqual([]);
    expect(await count(database, 'investigations')).toBe(1);
    await app.close();
  });

  it('makes no source read and creates nothing for an investigation whose stored source identity differs', async () => {
    const { database, app, post, executor } = await running();
    await post(body({ caseRef: 'CASE-1' }));
    const reads = executor.calls.length;
    await rows(database.ownerUrl, `UPDATE investigations SET source_identity_hash = 'another-database'`);
    const response = await post(body({ caseRef: 'CASE-1' }));
    expect(response.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ created: false, investigation: { sourceState: 'repointed' } });
    expect(executor.calls.length).toBe(reads);
    expect(await count(database, 'investigations')).toBe(1);
    await app.close();
  });
});

describe('reading an investigation against Postgres', () => {
  it('answers the caller’s investigation and draft, and the same NOT_FOUND for a deleted one, another user’s and a missing one', async () => {
    const { database, app, post } = await running();
    const created = openInvestigationResponseSchema.parse((await post(body())).json());
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.headers['etag']).toBe('"1"');
    expect(investigationResponseSchema.parse(read.json())).toMatchObject({ investigation: { id: created.investigation.id, sourceState: 'available', version: 1 }, draft: { version: 1 } });
    const missing = await app.inject({ method: 'GET', url: `/v1/investigations/${uuidv7()}` });
    await rows(database.ownerUrl, `UPDATE investigations SET deleted_at = now()`);
    const deleted = await app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` });
    await rows(database.ownerUrl, `UPDATE investigations SET deleted_at = NULL, owner_id = $1`, [await secondUser(database)]);
    const foreign = await app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` });
    for (const response of [missing, deleted, foreign]) expect(response.statusCode).toBe(404);
    expect({ ...deleted.json().error, traceId: undefined }).toEqual({ ...missing.json().error, traceId: undefined });
    expect({ ...foreign.json().error, traceId: undefined }).toEqual({ ...missing.json().error, traceId: undefined });
    await app.close();
  });

  it('lists the items the mapping no longer covers and names the dropped filters, with no error and no source read', async () => {
    const { database, app, post, executor } = await running();
    const opened = openInvestigationResponseSchema.parse((await post(body())).json());
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    const filters = { entityTypes: ['widget', 'removed-type'], relTypes: [], time: null, properties: [{ key: 'removedProperty', op: 'eq', values: ['x'] }] };
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/investigations/${opened.investigation.id}/draft`,
      headers: { 'if-match': '"1"' },
      payload: { notes: null, layout: { ...documents.layout, nodes: [...documents.layout.nodes, { t: 'removed-type', id: 'X', pinned: false, hidden: false, groupId: null }] }, queryContext: { ...documents.queryContext, loaded: { ...documents.queryContext.loaded, nodes: [...documents.queryContext.loaded.nodes, { t: 'removed-type', id: 'X' }] }, filters } },
    });
    expect(put.statusCode).toBe(200);
    await rows(database.ownerUrl, `UPDATE saved_views SET mapping_hash = 'the-mapping-that-was'`);
    const calls = executor.calls.length;
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${opened.investigation.id}` });
    expect(read.statusCode).toBe(200);
    const answer = investigationResponseSchema.parse(read.json());
    expect(answer.unmapped).toEqual({ nodes: [{ t: 'removed-type', id: 'X' }], edges: [] });
    expect(answer.mappingChange?.droppedFilters).toEqual([{ name: 'removedProperty', reason: 'property-removed' }]);
    expect(answer.draft.queryContext.filters).toEqual({ entityTypes: ['widget', 'removed-type'], relTypes: [], time: null, properties: [] });
    expect(executor.calls.length).toBe(calls);
    await app.close();
  });

  it('reports a source that is no longer configured as removed and one that points elsewhere as repointed, and reads no source', async () => {
    const parts = await running();
    const created = openInvestigationResponseSchema.parse((await parts.post(body())).json());
    const otherMapping = parseMapping(fileOf(baseSource({ id: 'elsewhere' })), 'neburyx.yaml');
    const withoutSource = await appOn(parts.database, otherMapping);
    const removed = investigationResponseSchema.parse((await withoutSource.app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` })).json());
    expect(removed.investigation.sourceState).toBe('removed');
    expect(withoutSource.executor.calls).toEqual([]);
    await rows(parts.database.ownerUrl, `UPDATE investigations SET source_identity_hash = 'another-database'`);
    const pointedElsewhere = await appOn(parts.database);
    const repointed = investigationResponseSchema.parse((await pointedElsewhere.app.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` })).json());
    expect(repointed.investigation.sourceState).toBe('repointed');
    expect(pointedElsewhere.executor.calls).toEqual([]);
  });
});

describe('saving the draft against Postgres', () => {
  const node = (t: string, id: string) => ({ t, id, pinned: false, hidden: false, groupId: null });
  const edge = { t: 'LINKS', from: { t: 'widget', id: 'W-1' }, to: { t: 'gizmo', id: 'GZ-1' }, id: 'LK-1' };
  const changed = (extraId = 'GZ-1', notes: string | null = null) => ({
    notes,
    layout: { schemaVersion: 1, layout: 'force', nodes: [node('widget', 'W-1'), node('gizmo', extraId)], edges: [{ ...edge, hidden: false }], groups: [] },
    queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'widget', id: 'W-1' }, { t: 'gizmo', id: extraId }], edges: [edge] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  });

  async function opened() {
    const run = await running();
    const answer = openInvestigationResponseSchema.parse((await run.post(body())).json());
    const put = (payload: unknown, version: number | string = answer.draft.version) => run.app.inject({ method: 'PUT', url: `/v1/investigations/${answer.investigation.id}/draft`, headers: { 'if-match': `"${version}"` }, payload: payload as object });
    return { ...run, answer, put };
  }

  it('hands the first write the version of the draft it made, and the version of the draft it found when an investigation is reused', async () => {
    const { database, app, post } = await running();
    const first = openInvestigationResponseSchema.parse((await post(body({ caseRef: 'CASE-1' }))).json());
    expect(first.draft).toEqual({ version: 1 });
    const put = await app.inject({ method: 'PUT', url: `/v1/investigations/${first.investigation.id}/draft`, headers: { 'if-match': '"1"' }, payload: changed() });
    expect(put.statusCode).toBe(200);
    const again = openInvestigationResponseSchema.parse((await post(body({ caseRef: 'CASE-1' }))).json());
    expect(again.created).toBe(false);
    expect(again.draft).toEqual({ version: 2 });
    expect(await count(database, 'saved_views')).toBe(1);
    await app.close();
  });

  it('replaces the documents, raises the version, moves last_edited_at, and updates the counts, the mapping hash and the content hash', async () => {
    const { database, app, put } = await opened();
    const [before] = await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at FROM investigations i JOIN saved_views v ON v.investigation_id = i.id');
    const response = await put(changed());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 2, save: { state: 'unsaved', savedAt: null }, notes: null });
    const [draft] = await rows(database.ownerUrl, 'SELECT * FROM saved_views');
    const documents = { layout: layoutDocumentSchema.parse(draft?.['layout']), queryContext: queryContextDocumentSchema.parse(draft?.['query_context']) };
    expect(draft).toMatchObject({ version: 2, node_count: 2, edge_count: 1, mapping_hash: demo.configHash, content_hash: contentHashOf(documents) });
    expect(documents.layout.edges[0]).toMatchObject({ from: { t: 'widget', id: 'W-1' }, to: { t: 'gizmo', id: 'GZ-1' }, id: 'LK-1' });
    const [after] = await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at FROM investigations i JOIN saved_views v ON v.investigation_id = i.id');
    expect((after?.['last_edited_at'] as Date).getTime()).toBeGreaterThan((before?.['last_edited_at'] as Date).getTime());
    expect((after?.['updated_at'] as Date).getTime()).toBeGreaterThan((before?.['updated_at'] as Date).getTime());
    await app.close();
  });

  it('writes nothing when the content is the one stored: version, updated_at and last_edited_at stay', async () => {
    const { database, app, put } = await opened();
    const before = JSON.stringify(await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at, v.version FROM investigations i JOIN saved_views v ON v.investigation_id = i.id'));
    const response = await put({ ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 1 });
    expect(JSON.stringify(await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at, v.version FROM investigations i JOIN saved_views v ON v.investigation_id = i.id'))).toBe(before);
    await app.close();
  });

  it('stores the draft under the current mapping when the content is the one stored: the version and updated_at move, last_edited_at does not', async () => {
    const { database, app, put, answer } = await opened();
    await rows(database.ownerUrl, `UPDATE saved_views SET mapping_hash = 'the-mapping-that-was'`);
    const [before] = await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at FROM investigations i JOIN saved_views v ON v.investigation_id = i.id');
    const response = await put({ ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: null });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    const [after] = await rows(database.ownerUrl, 'SELECT i.last_edited_at, v.updated_at, v.version, v.mapping_hash FROM investigations i JOIN saved_views v ON v.investigation_id = i.id');
    expect(after).toMatchObject({ version: 2, mapping_hash: demo.configHash });
    expect((after?.['last_edited_at'] as Date).getTime()).toBe((before?.['last_edited_at'] as Date).getTime());
    expect((after?.['updated_at'] as Date).getTime()).toBeGreaterThan((before?.['updated_at'] as Date).getTime());
    const read = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: `/v1/investigations/${answer.investigation.id}` })).json());
    expect(read.mappingChange).toBeUndefined();
    await app.close();
  });

  it('refuses a stale version and leaves the stored mapping hash as it was', async () => {
    const { database, app, put } = await opened();
    await rows(database.ownerUrl, `UPDATE saved_views SET mapping_hash = 'the-mapping-that-was'`);
    expect((await put({ ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: null }, 9)).statusCode).toBe(409);
    expect(await rows(database.ownerUrl, 'SELECT mapping_hash FROM saved_views')).toEqual([{ mapping_hash: 'the-mapping-that-was' }]);
    await app.close();
  });

  it('stores the note with the documents, hashes it with them, and reads it back on the draft', async () => {
    const { database, app, put, answer } = await opened();
    expect((await put(changed('GZ-1', 'a note'))).statusCode).toBe(200);
    const [draft] = await rows(database.ownerUrl, 'SELECT * FROM saved_views');
    const documents = { layout: layoutDocumentSchema.parse(draft?.['layout']), queryContext: queryContextDocumentSchema.parse(draft?.['query_context']) };
    expect(draft).toMatchObject({ notes: 'a note', content_hash: contentHashOf(documents, 'a note', null) });
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${answer.investigation.id}` });
    expect(investigationResponseSchema.parse(read.json()).draft.notes).toBe('a note');
    await app.close();
  });

  it('stores an ID PostgreSQL cannot hold in its encoded form and answers it back as it was sent', async () => {
    const { database, app, put, answer } = await opened();
    expect((await put(changed('GZ\u0000-1'))).statusCode).toBe(200);
    const [draft] = await rows(database.ownerUrl, 'SELECT layout FROM saved_views');
    expect(JSON.stringify(draft?.['layout'])).toContain('~e1:');
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${answer.investigation.id}` });
    expect(investigationResponseSchema.parse(read.json()).draft.layout.nodes[1]?.id).toBe('GZ\u0000-1');
    await app.close();
  });

  it('lets one of two writes with the same version win and refuses the other with CONFLICTED_VIEW_VERSION, leaving the winner stored', async () => {
    const { database, app, put } = await opened();
    const [first, second] = await Promise.all([put(changed('GZ-1')), put(changed('GZ-2'))]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json()).toMatchObject({ error: { code: 'CONFLICTED_VIEW_VERSION' } });
    const [draft] = await rows(database.ownerUrl, 'SELECT version, layout FROM saved_views');
    expect(draft?.['version']).toBe(2);
    expect(JSON.stringify(draft?.['layout'])).toContain(first.statusCode === 200 ? 'GZ-1' : 'GZ-2');
    await app.close();
  });
});
