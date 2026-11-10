import { rmSync } from 'node:fs';
import { restoreViewResponseSchema, type LayoutDocument } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore, type MemoryNamedView } from '../testing/app-store.js';
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
const ID_2 = '0192f000-0000-7000-8000-0000000000c2';
const VIEW = '0192f000-0000-7000-8000-0000000000b1';
const VIEW_OF_OTHER = '0192f000-0000-7000-8000-0000000000b2';
const START = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
const node = (id: string) => ({ t: 'widget', id, pinned: false, hidden: false, groupId: null });
const LARGER: { layout: LayoutDocument; queryContext: typeof START.queryContext } = {
  layout: { schemaVersion: 1, layout: 'force', nodes: [node('W-1'), node('W-2')], edges: [], groups: [] },
  queryContext: { ...START.queryContext, loaded: { nodes: [{ t: 'widget', id: 'W-1' }, { t: 'widget', id: 'W-2' }], edges: [] } },
};

function row(id: string, ownerId = ME): InvestigationRow {
  return { id, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 };
}

const savedView: MemoryNamedView = { id: VIEW, investigationId: ID, name: 'Larger', notes: 'a note', layout: LARGER.layout, queryContext: LARGER.queryContext, contentHash: contentHashOf(LARGER, 'a note'), createdAt: '2026-11-08T09:30:00.000Z', version: 4 };

function seeded(ownerId = ME): MemoryAppStore {
  const store = memoryAppStore();
  for (const id of [ID, ID_2]) {
    store.investigations.push(row(id, id === ID ? ownerId : ME));
    store.drafts.push({ id: `0192f000-0000-7000-8000-0000000000d${id.slice(-1)}`, version: 3, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: START.layout, queryContext: START.queryContext, investigationId: id, contentHash: contentHashOf(START) });
  }
  store.namedViews.push(savedView, { ...savedView, id: VIEW_OF_OTHER, investigationId: ID_2 });
  return store;
}

async function started(store: MemoryAppStore) {
  const gate = testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: gate.gate, referenceKeys: TEST_REFERENCE_KEYS });
  return { app, executor: gate.executor };
}

type App = Awaited<ReturnType<typeof started>>['app'];
const restore = (app: App, headers: Record<string, string> = { 'if-match': '"3"' }, id = ID, viewId = VIEW, payload?: object) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${viewId}/restore`, headers, ...(payload === undefined ? {} : { payload }) });

describe('POST /v1/investigations/{id}/views/{viewId}/restore', () => {
  it('changes nothing for a refused restore: no If-Match, a stale one, a body, another owner, another investigation’s view, a deleted or unknown investigation, an unknown view', async () => {
    const store = seeded();
    const { app } = await started(store);
    const before = JSON.stringify([store.investigations, store.drafts, store.namedViews]);
    const refused = [
      await restore(app, {}),
      await restore(app, { 'if-match': 'x' }),
      await restore(app, { 'if-match': '"2"' }),
      await restore(app, { 'if-match': '"3"', 'content-type': 'application/json' }, ID, VIEW, { a: 1 }),
      await restore(app, { 'if-match': '"3"' }, ID, VIEW_OF_OTHER),
      await restore(app, { 'if-match': '"3"' }, ID, '0192f000-0000-7000-8000-0000000000ee'),
      await restore(app, { 'if-match': '"3"' }, ID, 'not-a-uuid'),
      await restore(app, { 'if-match': '"3"' }, '0192f000-0000-7000-8000-0000000000ee'),
    ];
    expect(refused.map((response) => response.json().error.code)).toEqual(['INVALID_REQUEST', 'INVALID_REQUEST', 'CONFLICTED_VIEW_VERSION', 'INVALID_REQUEST', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    expect(refused.map((response) => response.statusCode)).toEqual([400, 400, 409, 400, 404, 404, 404, 404]);
    expect(JSON.stringify([store.investigations, store.drafts, store.namedViews])).toBe(before);
    await app.close();
  });

  it.each([
    ['a source that is no longer configured', { sourceId: 'gone' }],
    ['a source that now points at another database', { sourceIdentityHash: 'another-database' }],
  ])('answers CONFLICT and changes nothing for an investigation whose source is %s', async (_name, overrides) => {
    const store = seeded();
    const [first] = store.investigations;
    if (first === undefined) throw new Error('seeded an investigation');
    store.investigations[0] = { ...first, ...overrides };
    const { app } = await started(store);
    const before = JSON.stringify([store.investigations, store.drafts, store.namedViews]);
    const response = await restore(app);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(JSON.stringify([store.investigations, store.drafts, store.namedViews])).toBe(before);
    await app.close();
  });

  it('answers NOT_FOUND for another user’s investigation and changes nothing', async () => {
    const store = seeded('0192f000-0000-7000-8000-0000000000aa');
    const { app } = await started(store);
    expect((await restore(app)).statusCode).toBe(404);
    expect(store.drafts[0]?.version).toBe(3);
    await app.close();
  });

  it('copies the view over the draft, bases the draft on it, raises its version and answers the draft and the ETag, without touching the view or a source', async () => {
    const store = seeded();
    const { app, executor } = await started(store);
    const response = await restore(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"4"');
    const answer = restoreViewResponseSchema.parse(response.json());
    expect(answer.draft).toMatchObject({ version: 4, notes: 'a note', basedOnViewId: VIEW });
    expect(answer.draft.layout.nodes.map((entry) => entry.id)).toEqual(['W-1', 'W-2']);
    expect(answer.save).toEqual({ state: 'saved', savedAt: '2026-11-08T09:30:00.000Z' });
    expect(store.drafts[0]).toMatchObject({ version: 4, notes: 'a note', basedOnViewId: VIEW, contentHash: savedView.contentHash });
    expect(store.namedViews[0]).toEqual(savedView);
    expect(store.investigations[0]?.lastEditedAt).not.toBe('2026-11-05T10:00:00.000Z');
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('leaves last_edited_at where it was when the draft already holds what the view holds', async () => {
    const store = seeded();
    const [draft] = store.drafts;
    if (draft === undefined) throw new Error('seeded a draft');
    store.drafts[0] = { ...draft, layout: LARGER.layout, queryContext: LARGER.queryContext, notes: 'a note', contentHash: savedView.contentHash };
    const { app } = await started(store);
    expect((await restore(app)).statusCode).toBe(200);
    expect(store.investigations[0]?.lastEditedAt).toBe('2026-11-05T10:00:00.000Z');
    expect(store.drafts[0]?.version).toBe(4);
    await app.close();
  });

  it('lets a write of the draft with the new version succeed, and reads the draft as unsaved after the first content change', async () => {
    const store = seeded();
    const { app } = await started(store);
    await restore(app);
    const same = await app.inject({ method: 'PUT', url: `/v1/investigations/${ID}/draft`, headers: { 'if-match': '"4"' }, payload: { layout: LARGER.layout, queryContext: LARGER.queryContext, notes: 'a note' } });
    expect(same.statusCode).toBe(200);
    expect(store.drafts[0]?.version).toBe(4);
    const changed = await app.inject({ method: 'PUT', url: `/v1/investigations/${ID}/draft`, headers: { 'if-match': '"4"' }, payload: { layout: LARGER.layout, queryContext: LARGER.queryContext, notes: 'another' } });
    expect(changed.statusCode).toBe(200);
    expect(store.drafts[0]).toMatchObject({ version: 5, notes: 'another' });
    await app.close();
  });
});
