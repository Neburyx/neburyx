import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { deriveReferenceKeys } from '../reference/keys.js';
import { makeToken } from '../reference/token.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { createTemplateCatalog } from './catalog.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { CONTEXT_BRANCHES, contextBranchesOf } from './templates/related-context-statement.js';
import { RELATED_CONTEXT_ID, relatedContextTemplate, type RelatedContextItem } from './templates/related-context.js';

const mapping = mappingOf(
  sourceWith('demo', {
    entities: [
      { type: 'maker', label: 'Maker', stable_id: 'makerId' },
      { type: 'piece', label: 'Piece', stable_id: 'pieceId' },
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
      { type: 'lonely', label: 'Lonely', stable_id: 'lonelyId' },
    ],
    relationships: [
      { type: 'OWNS', from: 'maker', to: 'piece' },
      { type: 'KNOWS', from: 'maker', to: 'maker' },
      { type: 'USES', from: 'piece', to: 'phone' },
      { type: 'PAID', from: 'piece', to: 'piece' },
    ],
    derived: [],
  }),
);
const [found] = mapping.sources;
if (found === undefined) throw new Error('no source');
const source = found;
const allowlist = allowlistFromMapping(source);

const ref = (entityType: string, stableId: string, sourceId = 'demo') => ({ sourceId, entityType, stableId });
const HITS = [ref('maker', 'C-1'), ref('maker', 'C-2')];
const EXACT = [ref('piece', 'A-1'), ref('piece', 'A-2')];

const KEYS = deriveReferenceKeys(Buffer.alloc(32, 7));

function rig(answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] }), entries = onlineIndexesOf(source), keys = KEYS) {
  const events: AuditEvent[] = [];
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const defaults = communitySeams();
  const parts = testSourceGate(mapping, { executor, referenceKeys: keys, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } } });
  const read = (params: Record<string, unknown> = { hits: HITS, exact: EXACT }, limit = 25) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: RELATED_CONTEXT_ID, params, limit, indexes: { sourceId: 'demo', entries: entries.map((row) => ({ ...row })) } as never }));
  return { ...parts, read, executor, events };
}

const dataCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === RELATED_CONTEXT_ID);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

const rowOf = (hi: number, ei: number, rtype = 'OWNS', dir = 'out') => ({ hi, ei, bi: 0, rtype, dir });
const itemOf = (page: { readonly items: readonly unknown[] }) => page.items[0] as RelatedContextItem;

describe('the branches of the relationship context read', () => {
  const types = (...names: string[]) => new Set(names);

  it('are the mapping rows that join a type of the hits to a type of the exact matches, in the mapping order, `out` before `in`', () => {
    expect(contextBranchesOf(allowlist, types('maker'), types('piece')).map((branch) => `${branch.type}:${branch.direction}`)).toEqual(['OWNS:out']);
    expect(contextBranchesOf(allowlist, types('piece'), types('maker')).map((branch) => `${branch.type}:${branch.direction}`)).toEqual(['OWNS:in']);
    expect(contextBranchesOf(allowlist, types('maker'), types('maker')).map((branch) => `${branch.type}:${branch.direction}`)).toEqual(['KNOWS:out', 'KNOWS:in']);
    expect(contextBranchesOf(allowlist, types('maker', 'piece'), types('piece')).map((branch) => `${branch.type}:${branch.direction}`)).toEqual(['OWNS:out', 'PAID:out', 'PAID:in']);
  });

  it('are none for types no row joins', () => {
    expect(contextBranchesOf(allowlist, types('lonely'), types('piece'))).toEqual([]);
    expect(contextBranchesOf(allowlist, types('maker'), types('phone'))).toEqual([]);
  });
});

