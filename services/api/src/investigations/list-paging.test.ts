import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { investigationListResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createCursorCodec, CURSOR_TTL_MS, type CursorBinding } from '../gate/cursor/codec.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_IDENTITY, memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }];
const sources = [baseSource({ id: 'north', uri: 'neo4j+s://north.example.test:7687', entities, relationships: [] }), baseSource({ id: 'south', uri: 'neo4j+s://south.example.test:7687', entities, relationships: [] })];
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');

let counter = 0;
function row(sourceId: string, minutes: number, overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  counter += 1;
  const found = mapping.sources.find((source) => source.id === sourceId);
  const at = new Date(Date.UTC(2026, 10, 5, 12, 0, minutes)).toISOString();
  return {
    id: `0192f000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    sourceId,
    sourceIdentityHash: found === undefined ? 'retired' : identityHashOf(found),
    ownerId: LOCAL_IDENTITY.principal.id,
    title: `Widget W-${counter}`,
    caseRef: null,
    startingEntityType: 'widget',
    startingStableId: `W-${counter}`,
    status: 'open',
    createdAt: at,
    lastEditedAt: at,
    closedAt: null,
    archivedAt: null,
    version: 1,
    ...overrides,
  };
}

const filterHashOf = (parts: readonly (string | null)[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

async function started() {
  let now = Date.UTC(2026, 10, 5, 13);
  const key = Buffer.alloc(32, 7);
  const cursors = createCursorCodec({ key, clock: () => now });
  const store = memoryAppStore();
  const seams = communitySeams();
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, seams, cursors, gate: testSourceGate(mapping, { executor, seams }).gate });
  const list = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: `/v1/investigations${query}` });
    return { status: response.statusCode, body: response.json() };
  };
  const walk = async (query: string): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status).toBe(200);
      const parsed = investigationListResponseSchema.parse(page.body);
      seen.push(...parsed.items.map((item) => item.id));
      cursor = parsed.nextCursor;
    } while (cursor !== null);
    return seen;
  };
  return { store, list, walk, cursors, executor, advance: (ms: number) => void (now += ms) };
}

const bindingOf = (filters: readonly (string | null)[], overrides: Partial<CursorBinding> = {}): CursorBinding => ({ source: null, principal: LOCAL_IDENTITY.principal.id, policyVersion: 'none', filterHash: filterHashOf(filters), sort: 'last-edited-desc', target: 'GET /v1/investigations', targetVersion: '1', ...overrides });

describe('paging the list with a signed cursor', () => {
  it('reaches all 60 investigations once, 25 a page, newest first', async () => {
    const { store, list, walk } = await started();
    const rows = Array.from({ length: 60 }, (_, index) => row('north', index));
    store.investigations.push(...rows);
    const first = investigationListResponseSchema.parse((await list()).body);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    expect(first.matching).toEqual({ value: 60, quality: 'exact', scope: 'investigations-matching' });
    const seen = await walk('?');
    expect(seen).toEqual([...rows].reverse().map((entry) => entry.id));
  });

  it('keeps the rows with equal edit times in id order across a page boundary', async () => {
    const { store, walk } = await started();
    const rows = Array.from({ length: 7 }, () => row('north', 5));
    store.investigations.push(...rows);
    expect(await walk('?limit=3')).toEqual([...rows].sort((left, right) => (left.id < right.id ? 1 : -1)).map((entry) => entry.id));
  });

  it('never repeats a row when one is added or an unseen one is edited between two pages', async () => {
    const { store, list } = await started();
    const rows = Array.from({ length: 6 }, (_, index) => row('north', index));
    store.investigations.push(...rows);
    const first = investigationListResponseSchema.parse((await list('?limit=3')).body);
    const added = row('north', 50);
    store.investigations.push(added);
    const edited = rows[0];
    if (edited === undefined) throw new Error('no row');
    store.investigations[store.investigations.indexOf(edited)] = { ...edited, lastEditedAt: new Date(Date.UTC(2026, 10, 5, 12, 0, 40)).toISOString() };
    const second = investigationListResponseSchema.parse((await list(`?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).body);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(added.id);
    expect((await list('?limit=3')).body.items[0].id).toBe(added.id);
  });

  it('answers a Home call of 5 with no cursor on the last page', async () => {
    const { store, list } = await started();
    store.investigations.push(...Array.from({ length: 5 }, (_, index) => row('north', index)));
    const answer = investigationListResponseSchema.parse((await list('?limit=5&sort=lastEdited')).body);
    expect(answer.items).toHaveLength(5);
    expect(answer.nextCursor).toBeNull();
    expect(answer.counts.investigations.value).toBe(5);
  });

  it('refuses a limit of 0 with INVALID_REQUEST and a limit of 101 with QUERY_BUDGET_EXCEEDED naming the maximum', async () => {
    const { list, executor } = await started();
    for (const query of ['?limit=0', '?limit=-1', '?limit=x', '?limit=1.5', '?limit=']) {
      const answer = await list(query);
      expect(answer.body.error.code, query).toBe('INVALID_REQUEST');
    }
    const over = await list('?limit=101');
    expect(over.body.error.code).toBe('QUERY_BUDGET_EXCEEDED');
    expect(over.body.error.details).toEqual({ maxPage: 100 });
    expect(over.body.items).toBeUndefined();
    expect(executor.calls).toHaveLength(0);
  });

  it('accepts a limit of 100 and a limit of 1', async () => {
    const { store, list } = await started();
    store.investigations.push(...Array.from({ length: 3 }, (_, index) => row('north', index)));
    expect((await list('?limit=100')).body.items).toHaveLength(3);
    expect((await list('?limit=1')).body.items).toHaveLength(1);
  });

  it('refuses an altered cursor, one past its life, one minted for another person, route, policy version or sort, and returns no row', async () => {
    const { store, list, cursors, advance } = await started();
    store.investigations.push(...Array.from({ length: 4 }, (_, index) => row('north', index)));
    const real = investigationListResponseSchema.parse((await list('?limit=2')).body).nextCursor ?? '';
    const position = { editedKey: '2026-11-05T12:00:01.000000Z', id: '0192f000-0000-7000-8000-000000000001' };
    const filters = ['open', null, null];
    const foreign = [
      `${real.slice(0, -2)}AA`,
      cursors.mint(bindingOf(filters, { principal: '0192f000-0000-7000-8000-0000000000ff' }), position),
      cursors.mint(bindingOf(filters, { target: 'GET /v1/views' }), position),
      cursors.mint(bindingOf(filters, { policyVersion: 'another' }), position),
      cursors.mint(bindingOf(filters, { sort: 'name' }), position),
      'not-a-cursor',
    ];
    for (const cursor of foreign) {
      const answer = await list(`?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(answer.body.error.code).toBe('CURSOR_INVALIDATED');
      expect(answer.body.items).toBeUndefined();
    }
    advance(CURSOR_TTL_MS + 1);
    expect((await list(`?limit=2&cursor=${encodeURIComponent(real)}`)).body.error.code).toBe('CURSOR_INVALIDATED');
  });

  it('reads no source and holds no property value', async () => {
    const { store, list, executor } = await started();
    store.investigations.push(row('north', 1));
    const answer = await list();
    expect(executor.calls).toHaveLength(0);
    expect(Object.keys(answer.body.items[0]).sort()).toEqual(['caseRef', 'createdAt', 'edgeCount', 'id', 'lastEditedAt', 'nodeCount', 'save', 'sourceAlias', 'sourceId', 'sourceState', 'startingEntity', 'status', 'title', 'version']);
  });
});

describe('filtering the list', () => {
  it('lists open investigations when no status is given, and only those of the status asked for', async () => {
    const { store, list } = await started();
    const open = row('north', 1);
    const closed = row('north', 2, { status: 'closed' });
    const archived = row('north', 3, { status: 'archived' });
    store.investigations.push(open, closed, archived);
    const ids = async (query: string): Promise<string[]> => (await list(query)).body.items.map((item: { id: string }) => item.id);
    expect(await ids('')).toEqual([open.id]);
    expect(await ids('?status=open')).toEqual([open.id]);
    expect(await ids('?status=closed')).toEqual([closed.id]);
    expect(await ids('?status=archived')).toEqual([archived.id]);
    expect((await list('?status=deleted')).body.error.code).toBe('INVALID_REQUEST');
    expect((await list('?status=')).body.error.code).toBe('INVALID_REQUEST');
  });

  it('narrows to one source, and answers an empty list for a source that is unknown', async () => {
    const { store, list } = await started();
    const north = row('north', 1);
    const south = row('south', 2);
    store.investigations.push(north, south);
    expect((await list('?source=south')).body.items.map((item: { id: string }) => item.id)).toEqual([south.id]);
    const unknown = await list('?source=nowhere');
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
    expect(unknown.body.matching.value).toBe(0);
  });

  it('finds a row by a fragment of its title or of its case reference, whatever the case', async () => {
    const { store, list } = await started();
    const byTitle = row('north', 1, { title: 'Mule account sweep' });
    const byReference = row('north', 2, { caseRef: 'REF-2026-0042' });
    store.investigations.push(byTitle, byReference, row('north', 3));
    const ids = async (query: string): Promise<string[]> => (await list(query)).body.items.map((item: { id: string }) => item.id);
    expect(await ids('?q=ACCOUNT')).toEqual([byTitle.id]);
    expect(await ids('?q=26-00')).toEqual([byReference.id]);
    expect(await ids('?q=ref-2026')).toEqual([byReference.id]);
    expect(await ids('?q=zzz')).toEqual([]);
  });

  it.each([['q=a'], [`q=${'x'.repeat(201)}`], ['q=%00ab'], ['q='], ['other=1'], ['status=open&status=closed']])('refuses the query %s with INVALID_REQUEST', async (query) => {
    const { list } = await started();
    const answer = await list(`?${query}`);
    expect(answer.body.error.code).toBe('INVALID_REQUEST');
  });

  it('says how many rows the filters select, exactly, while the library counts stay as they are', async () => {
    const { store, list } = await started();
    store.investigations.push(...Array.from({ length: 4 }, (_, index) => row('north', index, { title: `Match ${index}` })), row('south', 9), row('north', 10, { status: 'closed' }));
    const filtered = investigationListResponseSchema.parse((await list('?limit=2&q=match')).body);
    const plain = investigationListResponseSchema.parse((await list()).body);
    expect(filtered.matching).toEqual({ value: 4, quality: 'exact', scope: 'investigations-matching' });
    expect(filtered.counts).toEqual(plain.counts);
    expect(plain.counts.investigations.value).toBe(5);
  });

  it('continues with the same filters and refuses the cursor with any other', async () => {
    const { store, list } = await started();
    store.investigations.push(...Array.from({ length: 5 }, (_, index) => row('north', index, { title: `Match ${index}` })));
    const first = investigationListResponseSchema.parse((await list('?limit=2&q=match')).body);
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    expect((await list(`?limit=2&q=match&cursor=${cursor}`)).status).toBe(200);
    for (const other of ['?limit=2&q=matc', '?limit=2&status=closed', '?limit=2&source=north', '?limit=2']) {
      const answer = await list(`${other}&cursor=${cursor}`);
      expect(answer.body.error.code, other).toBe('CURSOR_INVALIDATED');
    }
  });

  it('keeps another person\'s and a hidden row out of every filter', async () => {
    const { store, list } = await started();
    store.investigations.push(row('north', 1, { ownerId: '0192f000-0000-7000-8000-000000000002', title: 'Match' }), row('north', 2, { title: 'Match' }));
    expect((await list('?q=match')).body.items).toHaveLength(1);
  });
});
