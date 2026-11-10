import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { viewListResponseSchema, namedViewSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createCursorCodec } from '../gate/cursor/codec.js';
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
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';
const ID_2 = '0192f000-0000-7000-8000-0000000000c2';
const viewId = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function investigation(id: string, ownerId = ME): InvestigationRow {
  return { id, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 };
}

const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });

function view(n: number, investigationId = ID, overrides: Partial<MemoryNamedView> = {}): MemoryNamedView {
  const second = String(n % 60).padStart(2, '0');
  return { id: viewId(n), investigationId, name: `View ${n}`, notes: n % 2 === 0 ? `note ${n}` : null, layout: documents.layout, queryContext: documents.queryContext, contentHash: contentHashOf(documents), createdAt: `2026-11-10T09:${String(Math.floor(n / 60)).padStart(2, '0')}:${second}.000Z`, version: 1, ...overrides };
}

function seeded(views: readonly MemoryNamedView[], ownerId = ME): MemoryAppStore {
  const store = memoryAppStore();
  for (const id of [ID, ID_2]) {
    store.investigations.push(investigation(id, id === ID ? ownerId : ME));
    store.drafts.push({ id: `0192f000-0000-7000-8000-0000000000d${id.slice(-1)}`, version: 1, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: documents.layout, queryContext: documents.queryContext, investigationId: id, contentHash: contentHashOf(documents) });
  }
  store.namedViews.push(...views);
  return store;
}

async function started(store: MemoryAppStore, clock: () => number = Date.now) {
  const gate = testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: gate.gate, referenceKeys: TEST_REFERENCE_KEYS, cursors: createCursorCodec({ key: randomBytes(32), clock }) });
  return { app, executor: gate.executor };
}

