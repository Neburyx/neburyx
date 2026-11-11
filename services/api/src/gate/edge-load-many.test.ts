import { MAX_READ_REFS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent } from '../seams/seams.js';
import { gateRequest, harness, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { RELATED_ENTITIES } from '../testing/search-app.js';
import { onlineIndexesOf, relationshipRangeIndex } from '../testing/search-fixtures.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { EDGE_LOAD_MANY_ID, edgeLoadManyTemplate } from './templates/edge-load-many.js';

const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId', 'docId'] },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: RELATED_ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [edgeLoadManyTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const gadget = plainNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:2');
const row = (i: number, id: string, dup = false) => ({ i, dup, r: plainRelationship('MADE_FROM', widget, gadget, { linkId: id, recordId: `R-${id}` }, `5:s:${id}`), a: widget, b: gadget });
const TYPE = { type: 'MADE_FROM', from: 'widget', to: 'gadget' };
const batch = (...ids: string[]) => ({ ...TYPE, refs: ids.map((stableId) => ({ stableId })) });

function rig(rows: readonly Record<string, unknown>[]) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [...rows] }));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit, executor };
}

const load = (params: unknown, limit: number, overrides: { readonly mask?: boolean; readonly indexes?: typeof ONLINE | 'unverified' } = {}) =>
  gateRequest({ sourceId: source.id, templateId: EDGE_LOAD_MANY_ID, params, limit, indexes: overrides.indexes ?? ONLINE, ...(overrides.mask === undefined ? {} : { mask: overrides.mask }) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a batched edge read the gate refuses before any statement', () => {
  const REFUSED: readonly (readonly [string, unknown, number])[] = [
    ['an edge type the mapping does not name', { ...batch('L-1'), type: 'NOTHING' }, 1],
    ['an entity type used as an edge type', { ...batch('L-1'), type: 'widget' }, 1],
    ['ends the row does not map', { ...batch('L-1'), to: 'widget' }, 1],
    ['ends in the other direction', { ...batch('L-1'), from: 'gadget', to: 'widget' }, 1],
    ['a row with no stable ID', { type: 'NO_ID', from: 'widget', to: 'gadget', refs: [{ stableId: 'L-1' }] }, 1],
    ['a type with a backtick', { ...batch('L-1'), type: 'MADE_FROM` OR 1=1 //' }, 1],
    ['a field the template does not name', { ...batch('L-1'), property: 'linkId' }, 1],
    ['a field an ID does not have', { ...TYPE, refs: [{ stableId: 'L-1', extra: 1 }] }, 1],
    ['the single read’s parameter beside the list', { ...batch('L-1'), stableId: 'L-1' }, 1],
    ['an empty list', batch(), 1],
    ['a list that is not a list', { ...TYPE, refs: 'L-1' }, 1],
    ['more IDs than the limit of the request', batch('L-1', 'L-2', 'L-3'), 2],
  ];

  it.each(REFUSED)('refuses %s with INVALID_REQUEST and runs no statement', async (_name, params, limit) => {
    const { gate, executor } = rig([]);
    expect(await codeOf(gate.run(load(params, limit)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('holds a list to the most a call may ask, and to the page of the source', async () => {
    const ids = Array.from({ length: MAX_READ_REFS + 1 }, (_unused, index) => `L-${index}`);
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [] }));
    const large = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, budgetsFor: () => ({ ...DEFAULT_BUDGETS, maxPage: 500 }) });
    expect(await codeOf(large.gate.run(load(batch(...ids), MAX_READ_REFS + 1)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(await codeOf(large.gate.run(load(batch(...ids.slice(1)), MAX_READ_REFS)))).toBe('ok');
    const { gate } = rig([]);
    expect(await codeOf(gate.run(load(batch(...ids.slice(1)), MAX_READ_REFS)))).toBe('QUERY_BUDGET_EXCEEDED');
  });
});

describe('a batched edge read the gate runs', () => {
  it('writes the quoted names of the mapping row, gives the IDs as a list parameter, and audits one event', async () => {
    const { gate, executor, audit } = rig([row(0, 'L-1')]);
    await gate.run(load(batch('L-1', 'L-2'), 2));
    expect(executor.calls).toHaveLength(1);
    const [call] = executor.calls;
    expect(call?.cypher).toBe(
      'UNWIND range(0, size($refs) - 1) AS i CALL { WITH i MATCH (a:`Widget`)-[r:`MADE_FROM`]->(b:`Gadget`) USING INDEX SEEK r:`MADE_FROM`(`linkId`) WHERE r.`linkId` IN [$refs[i].stableId, $refs[i].stableInteger] RETURN r, a, b ORDER BY elementId(r) LIMIT 2 } WITH i, collect([r, a, b]) AS found RETURN i, found[0][0] AS r, found[0][1] AS a, found[0][2] AS b, size(found) > 1 AS dup ORDER BY i LIMIT $limit + 1',
    );
    expect(call?.cypher).not.toContain('L-1');
    expect(call?.parameters['refs']).toEqual([
      { stableId: 'L-1', stableInteger: null },
      { stableId: 'L-2', stableInteger: null },
    ]);
    expect(call?.parameters).not.toHaveProperty('type');
    expect(call?.rowLimit).toBe(3);
    expect(audit.map((event) => `${event.action} ${event.result}`)).toEqual(['edge.load success']);
  });

  it('matches a canonical 64-bit integer as the integer too, for each ID', async () => {
    const { gate, executor } = rig([]);
    await gate.run(load(batch('9007199254740993', 'L-1'), 2));
    const refs = executor.calls[0]?.parameters['refs'] as readonly { readonly stableInteger: unknown }[];
    expect(refs.map((entry) => entry.stableInteger)).toEqual([{ $type: 'integer', value: '9007199254740993' }, null]);
  });

  it('answers one item for each ID the source holds, with the position of the ID, and none for one it does not hold', async () => {
    const { gate } = rig([row(0, 'L-1'), row(2, 'L-3')]);
    const page = await gate.run(load(batch('L-1', 'L-2', 'L-3'), 3));
    expect(page.items.map((item) => item['index'])).toEqual([0, 2]);
    expect(page.items.map((item) => (item['edges'] as readonly { readonly ref: { readonly stableId: string } }[]).map((edge) => edge.ref.stableId))).toEqual([['L-1'], ['L-3']]);
  });

  it('flags only the edge whose type, ends and ID another relationship also has', async () => {
    const { gate } = rig([row(0, 'L-1', true), row(1, 'L-2')]);
    const page = await gate.run(load(batch('L-1', 'L-2'), 2));
    expect(page.items.map((item) => (item['edges'] as readonly { readonly qualityFlags: readonly string[] }[])[0]?.qualityFlags)).toEqual([['conflicting-duplicate'], []]);
  });

  it('answers an unreadable relationship as an internal error, never as a missing one', async () => {
    const { gate } = rig([{ ...row(0, 'L-1'), r: plainRelationship('MADE_FROM', widget, gadget, { linkId: null }, '5:s:x') }]);
    expect(await codeOf(gate.run(load(batch('L-1'), 1)))).toBe('INTERNAL_ERROR');
  });

  it('refuses more rows than the limit, since the list is bounded by it', async () => {
    const { gate } = rig([row(0, 'L-1'), row(1, 'L-2')]);
    expect(await codeOf(gate.run(load(batch('L-1'), 1)))).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['a position outside the list', [row(0, 'L-1'), row(2, 'L-3')]],
    ['a position twice', [row(0, 'L-1'), row(0, 'L-2')]],
    ['positions out of order', [row(1, 'L-2'), row(0, 'L-1')]],
  ])('refuses %s, never reading an edge as missing', async (_name, rows) => {
    const { gate } = rig(rows);
    expect(await codeOf(gate.run(load(batch('L-1', 'L-2'), 2)))).toBe('INTERNAL_ERROR');
  });

  it('keeps the same statement whether masking is asked or not', async () => {
    const plain = rig([row(0, 'L-1')]);
    await plain.gate.run(load(batch('L-1'), 1));
    const masked = rig([row(0, 'L-1')]);
    await masked.gate.run(load(batch('L-1'), 1, { mask: true }));
    expect(masked.executor.calls[0]?.cypher).toBe(plain.executor.calls[0]?.cypher);
  });
});

describe('the index the batched edge read needs', () => {
  it('names the relationship stable ID property, by type and ends', () => {
    expect(edgeLoadManyTemplate.indexNeeds?.(batch('L-1'), allowlist)).toEqual([{ relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'linkId', accepts: 'value' }]);
  });

  it.each(['POPULATING', 'FAILED'])('refuses the read before any statement when the index is %s', async (state) => {
    const entries = [...ONLINE.entries.filter((entry) => !(entry.entityType === 'RELATIONSHIP' && entry.name === 'MADE_FROM' && entry.property === 'linkId')), relationshipRangeIndex('MADE_FROM', 'linkId', state)];
    const { gate, executor } = rig([]);
    expect(await codeOf(gate.run(load(batch('L-1'), 1, { indexes: { sourceId: source.id, entries } })))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });
});
