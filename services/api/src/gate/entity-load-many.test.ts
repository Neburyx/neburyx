import { MAX_READ_REFS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { makeToken } from '../reference/token.js';
import type { AuditEvent } from '../seams/seams.js';
import { gateRequest, harness, TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf } from '../testing/search-fixtures.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { entityLoadManyTemplate, ENTITY_LOAD_MANY_ID } from './templates/entity-load-many.js';

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
];
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: [] })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);
const allowlist = allowlistFromMapping(source);
const catalog = createTemplateCatalog({ templates: [entityLoadManyTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };

const widget = (id: string, name = 'Ana Silva') => plainNode(['Widget'], { widgetId: id, ownerName: name }, `4:s:${id}`);
const ref = (stableId: string, entityType = 'widget', sourceId = 'demo') => ({ sourceId, entityType, stableId });
const row = (i: number, id: string, dup = false) => ({ i, dup, n: widget(id) });

function rig(rows: readonly Record<string, unknown>[]) {
  const audit: AuditEvent[] = [];
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [...rows] }));
  const parts = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } } });
  return { ...parts, audit, executor };
}

const load = (params: unknown, limit: number, mask = false) => gateRequest({ sourceId: source.id, templateId: ENTITY_LOAD_MANY_ID, params, limit, indexes: ONLINE, mask });
const batch = (...ids: string[]) => ({ entityType: 'widget', refs: ids.map((id) => ref(id)) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('a batched entity read the gate refuses before any statement', () => {
  const REFUSED: readonly (readonly [string, unknown, number, string])[] = [
    ['an entity type the mapping does not name', { entityType: 'nothing', refs: [ref('W-1', 'nothing')] }, 1, 'INVALID_REQUEST'],
    ['a backtick in the type', { entityType: 'widget` OR 1=1 //', refs: [ref('W-1', 'widget` OR 1=1 //')] }, 1, 'INVALID_REQUEST'],
    ['a reference of another entity type than the read names', { entityType: 'widget', refs: [ref('W-1'), ref('W-2', 'phone')] }, 2, 'INVALID_REQUEST'],
    ['a reference of another source', { entityType: 'widget', refs: [ref('W-1', 'widget', 'other')] }, 1, 'SOURCE_MISMATCH'],
    ['an empty list', { entityType: 'widget', refs: [] }, 1, 'INVALID_REQUEST'],
    ['more references than the limit of the request', batch('W-1', 'W-2', 'W-3'), 2, 'INVALID_REQUEST'],
    ['a field the template does not name', { ...batch('W-1'), extra: 1 }, 1, 'INVALID_REQUEST'],
    ['a field a reference does not have', { entityType: 'widget', refs: [{ ...ref('W-1'), extra: 1 }] }, 1, 'INVALID_REQUEST'],
    ['a list that is not a list', { entityType: 'widget', refs: 'W-1' }, 1, 'INVALID_REQUEST'],
    ['a stable ID that is not text', { entityType: 'widget', refs: [{ ...ref('W-1'), stableId: { $ne: 1 } }] }, 1, 'INVALID_REQUEST'],
  ];

  it.each(REFUSED)('refuses %s and runs no statement', async (_name, params, limit, expected) => {
    const { gate, executor } = rig([]);
    expect(await codeOf(gate.run(load(params, limit)))).toBe(expected);
    expect(executor.calls).toEqual([]);
  });

  it('holds the most a call may ask in one statement to the page of the source', async () => {
    const ids = Array.from({ length: MAX_READ_REFS }, (_unused, index) => `W-${index}`);
    const { gate, executor } = rig([]);
    expect(await codeOf(gate.run(load(batch(...ids), MAX_READ_REFS)))).toBe('QUERY_BUDGET_EXCEEDED');
    expect(executor.calls).toEqual([]);
  });

  it('holds a list to the most a call may ask even where the page of the source is larger', async () => {
    const ids = Array.from({ length: MAX_READ_REFS + 1 }, (_unused, index) => `W-${index}`);
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows' as const, rows: [] }));
    const { gate } = harness({ catalog, executor, modelFor: () => model, allowlistFor: () => allowlist, budgetsFor: () => ({ ...DEFAULT_BUDGETS, maxPage: 500 }) });
    expect(await codeOf(gate.run(load(batch(...ids), MAX_READ_REFS + 1)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(await codeOf(gate.run(load(batch(...ids.slice(1)), MAX_READ_REFS)))).toBe('ok');
  });
});

describe('a batched entity read the gate runs', () => {
  it('writes the quoted names of the mapping, gives the IDs as a list parameter and the list length as the limit, and audits one event', async () => {
    const { gate, executor, audit } = rig([row(0, 'W-1')]);
    await gate.run(load(batch('W-1', 'W-2'), 2));
    expect(executor.calls).toHaveLength(1);
    const [call] = executor.calls;
    expect(call?.cypher).toBe(
      'UNWIND range(0, size($refs) - 1) AS i CALL { WITH i MATCH (n:`Widget`) WHERE n.`widgetId` IN [$refs[i].stableId, $refs[i].stableInteger] RETURN n ORDER BY elementId(n) LIMIT 2 } WITH i, collect(n) AS found RETURN i, found[0] AS n, size(found) > 1 AS dup ORDER BY i LIMIT $limit + 1',
    );
    expect(call?.cypher).not.toContain('W-1');
    expect(call?.parameters['refs']).toEqual([
      { sourceId: 'demo', entityType: 'widget', stableId: 'W-1', stableInteger: null },
      { sourceId: 'demo', entityType: 'widget', stableId: 'W-2', stableInteger: null },
    ]);
    expect(call?.parameters).not.toHaveProperty('entityType');
    expect(call?.rowLimit).toBe(3);
    expect(audit.map((event) => `${event.action} ${event.result}`)).toEqual(['entity.load success']);
  });

  it('matches a canonical 64-bit integer as the integer too, for each ID', async () => {
    const { gate, executor } = rig([]);
    await gate.run(load(batch('9007199254740993', 'W-1'), 2));
    const refs = executor.calls[0]?.parameters['refs'] as readonly { readonly stableInteger: unknown }[];
    expect(refs.map((entry) => entry.stableInteger)).toEqual([{ $type: 'integer', value: '9007199254740993' }, null]);
  });

  it('answers one item for each ID the source holds, with the position of the ID, and none for one it does not hold', async () => {
    const { gate } = rig([row(0, 'W-1'), row(2, 'W-3')]);
    const page = await gate.run(load(batch('W-1', 'W-2', 'W-3'), 3));
    expect(page.items.map((item) => item['index'])).toEqual([0, 2]);
    expect(page.items.map((item) => (item['nodes'] as readonly { readonly ref: { readonly stableId: string } }[]).map((node) => node.ref.stableId))).toEqual([['W-1'], ['W-3']]);
    expect(page.hasMore).toBe(false);
  });

  it('flags only the node whose ID another node also has', async () => {
    const { gate } = rig([row(0, 'W-1', true), row(1, 'W-2')]);
    const page = await gate.run(load(batch('W-1', 'W-2'), 2));
    const flags = page.items.map((item) => (item['nodes'] as readonly { readonly qualityFlags: readonly string[] }[])[0]?.qualityFlags);
    expect(flags).toEqual([['duplicate-stable-id'], []]);
  });

  it('answers an unreadable record as an internal error, never as a missing one', async () => {
    const { gate } = rig([{ i: 0, dup: false, n: plainNode(['Widget'], { widgetId: null, ownerName: 'Ana Silva' }, '4:s:x') }]);
    expect(await codeOf(gate.run(load(batch('W-1'), 1)))).toBe('INTERNAL_ERROR');
  });

  it('refuses a row that does not name its position', async () => {
    const { gate } = rig([{ n: widget('W-1') }]);
    expect(await codeOf(gate.run(load(batch('W-1'), 1)))).toBe('INTERNAL_ERROR');
  });

  it('refuses more rows than the limit, since the list is bounded by it', async () => {
    const { gate } = rig([row(0, 'W-1'), row(1, 'W-2')]);
    expect(await codeOf(gate.run(load(batch('W-1'), 1)))).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['a position outside the list', [row(0, 'W-1'), row(2, 'W-3')]],
    ['a position twice', [row(0, 'W-1'), row(0, 'W-2')]],
    ['positions out of order', [row(1, 'W-2'), row(0, 'W-1')]],
  ])('refuses %s, never reading an element as missing', async (_name, rows) => {
    const { gate } = rig(rows);
    expect(await codeOf(gate.run(load(batch('W-1', 'W-2'), 2)))).toBe('INTERNAL_ERROR');
  });
});

describe('the masking of a batched entity read', () => {
  it('masks the personal-data fields of every node when asked, on the same statement', async () => {
    const plain = rig([row(0, 'W-1'), row(1, 'W-2', false)]);
    const masked = rig([row(0, 'W-1'), row(1, 'W-2', false)]);
    const shown = await plain.gate.run(load(batch('W-1', 'W-2'), 2));
    const hidden = await masked.gate.run(load(batch('W-1', 'W-2'), 2, true));
    expect(JSON.stringify(shown.items)).toContain('Ana Silva');
    expect(JSON.stringify(hidden.items)).not.toContain('Ana Silva');
    expect(hidden.items.map((item) => item['index'])).toEqual([0, 1]);
    expect(masked.executor.calls[0]?.cypher).toBe(plain.executor.calls[0]?.cypher);
  });
});

describe('a batched read of a keyed entity type', () => {
  const PHONE = '+1-212-555-0100';
  const token = (value: string, entityType = 'phone', sourceId = 'demo') => makeToken(TEST_REFERENCE_KEYS, { sourceId, entityType }, value);

  it('reads each token back to the value it stands for, and gives the statement the values only', async () => {
    const { gate, executor } = rig([]);
    await gate.run(load({ entityType: 'phone', refs: [ref(token(PHONE), 'phone'), ref(token('4155550100'), 'phone')] }, 2));
    const refs = executor.calls[0]?.parameters['refs'] as readonly { readonly stableId: string }[];
    expect(refs.map((entry) => entry.stableId)).toEqual([PHONE, '4155550100']);
    expect(JSON.stringify(executor.calls[0])).not.toContain(token(PHONE));
  });

  it.each([
    ['a raw value', () => PHONE],
    ['a token of another source', () => token(PHONE, 'phone', 'beta')],
    ['a token of another entity type', () => token(PHONE, 'widget')],
    ['a malformed token', () => 'p1.!!'],
  ])('refuses %s anywhere in the list and runs no statement', async (_name, bad) => {
    const { gate, executor } = rig([]);
    expect(await codeOf(gate.run(load({ entityType: 'phone', refs: [ref(token(PHONE), 'phone'), ref(bad(), 'phone')] }, 2)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });
});

describe('the index the batched entity read needs', () => {
  it('names the stable ID property of the entity type', () => {
    expect(entityLoadManyTemplate.indexNeeds?.({ entityType: 'widget' }, allowlist)).toEqual([{ entityType: 'widget', property: 'widgetId', accepts: 'value' }]);
  });

  it('refuses the read before any statement when the index is gone', async () => {
    const entries = ONLINE.entries.filter((entry) => !(entry.entityType === 'NODE' && entry.name === 'Widget'));
    const { gate, executor } = rig([]);
    const request = gateRequest({ sourceId: source.id, templateId: ENTITY_LOAD_MANY_ID, params: batch('W-1'), limit: 1, indexes: { sourceId: source.id, entries } });
    expect(await codeOf(gate.run(request))).toBe('SOURCE_UNAVAILABLE');
    expect(executor.calls).toEqual([]);
  });
});