describe('the statement of the relationship context read', () => {
  it('writes quoted names from the mapping, binds both ends by their stable ID, and passes every value as a parameter', async () => {
    const { read, executor } = rig();
    await read();
    const [call] = dataCalls(executor);
    expect(call?.cypher).toContain('MATCH (a:`Maker`) WHERE a.`makerId` IN [h.stableId, h.stableInteger]');
    expect(call?.cypher).toContain('MATCH (m:`Piece`) WHERE m.`pieceId` IN [e.stableId, e.stableInteger] AND a <> m AND EXISTS { (a)-[:`OWNS`]->(m) }');
    expect(call?.cypher).toMatch(/LIMIT \$limit \+ 1\s*$/);
    for (const value of ['C-1', 'C-2', 'A-1', 'A-2']) expect(call?.cypher).not.toContain(value);
    expect(call?.parameters['hits']).toMatchObject([{ entityType: 'maker', stableId: 'C-1' }, { entityType: 'maker', stableId: 'C-2' }]);
    expect(call?.parameters[CONTEXT_BRANCHES]).toEqual([{ hitType: 'maker', exactType: 'piece', type: 'OWNS', direction: 'out' }]);
    expect(call?.parameters).toMatchObject({ limit: 25 });
    expect(call?.accessMode).toBe('READ');
  });

  it('is one statement for several branches, ordered by branch and then by exact match, with one row for each hit', async () => {
    const { read, executor } = rig();
    await read({ hits: [ref('maker', 'C-1'), ref('piece', 'A-9')], exact: [ref('piece', 'A-1'), ref('maker', 'C-5')] });
    const [call] = dataCalls(executor);
    expect(call?.cypher).toContain(' UNION ALL ');
    expect(call?.cypher).toContain('WITH hi, bi, ei, rtype, dir ORDER BY hi, bi, ei');
    expect(call?.cypher).toContain('collect([bi, ei, rtype, dir])[0] AS best');
    expect(call?.cypher).toContain('(a)<-[:`KNOWS`]-(m)');
    expect(call?.cypher).toContain('(a)-[:`PAID`]->(m)');
  });

  it('never pairs a hit with itself', async () => {
    const { read, executor } = rig();
    await read({ hits: [ref('piece', 'A-1')], exact: [ref('piece', 'A-1')] });
    expect(dataCalls(executor)[0]?.cypher).toContain('a <> m');
  });
});

describe('the answer of the relationship context read', () => {
  it('names the hit and the exact match by position, with the relationship type and the direction, and no value', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [rowOf(0, 1), rowOf(1, 0, 'KNOWS', 'in')] }));
    const page = await read();
    expect(itemOf(page).context).toEqual([
      { hit: 0, exact: 1, relationshipType: 'OWNS', direction: 'out' },
      { hit: 1, exact: 0, relationshipType: 'KNOWS', direction: 'in' },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/C-1|A-1/);
  });

  it('answers an empty list when nothing is related', async () => {
    const { read } = rig();
    expect(itemOf(await read()).context).toEqual([]);
  });

  it('refuses a row it cannot read, and a read that returns more rows than the limit', async () => {
    expect(await codeOf(rig(() => ({ status: 'rows', rows: [{ hi: 'x' }] })).read())).toBe('INTERNAL_ERROR');
    expect(await codeOf(rig(() => ({ status: 'rows', rows: [rowOf(0, 0), rowOf(1, 0), rowOf(1, 1)] })).read(undefined, 2))).toBe('INTERNAL_ERROR');
  });
});

