import { rmSync } from 'node:fs';
import { layoutDocumentSchema, openInvestigationResponseSchema, queryContextDocumentSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { memoryAppStore, memoryStoreWith, LOCAL_IDENTITY, type MemoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import type { NewDraft } from '../db/investigations-repository.js';
import { uuidv7 } from '../identity/uuid.js';
import { contentHashOf, defaultTitle, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', display: { name: 'Widget record' } },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', title: '{gadgetName}', pii: [{ property: 'gadgetName', class: 'name' }] },
      ],
      relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }],
    }),
  ),
  'neburyx.yaml',
);
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const body = (overrides: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, ...overrides });

async function started(answer: ExecuteOutcome = entityRows(WIDGET), store: MemoryAppStore = memoryAppStore()) {
  const executor = new TestExecutor(() => Promise.resolve(answer));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
  const post = (payload: object, url = '/v1/investigations') => app.inject({ method: 'POST', url, payload });
  return { app, store, executor, post };
}

describe('POST /v1/investigations', () => {
  it('creates an open investigation owned by the caller, fixed to the request’s source, with its draft and the entity', async () => {
    const { app, store, post } = await started();
    const response = await post(body());
    expect(response.statusCode).toBe(201);
    expect(response.headers['etag']).toBe('"1"');
    const answer = openInvestigationResponseSchema.parse(response.json());
    expect(answer.created).toBe(true);
    expect(answer.investigation).toMatchObject({ sourceId: 'demo', caseRef: null, status: 'open', startingEntity: { entityType: 'widget', stableId: 'W-1' }, sourceState: 'available', version: 1 });
    expect(answer).toMatchObject({ entity: { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } } });
    const [row] = store.investigations;
    expect(row).toMatchObject({ id: answer.investigation.id, ownerId: LOCAL_IDENTITY.principal.id, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), status: 'open' });
    expect(row?.id[14]).toBe('7');
    await app.close();
  });

  it('writes one draft that holds the starting entity and no relationship, in the documents of the data model', async () => {
    const { app, store, post } = await started();
    await post(body());
    expect(store.drafts).toHaveLength(1);
    const [draft] = store.drafts;
    const layout = layoutDocumentSchema.parse(draft?.layout);
    const context = queryContextDocumentSchema.parse(draft?.queryContext);
    expect(layout).toMatchObject({ schemaVersion: 1, nodes: [{ t: 'widget', id: 'W-1', pinned: false, hidden: false, groupId: null }], edges: [], groups: [] });
    expect(context).toMatchObject({ schemaVersion: 1, loaded: { nodes: [{ t: 'widget', id: 'W-1' }], edges: [] }, expansions: [] });
    await app.close();
  });

  it('titles it with the display name of the type and the stable ID, and never from a personal-data value, also when masking is asked', async () => {
    const gadget = plainNode(['Gadget'], { gadgetId: 'H-1', gadgetName: 'Ana Silva' });
    const { app, store, post } = await started(entityRows(gadget));
    const response = await post({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'gadget', stableId: 'H-1' }, mask: true });
    expect(response.statusCode).toBe(201);
    expect(store.investigations[0]?.title).toBe('Gadget H-1');
    expect(JSON.stringify(store)).not.toContain('Ana Silva');
    const answer = openInvestigationResponseSchema.parse(response.json());
    expect(JSON.stringify(answer)).not.toContain('Ana Silva');
    await app.close();
    const other = await started();
    expect(openInvestigationResponseSchema.parse((await other.post(body())).json()).investigation.title).toBe('Widget record W-1');
    await other.app.close();
  });

  it('stores and answers the real stable ID of an entity made only of dots', async () => {
    const dots = plainNode(['Widget'], { widgetId: '..' });
    const { app, store, post } = await started(entityRows(dots));
    const response = await post(body({ entity: { sourceId: 'demo', entityType: 'widget', stableId: '..' } }));
    expect(response.statusCode).toBe(201);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ investigation: { startingEntity: { entityType: 'widget', stableId: '..' } }, entity: { ref: { stableId: '..' } } });
    expect(store.investigations[0]).toMatchObject({ startingStableId: '..' });
    await app.close();
  });

  it('makes two investigations when the same entity is opened twice without a case reference', async () => {
    const { app, store, post } = await started();
    await post(body());
    await post(body());
    expect(store.investigations).toHaveLength(2);
    expect(store.drafts).toHaveLength(2);
    await app.close();
  });

  const failures: readonly (readonly [string, ExecuteOutcome, number, string])[] = [
    ['an entity the source does not hold', entityRows(), 404, 'NOT_FOUND'],
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' }, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that times out', { status: 'timeout' }, 504, 'QUERY_TIMEOUT'],
  ];

  it.each(failures)('writes nothing for %s', async (_name, answer, status, code) => {
    const { app, store, post } = await started(answer);
    const response = await post(body());
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(store.investigations).toEqual([]);
    expect(store.drafts).toEqual([]);
    await app.close();
  });

  it('leaves the rows that exist untouched when a later open fails', async () => {
    let answer: ExecuteOutcome = entityRows(WIDGET);
    const executor = new TestExecutor(() => Promise.resolve(answer));
    const store = memoryAppStore();
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
    await app.inject({ method: 'POST', url: '/v1/investigations', payload: body() });
    const before = JSON.stringify([store.investigations, store.drafts]);
    answer = { status: 'timeout' };
    expect((await app.inject({ method: 'POST', url: '/v1/investigations', payload: body() })).statusCode).toBe(504);
    expect(JSON.stringify([store.investigations, store.drafts])).toBe(before);
    await app.close();
  });

  it('answers INTERNAL_ERROR and leaves no investigation when the store cannot write', async () => {
    const { app, store, post } = await started(entityRows(WIDGET), memoryStoreWith({ failInvestigations: true }));
    const response = await post(body());
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(store.investigations).toEqual([]);
    await app.close();
  });

  it('refuses an entity that names another source than the request, before any read or write', async () => {
    const { app, store, executor, post } = await started();
    const response = await post(body({ entity: { sourceId: 'other', entityType: 'widget', stableId: 'W-1' } }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SOURCE_MISMATCH');
    expect(entityCalls(executor.calls)).toEqual([]);
    expect(store.investigations).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured, and INVALID_REQUEST for a type the mapping does not name, without reading', async () => {
    const { app, executor, post } = await started();
    const unknown = await post({ sourceId: 'nope', entity: { sourceId: 'nope', entityType: 'widget', stableId: 'W-1' } });
    expect(unknown.statusCode).toBe(404);
    const unmapped = await post(body({ entity: { sourceId: 'demo', entityType: 'sprocket', stableId: 'S-1' } }));
    expect(unmapped.statusCode).toBe(400);
    expect(unmapped.json().error.code).toBe('INVALID_REQUEST');
    expect(entityCalls(executor.calls)).toEqual([]);
    await app.close();
  });

  it.each([
    ['an empty case reference', { caseRef: '' }],
    ['a case reference of 101 characters', { caseRef: 'r'.repeat(101) }],
    ['a title field', { title: 'Mine' }],
    ['an unknown field', { extra: 1 }],
    ['a mask that is not a boolean', { mask: 'yes' }],
    ['a stable ID of 0 characters', { entity: { sourceId: 'demo', entityType: 'widget', stableId: '' } }],
  ])('answers INVALID_REQUEST for %s and writes nothing', async (_name, overrides) => {
    const { app, store, executor, post } = await started();
    const response = await post(body(overrides));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(store.investigations).toEqual([]);
    expect(entityCalls(executor.calls)).toEqual([]);
    await app.close();
  });

  it('takes a case reference of 100 characters, counted as characters', async () => {
    const { app, post } = await started();
    expect((await post(body({ caseRef: 'é'.repeat(100) }))).statusCode).toBe(201);
    await app.close();
  });

  it('answers INVALID_REQUEST for a query parameter and for a body that is not JSON, and 415 for another media type', async () => {
    const { app, post } = await started();
    expect((await post(body(), '/v1/investigations?x=1')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/investigations', headers: { 'content-type': 'application/json' }, payload: '{"sourceId":' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/investigations', headers: { 'content-type': 'application/x-unsupported' }, payload: 'x' })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/v1/investigations', headers: { 'content-type': 'text/plain' }, payload: 'x' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/investigations' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('the draft documents and the title', () => {
  it('hash the layout, the query context, the notes and the AI notes, with the notes null at first, to a fixed value', () => {
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    expect(contentHashOf(documents)).toBe('a5de85ae95f682f027744f9592c68417fd631c2706bad57870b404a5ddafc1b2');
    expect(contentHashOf(documents, 'a note')).not.toBe(contentHashOf(documents));
    expect(contentHashOf(documents, null, { sentences: [] })).not.toBe(contentHashOf(documents));
  });

  it('cut a title at the limit with a final ellipsis, counting characters and not bytes', () => {
    expect(defaultTitle('Widget', 'W-1', 200)).toBe('Widget W-1');
    const cut = defaultTitle('Widget', '😀'.repeat(300), 200);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(defaultTitle('W', 'x'.repeat(198), 200)).toBe(`W ${'x'.repeat(198)}`);
    expect(Array.from(defaultTitle('W', 'x'.repeat(199), 200)).at(-1)).toBe('…');
  });
});

describe('the draft on write', () => {
  const valid = { id: uuidv7(), ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), mappingHash: 'h', contentHash: 'c', nodeCount: 1, edgeCount: 0, countsPolicyVersion: 'none' };
  const draft = (overrides: Record<string, unknown>): NewDraft => JSON.parse(JSON.stringify({ ...valid, ...overrides }));
  const investigation = (draftToWrite: NewDraft) => ({ id: uuidv7(), sourceId: 'demo', sourceIdentityHash: 'i', ownerId: LOCAL_IDENTITY.principal.id, title: 'T', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', draft: draftToWrite });

  it.each([
    ['a layout with another schema version', { layout: { ...valid.layout, schemaVersion: 2 } }],
    ['a layout with a field it does not have', { layout: { ...valid.layout, extra: 1 } }],
    ['a query context that is not an object', { queryContext: 'nothing' }],
    ['a layout that is empty', { layout: {} }],
  ])('refuses %s and keeps no row', async (_name, overrides) => {
    const store = memoryAppStore();
    await expect(store.createInvestigation(investigation(draft(overrides)))).rejects.toThrow();
    expect(store.investigations).toEqual([]);
    expect(store.drafts).toEqual([]);
  });

  it('writes a draft whose documents fit', async () => {
    const store = memoryAppStore();
    await expect(store.createInvestigation(investigation(valid))).resolves.toMatchObject({ created: true });
    expect(store.drafts).toHaveLength(1);
  });
});
