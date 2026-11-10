import { rmSync } from 'node:fs';
import { ownedViewListResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createCursorCodec, CURSOR_TTL_MS } from '../gate/cursor/codec.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Decision, PolicyProvider, Seams } from '../seams/seams.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryNamedView } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }];
const sources = [baseSource({ id: 'north', uri: 'neo4j+s://north.example.test:7687', entities, relationships: [] }), baseSource({ id: 'secret', uri: 'neo4j+s://secret.example.test:7687', entities, relationships: [] })];
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');
const OTHER_USER = '0192f000-0000-7000-8000-000000000002';

let counter = 0;
const nextId = (): string => `0192f000-0000-7000-8000-${String((counter += 1)).padStart(12, '0')}`;

function investigation(sourceId: string, overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  const found = mapping.sources.find((source) => source.id === sourceId);
  const at = new Date(Date.UTC(2026, 10, 5, 12)).toISOString();
  return { id: nextId(), sourceId, sourceIdentityHash: found === undefined ? 'retired' : identityHashOf(found), ownerId: LOCAL_IDENTITY.principal.id, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', createdAt: at, lastEditedAt: at, closedAt: null, archivedAt: null, version: 1, ...overrides };
}

function view(owner: InvestigationRow, seconds: number, name = `View ${seconds}`): MemoryNamedView {
  return { id: nextId(), investigationId: owner.id, name, notes: 'a note', layout: { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, contentHash: 'hash', createdAt: new Date(Date.UTC(2026, 10, 5, 13, 0, seconds)).toISOString(), version: 1 };
}

async function started() {
  let now = Date.UTC(2026, 10, 5, 14);
  const cursors = createCursorCodec({ key: Buffer.alloc(32, 9), clock: () => now });
  const policy: PolicyProvider = { authorizeSource: async ({ sourceId }): Promise<Decision> => (sourceId === 'secret' ? { allowed: false, reason: 'not permitted' } : { allowed: true }) };
  const seams: Seams = { ...communitySeams(), policy };
  const store = memoryAppStore();
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, seams, cursors, gate: testSourceGate(mapping, { executor, seams }).gate });
  const list = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: `/v1/views${query}` });
    return { status: response.statusCode, body: response.json() };
  };
  return { store, list, executor, advance: (ms: number) => void (now += ms) };
}

describe('the named views across the caller\'s investigations', () => {
  it('lists each view newest first with its investigation, an exact count, no documents and no cursor on the last page', async () => {
    const { store, list, executor } = await started();
    const first = investigation('north', { title: 'First case' });
    const second = investigation('north', { title: 'Second case', status: 'closed' });
    store.investigations.push(first, second);
    const oldest = view(first, 1);
    const middle = view(second, 2);
    const newest = view(first, 3);
    store.namedViews.push(oldest, middle, newest);
    const answer = await list();
    expect(answer.status).toBe(200);
    const parsed = ownedViewListResponseSchema.parse(answer.body);
    expect(parsed.items.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(parsed.items[1]).toEqual({ id: middle.id, name: 'View 2', investigation: { id: second.id, title: 'Second case', sourceId: 'north', sourceAlias: 'north', status: 'closed' }, savedBy: { name: LOCAL_IDENTITY.principal.displayName }, createdAt: middle.createdAt, version: 1 });
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.count).toEqual({ value: 3, quality: 'exact', scope: 'named-views' });
    expect(JSON.stringify(answer.body)).not.toMatch(/layout|queryContext|a note/);
    expect(executor.calls).toHaveLength(0);
  });

  it('lists views of a closed and of an archived investigation, and counts them', async () => {
    const { store, list } = await started();
    const closed = investigation('north', { status: 'closed' });
    const archived = investigation('north', { status: 'archived' });
    store.investigations.push(closed, archived);
    store.namedViews.push(view(closed, 1), view(archived, 2));
    const parsed = ownedViewListResponseSchema.parse((await list()).body);
    expect(parsed.items.map((item) => item.investigation.status)).toEqual(['archived', 'closed']);
    expect(parsed.count.value).toBe(2);
  });

  it('follows the cursor through every view once, also when a view is added between two calls', async () => {
    const { store, list } = await started();
    const owner = investigation('north');
    store.investigations.push(owner);
    store.namedViews.push(...Array.from({ length: 7 }, (_, index) => view(owner, index)));
    const first = ownedViewListResponseSchema.parse((await list('?limit=3')).body);
    expect(first.items).toHaveLength(3);
    store.namedViews.push(view(owner, 30));
    const seen = first.items.map((item) => item.id);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = ownedViewListResponseSchema.parse((await list(`?limit=3&cursor=${encodeURIComponent(cursor)}`)).body);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(7);
  });

  it('refuses a limit of 0, 101 and 1.5, an unknown parameter, and a cursor that is altered, expired or not its own', async () => {
    const { store, list, advance } = await started();
    const owner = investigation('north');
    store.investigations.push(owner);
    store.namedViews.push(...[1, 2, 3].map((seconds) => view(owner, seconds)));
    expect((await list('?limit=0')).body.error.code).toBe('INVALID_REQUEST');
    expect((await list('?limit=1.5')).body.error.code).toBe('INVALID_REQUEST');
    expect((await list('?other=1')).body.error.code).toBe('INVALID_REQUEST');
    const over = await list('?limit=101');
    expect(over.body.error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 100 } });
    expect(over.body.items).toBeUndefined();
    const real = ownedViewListResponseSchema.parse((await list('?limit=1')).body).nextCursor ?? '';
    const forCreated = createCursorCodec({ key: Buffer.alloc(32, 9), clock: () => Date.UTC(2026, 10, 5, 14) }).mint({ source: null, principal: OTHER_USER, policyVersion: 'none', filterHash: '', sort: 'created-desc', target: 'GET /v1/views', targetVersion: '1' }, { createdKey: '2026-11-05T13:00:01.000000Z', id: owner.id });
    for (const cursor of [`${real.slice(0, -2)}AA`, forCreated, 'junk']) {
      const answer = await list(`?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(answer.body.error.code).toBe('CURSOR_INVALIDATED');
      expect(answer.body.items).toBeUndefined();
    }
    advance(CURSOR_TTL_MS + 1);
    expect((await list(`?limit=1&cursor=${encodeURIComponent(real)}`)).body.error.code).toBe('CURSOR_INVALIDATED');
  });

  it('never lists another person\'s views, or those of a source the caller may not read', async () => {
    const { store, list } = await started();
    const mine = investigation('north');
    const theirs = investigation('north', { ownerId: OTHER_USER });
    const hidden = investigation('secret');
    store.investigations.push(mine, theirs, hidden);
    const wanted = view(mine, 1);
    store.namedViews.push(wanted, view(theirs, 2), view(hidden, 3));
    const parsed = ownedViewListResponseSchema.parse((await list()).body);
    expect(parsed.items.map((item) => item.id)).toEqual([wanted.id]);
    expect(parsed.count.value).toBe(1);
  });
});
