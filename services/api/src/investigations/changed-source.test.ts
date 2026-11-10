import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investigationResponseSchema, openInvestigationResponseSchema, investigationListResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { plainNode, entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'widget' }] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const REPOINTED = '0192f000-0000-7000-8000-0000000000c1';
const REMOVED = '0192f000-0000-7000-8000-0000000000c2';
const AVAILABLE = '0192f000-0000-7000-8000-0000000000c3';
const VIEW = '0192f000-0000-7000-8000-0000000000b1';
const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });

function row(id: string, overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  return { id, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: id === REPOINTED ? 'CASE-1' : null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 2, ...overrides };
}

function seeded(): MemoryAppStore {
  const store = memoryAppStore();
  store.investigations.push(row(REPOINTED, { sourceIdentityHash: 'another-database' }), row(REMOVED, { sourceId: 'gone', caseRef: 'CASE-2' }), row(AVAILABLE));
  for (const [index, investigationId] of [REPOINTED, REMOVED, AVAILABLE].entries()) {
    store.drafts.push({ id: `0192f000-0000-7000-8000-0000000000d${index}`, version: 3, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: documents.layout, queryContext: documents.queryContext, investigationId, contentHash: contentHashOf(documents) });
  }
  store.namedViews.push({ id: VIEW, investigationId: REPOINTED, name: 'A view', notes: null, layout: documents.layout, queryContext: documents.queryContext, contentHash: contentHashOf(documents), createdAt: '2026-11-08T09:30:00.000Z', version: 1 });
  return store;
}

