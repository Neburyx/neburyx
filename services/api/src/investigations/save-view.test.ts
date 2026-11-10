import { rmSync } from 'node:fs';
import { saveViewResponseSchema } from '@neburyx/contracts';
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
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';

function seeded(overrides: Partial<InvestigationRow> = {}): MemoryAppStore {
  const store = memoryAppStore();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  store.investigations.push({ id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1, ...overrides });
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: documents.layout, queryContext: documents.queryContext, investigationId: ID, contentHash: contentHashOf(documents) });
  return store;
}

async function started(store: MemoryAppStore) {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
}

type App = Awaited<ReturnType<typeof started>>;
const save = (app: App, payload: unknown, headers: Record<string, string> = { 'if-match': '"1"' }, id = ID) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views`, headers, payload: payload as object });
const NOTED = { name: 'First look', notes: 'a note' };

describe('POST /v1/investigations/{id}/views', () => {
  it('writes a refused save nowhere: a bad request, a stale draft, a stale title version, another owner, a deleted or unknown investigation', async () => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify([store.investigations, store.drafts, store.namedViews]);
    const refused = [
      await save(app, NOTED, {}),
      await save(app, NOTED, { 'if-match': 'x' }),
      await save(app, NOTED, { 'if-match': '"2"' }),
      await save(app, { ...NOTED, title: 'New', expectedInvestigationVersion: 2 }),
      await save(app, NOTED, { 'if-match': '"1"' }, '0192f000-0000-7000-8000-0000000000ee'),
      await save(app, NOTED, { 'if-match': '"1"' }, 'not-a-uuid'),
    ];
    expect(refused.map((response) => response.statusCode)).toEqual([400, 400, 409, 409, 404, 404]);
    expect(refused.map((response) => response.json().error.code)).toEqual(['INVALID_REQUEST', 'INVALID_REQUEST', 'CONFLICTED_VIEW_VERSION', 'CONFLICT', 'NOT_FOUND', 'NOT_FOUND']);
    expect(JSON.stringify([store.investigations, store.drafts, store.namedViews])).toBe(before);
    await app.close();
  });

  it.each([
    ['no name', { notes: null }],
    ['an empty name', { name: '', notes: null }],
    ['a name of 121 characters', { name: 'a'.repeat(121), notes: null }],
    ['a name with a NUL', { name: 'a\u0000b', notes: null }],
    ['a name with an unpaired surrogate', { name: 'a\ud800b', notes: null }],
    ['no note field', { name: 'a' }],
    ['a note of 10,001 characters', { name: 'a', notes: 'n'.repeat(10_001) }],
    ['a note with a NUL', { name: 'a', notes: 'a\u0000b' }],
    ['an empty title', { name: 'a', notes: null, title: '', expectedInvestigationVersion: 1 }],
    ['a title of 201 characters', { name: 'a', notes: null, title: 't'.repeat(201), expectedInvestigationVersion: 1 }],
    ['a title without the version it replaces', { name: 'a', notes: null, title: 'New' }],
    ['a version without a title', { name: 'a', notes: null, expectedInvestigationVersion: 1 }],
    ['an unknown field', { name: 'a', notes: null, extra: true }],
    ['a body that is a list', []],
  ])('answers INVALID_REQUEST and stores nothing for %s', async (_name, payload) => {
    const store = seeded();
    const app = await started(store);
    const response = await save(app, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(store.namedViews).toHaveLength(0);
    expect(store.drafts[0]?.version).toBe(1);
    await app.close();
  });

  it('answers NOT_FOUND for another user’s investigation and stores nothing', async () => {
    const store = seeded({ ownerId: OTHER });
    const app = await started(store);
    const response = await save(app, NOTED);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(store.namedViews).toHaveLength(0);
    await app.close();
  });

  it.each([
    ['a source that is no longer configured', { sourceId: 'gone' }],
    ['a source that now points at another database', { sourceIdentityHash: 'another-database' }],
  ])('answers CONFLICT and stores nothing for an investigation whose source is %s', async (_name, overrides) => {
    const store = seeded(overrides);
    const app = await started(store);
    const before = JSON.stringify([store.investigations, store.drafts, store.namedViews]);
    const response = await save(app, NOTED);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(JSON.stringify([store.investigations, store.drafts, store.namedViews])).toBe(before);
    await app.close();
  });

  it('copies the draft into a named view with the note given, points the draft at it, raises the draft version, moves last_edited_at, and answers 201 with the new ETag', async () => {
    const store = seeded();
    const app = await started(store);
    const response = await save(app, NOTED);
    expect(response.statusCode).toBe(201);
    expect(response.headers['etag']).toBe('"2"');
    const answer = saveViewResponseSchema.parse(response.json());
    const [view] = store.namedViews;
    expect(view).toMatchObject({ investigationId: ID, name: 'First look', notes: 'a note' });
    expect(view?.layout).toEqual(initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }).layout);
    expect(answer).toEqual({
      view: { id: view?.id, name: 'First look', notes: 'a note', savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt: view?.createdAt, version: 1 },
      draft: { version: 2, notes: 'a note', basedOnViewId: view?.id },
      save: { state: 'saved', savedAt: view?.createdAt },
    });
    expect(store.drafts[0]).toMatchObject({ version: 2, notes: 'a note', basedOnViewId: view?.id });
    expect(store.investigations[0]?.lastEditedAt).not.toBe('2026-11-05T10:00:00.000Z');
    expect(store.investigations[0]?.title).toBe('Widget W-1');
    await app.close();
  });

  it('changes the title when the version of the investigation matches, and answers the new title and version', async () => {
    const store = seeded();
    const app = await started(store);
    const response = await save(app, { ...NOTED, title: 'Ring of five', expectedInvestigationVersion: 1 });
    expect(response.statusCode).toBe(201);
    expect(saveViewResponseSchema.parse(response.json()).investigation).toEqual({ title: 'Ring of five', version: 2 });
    expect(store.investigations[0]).toMatchObject({ title: 'Ring of five', version: 2 });
    await app.close();
  });

  it('creates a second view when nothing changed since the last save, and leaves the first as it was', async () => {
    const store = seeded();
    const app = await started(store);
    expect((await save(app, NOTED)).statusCode).toBe(201);
    const [first] = store.namedViews;
    const again = await save(app, NOTED, { 'if-match': '"2"' });
    expect(again.statusCode).toBe(201);
    expect(store.namedViews).toHaveLength(2);
    expect(store.namedViews[0]).toEqual(first);
    expect(store.namedViews[1]?.id).not.toBe(first?.id);
    expect(store.drafts[0]).toMatchObject({ version: 3, basedOnViewId: store.namedViews[1]?.id });
    await app.close();
  });
});