type App = Awaited<ReturnType<typeof started>>['app'];
const list = (app: App, query = '', id = ID) => app.inject({ method: 'GET', url: `/v1/investigations/${id}/views${query}` });
const rename = (app: App, payload: unknown, headers: Record<string, string> = { 'if-match': '"1"' }, id = ID, vid = viewId(1)) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}/views/${vid}`, headers, payload: payload as object });

describe('GET /v1/investigations/{id}/views', () => {
  it('answers the limit and cursor refusals with nothing in the body: limit 0, limit 101, a cursor that is altered, expired or made for another investigation', async () => {
    let now = 1_000_000;
    const store = seeded(Array.from({ length: 5 }, (_, n) => view(n + 1)));
    const { app } = await started(store, () => now);
    const first = viewListResponseSchema.parse((await list(app, '?limit=2')).json());
    const cursor = first.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const refused = [
      await list(app, '?limit=0'),
      await list(app, '?limit=101'),
      await list(app, '?limit=10000000000'),
      await list(app, '?limit=1.5'),
      await list(app, '?sort=name'),
      await list(app, `?cursor=${cursor.slice(0, -2)}xx`),
      await list(app, `?cursor=${cursor}`, ID_2),
    ];
    expect(refused.map((response) => response.statusCode)).toEqual([400, 422, 422, 400, 400, 409, 409]);
    expect(refused.map((response) => response.json().error.code)).toEqual(['INVALID_REQUEST', 'QUERY_BUDGET_EXCEEDED', 'QUERY_BUDGET_EXCEEDED', 'INVALID_REQUEST', 'INVALID_REQUEST', 'CURSOR_INVALIDATED', 'CURSOR_INVALIDATED']);
    expect(refused[1]?.json().error.details).toEqual({ maxPage: 100 });
    expect(refused[2]?.json().error.details).toEqual({ maxPage: 100 });
    for (const response of refused) expect(response.json()).not.toHaveProperty('items');
    now += 31 * 60_000;
    expect((await list(app, `?cursor=${cursor}`)).json().error.code).toBe('CURSOR_INVALIDATED');
    await app.close();
  });

  it('answers NOT_FOUND for another user’s investigation, an unknown ID and an ID that is not a UUID', async () => {
    const { app } = await started(seeded([view(1)], OTHER));
    const answers = [await list(app), await list(app, '', '0192f000-0000-7000-8000-0000000000ee'), await list(app, '', 'not-a-uuid')];
    expect(answers.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(answers.map((response) => response.json().error.code)).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    await app.close();
  });

  it('lists summaries newest first, with the exact count, no next cursor and the draft, and reads no source', async () => {
    const store = seeded([view(1), view(3), view(2)]);
    const { app, executor } = await started(store);
    const response = await list(app);
    expect(response.statusCode).toBe(200);
    const answer = viewListResponseSchema.parse(response.json());
    expect(answer.items.map((item) => item.name)).toEqual(['View 3', 'View 2', 'View 1']);
    expect(answer.items[0]).toEqual({ id: viewId(3), name: 'View 3', notes: null, savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt: '2026-11-10T09:00:03.000Z', version: 1 });
    expect(JSON.stringify(answer)).not.toContain('layout');
    expect(JSON.stringify(answer)).not.toContain('queryContext');
    expect(answer.count).toEqual({ value: 3, quality: 'exact', scope: 'named-views' });
    expect(answer.nextCursor).toBeNull();
    expect(answer.draft.basedOnViewId).toBeNull();
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('pages by cursor: every view once and in order, the same count on each page, a view of the other investigation never', async () => {
    const store = seeded([...Array.from({ length: 7 }, (_, n) => view(n + 1)), view(50, ID_2)]);
    const { app } = await started(store);
    const seen: string[] = [];
    const counts: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const answer = viewListResponseSchema.parse((await list(app, `?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`)).json());
      seen.push(...answer.items.map((item) => item.name));
      counts.push(answer.count.value);
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['View 7', 'View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
    expect(counts).toEqual([7, 7, 7]);
    await app.close();
  });

  it('lists the views made at the same time in the order of their IDs, none repeated or skipped across pages', async () => {
    const store = seeded([1, 2, 3, 4].map((n) => view(n, ID, { createdAt: '2026-11-10T09:00:00.000Z' })));
    const { app } = await started(store);
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const answer = viewListResponseSchema.parse((await list(app, `?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`)).json());
      names.push(...answer.items.map((item) => item.name));
      cursor = answer.nextCursor;
    } while (cursor !== null);
    expect(names).toEqual(['View 4', 'View 3', 'View 2', 'View 1']);
    await app.close();
  });

  it('answers draft.basedOnViewId null when the view the draft was based on is gone', async () => {
    const store = seeded([view(1)]);
    const [draft] = store.drafts;
    if (draft === undefined) throw new Error('seeded a draft');
    store.drafts[0] = { ...draft, basedOnViewId: viewId(1) };
    const { app } = await started(store);
    expect(viewListResponseSchema.parse((await list(app)).json()).draft.basedOnViewId).toBe(viewId(1));
    store.namedViews.length = 0;
    expect(viewListResponseSchema.parse((await list(app)).json()).draft.basedOnViewId).toBeNull();
    await app.close();
  });
});

describe('PUT /v1/investigations/{id}/views/{viewId}', () => {
  it('writes a refused rename nowhere: no If-Match, a stale one, a bad name or field, another owner, another investigation’s view, an unknown view', async () => {
    const store = seeded([view(1), view(2, ID_2, { id: viewId(9) })]);
    const { app } = await started(store);
    const before = JSON.stringify(store.namedViews);
    const refused = [
      await rename(app, { name: 'New' }, {}),
      await rename(app, { name: 'New' }, { 'if-match': '"2"' }),
      await rename(app, { name: '' }),
      await rename(app, { name: 'a'.repeat(121) }),
      await rename(app, { name: 'a\u0000' }),
      await rename(app, { name: 'a\ud800' }),
      await rename(app, { name: 'New', notes: 'x' }),
      await rename(app, {}),
      await rename(app, { name: 'New' }, { 'if-match': '"1"' }, ID, viewId(9)),
      await rename(app, { name: 'New' }, { 'if-match': '"1"' }, ID, viewId(77)),
      await rename(app, { name: 'New' }, { 'if-match': '"1"' }, ID, 'not-a-uuid'),
      await rename(app, { name: 'New' }, { 'if-match': '"1"' }, '0192f000-0000-7000-8000-0000000000ee'),
    ];
    expect(refused.map((response) => response.statusCode)).toEqual([400, 409, 400, 400, 400, 400, 400, 400, 404, 404, 404, 404]);
    expect(refused.map((response) => response.json().error.code)).toEqual(['INVALID_REQUEST', 'CONFLICTED_VIEW_VERSION', 'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    expect(JSON.stringify(store.namedViews)).toBe(before);
    await app.close();
  });

  it('answers NOT_FOUND for another user’s investigation', async () => {
    const store = seeded([view(1)], OTHER);
    const { app } = await started(store);
    expect((await rename(app, { name: 'New' })).statusCode).toBe(404);
    expect(store.namedViews[0]?.name).toBe('View 1');
    await app.close();
  });

  it('changes only the name and the version, answers the summary and the new ETag, and moves nothing of the investigation', async () => {
    const store = seeded([view(2)]);
    const { app } = await started(store);
    const lastEdited = store.investigations[0]?.lastEditedAt;
    const response = await rename(app, { name: 'Renamed' }, { 'if-match': '"1"' }, ID, viewId(2));
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    expect(namedViewSchema.parse(response.json())).toMatchObject({ id: viewId(2), name: 'Renamed', notes: 'note 2', version: 2 });
    expect(store.namedViews[0]).toMatchObject({ name: 'Renamed', version: 2, notes: 'note 2', contentHash: contentHashOf(documents) });
    expect(store.namedViews[0]?.layout).toEqual(documents.layout);
    expect(store.investigations[0]?.lastEditedAt).toBe(lastEdited);
    await app.close();
  });
});