async function started(store: MemoryAppStore = seeded()) {
  const executor = new TestExecutor(withOnlineIndexes(demo, () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
  return { app, store, executor };
}

type App = Awaited<ReturnType<typeof started>>['app'];
const snapshot = (store: MemoryAppStore) => JSON.stringify([store.investigations, store.drafts, store.namedViews]);

describe('a re-pointed or removed source: no source read', () => {
  it.each([[REPOINTED, 'repointed'], [REMOVED, 'removed']] as const)('answers GET of the investigation (%s) with its stored draft and reads nothing', async (id, state) => {
    const { app, executor } = await started();
    const response = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(response.statusCode).toBe(200);
    const answer = investigationResponseSchema.parse(response.json());
    expect(answer.investigation.sourceState).toBe(state);
    expect(answer.draft.layout.nodes.map((node) => node.t)).toEqual(['widget']);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers a reused re-pointed investigation without an entity and reads nothing, and a removed source as not found', async () => {
    const { app, executor } = await started();
    const reused = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-1' } });
    expect(reused.statusCode).toBe(200);
    const answer = openInvestigationResponseSchema.parse(reused.json());
    expect(answer).toMatchObject({ created: false, investigation: { id: REPOINTED, sourceState: 'repointed' } });
    expect(answer).not.toHaveProperty('entity');
    const gone = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'gone', entity: { sourceId: 'gone', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-2' } });
    expect(gone.statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('lists both with their source state and reads nothing', async () => {
    const { app, executor } = await started();
    const list = investigationListResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/investigations?limit=25' })).json());
    expect(Object.fromEntries(list.items.map((item) => [item.id, item.sourceState]))).toMatchObject({ [REPOINTED]: 'repointed', [REMOVED]: 'removed', [AVAILABLE]: 'available' });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers another user as not found, as for any investigation', async () => {
    const store = seeded();
    const { app } = await started({ ...store, current: () => Promise.resolve({ ...LOCAL_IDENTITY, principal: { ...LOCAL_IDENTITY.principal, id: OTHER } }) });
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${REPOINTED}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${REMOVED}` })).statusCode).toBe(404);
    await app.close();
  });

  it('returns stored identifiers of a removed source as stored and invents no value', async () => {
    const { app } = await started();
    const answer = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: `/v1/investigations/${REMOVED}` })).json());
    const stored = documents.layout.nodes.map((node) => node.id);
    expect(answer.draft.layout.nodes.map((node) => node.id)).toEqual(stored.map((id) => id));
    expect(JSON.stringify(answer.draft)).not.toMatch(/widgetId/);
    await app.close();
  });

  it('leaves an available investigation of the same source reading as before', async () => {
    const { app, executor } = await started();
    const response = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-NEW' } });
    expect(response.statusCode).toBe(201);
    expect(executor.calls.length).toBeGreaterThan(0);
    await app.close();
  });
});

const write = {
  draft: (app: App, id: string) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers: { 'if-match': '"3"' }, payload: { notes: null, layout: documents.layout, queryContext: documents.queryContext } }),
  rename: (app: App, id: string) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}`, payload: { title: 'Renamed', expectedVersion: 2 } }),
  saveView: (app: App, id: string) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views`, headers: { 'if-match': '"3"' }, payload: { name: 'New', notes: null } }),
  renameView: (app: App, id: string) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}/views/${VIEW}`, headers: { 'if-match': '"1"' }, payload: { name: 'Renamed' } }),
  deleteView: (app: App, id: string) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${VIEW}/delete`, headers: { 'if-match': '"1"' }, payload: {} }),
  restore: (app: App, id: string) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${VIEW}/restore`, headers: { 'if-match': '"3"' } }),
};

describe('a re-pointed or removed source refuses writes', () => {
  it.each(Object.entries(write))('refuses %s with source-changed, stores nothing and reads nothing', async (_name, call) => {
    const { app, store, executor } = await started();
    for (const [id, sourceState] of [[REPOINTED, 'repointed'], [REMOVED, 'removed']] as const) {
      const before = snapshot(store);
      const response = await call(app, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: 'CONFLICT', retryable: false, details: { reason: 'source-changed', sourceState } });
      expect(snapshot(store)).toBe(before);
    }
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('names the source-changed sentence and no status', async () => {
    const { app } = await started();
    const error = (await write.draft(app, REPOINTED)).json().error;
    expect(error.message).toBe('This source now points to a different database or is no longer configured. This investigation is read-only.');
    expect(error.details).toEqual({ reason: 'source-changed', sourceState: 'repointed' });
    await app.close();
  });

  it('answers the closed or archived refusal first, then source-changed before a stale version, and not found for another user first', async () => {
    const store = seeded();
    const { app } = await started(store);
    const [held] = store.investigations;
    if (held === undefined) throw new Error('seeded');
    store.investigations[0] = { ...held, status: 'closed' };
    expect((await write.draft(app, REPOINTED)).json().error.details).toMatchObject({ reason: 'investigation-read-only', status: 'closed' });
    store.investigations[0] = { ...held, status: 'open' };
    const staleDraft = await app.inject({ method: 'PUT', url: `/v1/investigations/${REPOINTED}/draft`, headers: { 'if-match': '"99"' }, payload: { notes: null, layout: documents.layout, queryContext: documents.queryContext } });
    expect(staleDraft.json().error.code).toBe('CONFLICT');
    expect(staleDraft.json().error.details.reason).toBe('source-changed');
    const staleRename = await app.inject({ method: 'PUT', url: `/v1/investigations/${REPOINTED}`, payload: { title: 'Renamed', expectedVersion: 99 } });
    expect(staleRename.json().error.details.reason).toBe('source-changed');
    await app.close();
    const other = await started({ ...store, current: () => Promise.resolve({ ...LOCAL_IDENTITY, principal: { ...LOCAL_IDENTITY.principal, id: OTHER } }) });
    expect((await write.draft(other.app, REPOINTED)).statusCode).toBe(404);
    await other.app.close();
  });

  it('still answers GET, status changes and Delete, and reads nothing', async () => {
    const { app, executor } = await started();
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${REPOINTED}` })).statusCode).toBe(200);
    const closed = await app.inject({ method: 'POST', url: `/v1/investigations/${REPOINTED}/status`, payload: { status: 'closed', expectedVersion: 2 } });
    expect(closed.statusCode).toBe(200);
    const reopened = await app.inject({ method: 'POST', url: `/v1/investigations/${REPOINTED}/status`, payload: { status: 'open', expectedVersion: closed.json().investigation.version } });
    expect(reopened.statusCode).toBe(200);
    const deleted = await app.inject({ method: 'DELETE', url: `/v1/investigations/${REMOVED}`, headers: { 'if-match': '"2"' } });
    expect(deleted.statusCode).toBeLessThan(300);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('still writes an available investigation of the same source', async () => {
    const { app } = await started();
    expect((await write.draft(app, AVAILABLE)).statusCode).toBe(200);
    expect((await write.rename(app, AVAILABLE)).statusCode).toBe(200);
    await app.close();
  });
});

/** Every route that changes an investigation, by what a changed source does to it. A route added without a row here fails the test below, so none is left without a decision. */
const REFUSED_ROUTES: readonly (readonly [string, keyof typeof write])[] = [
  ['PUT /v1/investigations/{id}/draft', 'draft'],
  ['PUT /v1/investigations/{id}', 'rename'],
  ['POST /v1/investigations/{id}/views', 'saveView'],
  ['PUT /v1/investigations/{id}/views/{viewId}', 'renameView'],
  ['POST /v1/investigations/{id}/views/{viewId}/delete', 'deleteView'],
  ['POST /v1/investigations/{id}/views/{viewId}/restore', 'restore'],
];
const ALLOWED_ROUTES: readonly string[] = [
  // opening reads nothing for a changed source (above), and these change the status or the deletion mark, which no source read or draft write is part of
  'POST /v1/investigations',
  'POST /v1/investigations/{id}/status',
  'DELETE /v1/investigations/{id}',
  'POST /v1/investigations/{id}/restore',
];

describe('every route that changes an investigation has a decision for a changed source', () => {
  const document = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/contracts/openapi.json', import.meta.url)), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const changing = Object.entries(document.paths)
    .filter(([path]) => path.startsWith('/v1/investigations'))
    .flatMap(([path, operations]) => Object.keys(operations).filter((method) => method !== 'get' && method !== 'parameters').map((method) => `${method.toUpperCase()} ${path}`));

  it('lists each one as refused or allowed, and nothing in the lists is a route that is gone', () => {
    const decided = [...REFUSED_ROUTES.map(([route]) => route), ...ALLOWED_ROUTES];
    expect(changing.filter((route) => !decided.includes(route))).toEqual([]);
    expect(decided.filter((route) => !changing.includes(route))).toEqual([]);
  });

  it.each(REFUSED_ROUTES)('refuses %s with source-changed', async (_route, name) => {
    const { app } = await started();
    expect((await write[name](app, REPOINTED)).json().error.details).toEqual({ reason: 'source-changed', sourceState: 'repointed' });
    await app.close();
  });
});