describe('what the relationship context read refuses', () => {
  it.each([
    ['more hits than the limit', { hits: Array.from({ length: 26 }, (_, index) => ref('maker', `C-${index}`)), exact: EXACT }, 25],
    ['more exact matches than the limit', { hits: HITS, exact: Array.from({ length: 26 }, (_, index) => ref('piece', `A-${index}`)) }, 25],
    ['a list longer than the limit of the request', { hits: [ref('maker', 'C-1'), ref('maker', 'C-2'), ref('maker', 'C-3')], exact: EXACT }, 2],
  ])('%s as INVALID_REQUEST, and reads nothing', async (_name, params, limit) => {
    const { read, executor } = rig();
    expect(await codeOf(read(params, limit))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toEqual([]);
  });

  it('refuses a reference of another source as SOURCE_MISMATCH, an unmapped entity type, a wrong shape and a name the request should not hold, and reads nothing', async () => {
    const { read, executor } = rig();
    expect(await codeOf(read({ hits: [ref('maker', 'C-1', 'other')], exact: EXACT }))).toBe('SOURCE_MISMATCH');
    expect(await codeOf(read({ hits: [ref('nothing', 'C-1')], exact: EXACT }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: [{ entityType: 'maker' }], exact: EXACT }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: [{ ...ref('maker', 'C-1'), label: 'X`) DETACH DELETE (n' }], exact: EXACT }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: 'C-1', exact: EXACT }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: HITS, exact: EXACT, branches: [] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: HITS }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toEqual([]);
  });

  it('reads nothing, and answers an empty list, for no hit, no exact match, or types no mapping row joins', async () => {
    const { read, executor } = rig();
    expect(itemOf(await read({ hits: [], exact: EXACT })).context).toEqual([]);
    expect(itemOf(await read({ hits: HITS, exact: [] })).context).toEqual([]);
    expect(itemOf(await read({ hits: [ref('lonely', 'L-1')], exact: EXACT })).context).toEqual([]);
    expect(dataCalls(executor)).toEqual([]);
  });

  it('refuses before any data statement when an end has no online stable-ID index', async () => {
    const entries = onlineIndexesOf(source).filter((row) => !JSON.stringify(row).includes('pieceId'));
    const { read, executor } = rig(undefined, entries);
    expect(await codeOf(read())).toBe('SOURCE_UNAVAILABLE');
    expect(dataCalls(executor)).toEqual([]);
  });
});

describe('the relationship context read of a keyed entity type', () => {
  it('reads the token of a keyed end back to its value, and refuses the raw value, a junk token and a token of another deployment', async () => {
    const { read, executor } = rig();
    const token = makeToken(KEYS, { sourceId: 'demo', entityType: 'phone' }, '+1-212-555-0100');
    expect(await codeOf(read({ hits: [ref('piece', 'A-1')], exact: [ref('phone', token)] }))).toBe('ok');
    expect(JSON.stringify(dataCalls(executor)[0]?.parameters['exact'])).toContain('+1-212-555-0100');
    const before = dataCalls(executor).length;
    expect(await codeOf(read({ hits: [ref('piece', 'A-1')], exact: [ref('phone', '+1-212-555-0100')] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: [ref('piece', 'A-1')], exact: [ref('phone', 'p1.junk')] }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ hits: [ref('piece', 'A-1')], exact: [ref('phone', makeToken(deriveReferenceKeys(Buffer.alloc(32, 9)), { sourceId: 'demo', entityType: 'phone' }, '+1-212-555-0100'))] }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toHaveLength(before);
  });
});

describe('the record of the relationship context read', () => {
  it('is the audit action `entity.search_context`, holds no value, and counts as one read', async () => {
    const { read, events, executor } = rig();
    await read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'entity.search_context', result: 'success', sourceId: 'demo' });
    expect(JSON.stringify(events)).not.toMatch(/C-1|A-1/);
    expect(dataCalls(executor)).toHaveLength(1);
  });
});

describe('the catalog check of the relationship context template', () => {
  it('accepts the template and refuses one that is paged, unbounded, or does not list its reference lists', () => {
    expect(defaultCatalog().find(RELATED_CONTEXT_ID)).toBeDefined();
    const check = (change: object) => () => createTemplateCatalog({ templates: [{ ...relatedContextTemplate, ...change }] });
    expect(check({})).not.toThrow();
    expect(check({ rows: undefined, cutMeans: 'lowerBound' })).toThrow(/related context/);
    expect(check({ referenceLists: ['hits'] })).toThrow(/reference lists/);
    expect(check({ cypher: 'MATCH (n) RETURN n' })).toThrow(/related context/);
    expect(check({ readsNothing: undefined })).toThrow(/empty case/);
    expect(check({ referenceParams: { entityType: 'hits', stableId: 'exact' } })).toThrow(/reference lists and reference parameters/);
  });
});
