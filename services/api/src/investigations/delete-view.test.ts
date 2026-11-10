import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'widget' }] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const ID = '0192f000-0000-7000-8000-0000000000c1';
const VIEW = '0192f000-0000-7000-8000-0000000000b1';
const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });

function seeded(status: InvestigationRow['status']): MemoryAppStore {
  const store = memoryAppStore();
  store.investigations.push({ id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status, closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 });
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 3, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: documents.layout, queryContext: documents.queryContext, investigationId: ID, contentHash: contentHashOf(documents) });
  store.namedViews.push({ id: VIEW, investigationId: ID, name: 'A view', notes: null, layout: documents.layout, queryContext: documents.queryContext, contentHash: contentHashOf(documents), createdAt: '2026-11-08T09:30:00.000Z', version: 1 });
  return store;
}

async function started(store: MemoryAppStore) {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
}


type App = Awaited<ReturnType<typeof started>>;
const path = `/v1/investigations/${ID}/views`;
const remove = (app: App, headers: Record<string, string> = { 'if-match': '"1"' }, payload?: unknown, id = ID, viewId = VIEW) =>
  app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${viewId}/delete`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('POST /v1/investigations/{id}/views/{viewId}/delete', () => {
  it.each([
    ['no If-Match', {}],
    ['an If-Match of *', { 'if-match': '*' }],
    ['a weak tag', { 'if-match': 'W/"1"' }],
    ['a tag that is not a number', { 'if-match': '"one"' }],
  ])('refuses %s with INVALID_REQUEST and deletes nothing', async (_name, headers) => {
    const store = seeded('open');
    const app = await started(store);
    const response = await remove(app, headers);
    expect(response.statusCode).toBe(400);
    expect(store.namedViews[0]?.deletedAt).toBeUndefined();
    await app.close();
  });

  it.each([
    ['a note over 10,000 characters', { note: 'a'.repeat(10_001) }],
    ['a note with a NUL', { note: 'a\u0000b' }],
    ['a note that is not text', { note: 3 }],
    ['a note with an unpaired surrogate', { note: 'a\ud800b' }],
    ['another field', { note: 'why', reason: 'x' }],
  ])('refuses %s with INVALID_REQUEST and deletes nothing', async (_name, payload) => {
    const store = seeded('open');
    const app = await started(store);
    const response = await remove(app, { 'if-match': '"1"' }, payload);
    expect(response.statusCode).toBe(400);
    expect(store.namedViews[0]?.deletedAt).toBeUndefined();
    await app.close();
  });

  it('refuses a stale If-Match with CONFLICTED_VIEW_VERSION and deletes nothing', async () => {
    const store = seeded('open');
    const app = await started(store);
    const response = await remove(app, { 'if-match': '"2"' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(store.namedViews[0]?.deletedAt).toBeUndefined();
    await app.close();
  });

  it.each([
    ['an unknown view', ID, '0192f000-0000-7000-8000-0000000000ff'],
    ['an unknown investigation', '0192f000-0000-7000-8000-0000000000ff', VIEW],
    ['ids that are not UUIDs', 'x', 'y'],
  ])('answers NOT_FOUND for %s', async (_name, id, viewId) => {
    const app = await started(seeded('open'));
    expect((await remove(app, { 'if-match': '"1"' }, undefined, id, viewId)).statusCode).toBe(404);
    await app.close();
  });

  it('answers NOT_FOUND for another user\'s investigation, and for a view that belongs to another investigation, and deletes nothing', async () => {
    const other = seeded('open');
    const [mine] = other.investigations;
    if (mine === undefined) throw new Error('the fixture has an investigation');
    other.investigations[0] = { ...mine, ownerId: '0192f000-0000-7000-8000-0000000000aa' };
    const app = await started(other);
    expect((await remove(app)).statusCode).toBe(404);
    expect(other.namedViews[0]?.deletedAt).toBeUndefined();
    await app.close();

    const store = seeded('open');
    const SECOND = '0192f000-0000-7000-8000-0000000000c2';
    const [first] = store.investigations;
    const [firstDraft] = store.drafts;
    const [firstView] = store.namedViews;
    if (first === undefined || firstDraft === undefined || firstView === undefined) throw new Error('the fixture has rows');
    store.investigations.push({ ...first, id: SECOND });
    store.drafts.push({ ...firstDraft, id: '0192f000-0000-7000-8000-0000000000d2', investigationId: SECOND });
    const crossed = await started(store);
    expect((await remove(crossed, { 'if-match': '"1"' }, undefined, SECOND, VIEW)).statusCode).toBe(404);
    expect(store.namedViews[0]?.deletedAt).toBeUndefined();
    await crossed.close();
  });

  it.each(['closed', 'archived'] as const)('refuses a view of an investigation that is %s with the read-only CONFLICT, before the version is checked', async (status) => {
    const store = seeded(status);
    const app = await started(store);
    const response = await remove(app, { 'if-match': '"99"' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status } } });
    expect(store.namedViews[0]?.deletedAt).toBeUndefined();
    await app.close();
  });

  it('deletes the view, keeps the note, leaves the draft, and answers the new state', async () => {
    const store = seeded('open');
    const [draftBefore] = store.drafts;
    const app = await started(store);
    const response = await remove(app, { 'if-match': '"1"' }, { note: 'Duplicate of the review view' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    expect(response.json()).toMatchObject({ id: VIEW, version: 2, draft: { version: 3, basedOnViewId: null }, save: { state: 'unsaved', savedAt: null }, count: { value: 0, quality: 'exact', scope: 'named-views' } });
    expect(store.namedViews[0]).toMatchObject({ deletionNote: 'Duplicate of the review view', version: 2 });
    expect(store.drafts[0]).toEqual(draftBefore);
    await app.close();
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['a null note', { note: null }],
    ['an empty note', { note: '' }],
  ])('stores no note for %s', async (_name, payload) => {
    const store = seeded('open');
    const app = await started(store);
    expect((await remove(app, { 'if-match': '"1"' }, payload)).statusCode).toBe(200);
    expect(store.namedViews[0]?.deletionNote).toBeNull();
    await app.close();
  });

  it('accepts a note of 10,000 characters', async () => {
    const app = await started(seeded('open'));
    expect((await remove(app, { 'if-match': '"1"' }, { note: 'é'.repeat(10_000) })).statusCode).toBe(200);
    await app.close();
  });

  it('answers NOT_FOUND for a view that is already deleted, and leaves it out of the list, the rename and the restore', async () => {
    const app = await started(seeded('open'));
    expect((await remove(app)).statusCode).toBe(200);
    expect((await remove(app, { 'if-match': '"2"' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({ items: [], count: { value: 0 }, draft: { basedOnViewId: null } });
    expect((await app.inject({ method: 'PUT', url: `${path}/${VIEW}`, headers: { 'if-match': '"2"' }, payload: { name: 'Renamed' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${path}/${VIEW}/restore`, headers: { 'if-match': '"3"' } })).statusCode).toBe(404);
    await app.close();
  });

  it('reads the investigation as unsaved once the view its draft is based on is deleted', async () => {
    const store = seeded('open');
    const [draft] = store.drafts;
    if (draft === undefined) throw new Error('the fixture has a draft');
    store.drafts[0] = { ...draft, basedOnViewId: VIEW };
    const app = await started(store);
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${ID}` })).json()).toMatchObject({ save: { state: 'saved' }, draft: { basedOnViewId: VIEW } });
    expect((await remove(app)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/investigations/${ID}` })).json()).toMatchObject({ save: { state: 'unsaved', savedAt: null }, draft: { basedOnViewId: null } });
    await app.close();
  });

  it('does not log the note', async () => {
    const lines: string[] = [];
    const store = seeded('open');
    const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => lines.push(line) }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    await remove(app, { 'if-match': '"1"' }, { note: 'SECRET-NOTE-TEXT' });
    await remove(app, { 'if-match': '"1"' }, { note: 'SECRET-NOTE-TEXT' });
    expect(lines.join('')).not.toContain('SECRET-NOTE-TEXT');
    await app.close();
  });
});
