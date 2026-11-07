import { describe, expect, it } from 'vitest';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { context, plainNode, twinSource } from '../../testing/normalize-fixtures.js';
import { normalizeModelOf } from './model.js';
import { expectedTypesOf, normalizeRows } from './index.js';

const rows = (...nodes: ReturnType<typeof plainNode>[]) => nodes.map((n) => ({ n }));

describe('a node the mapping does not describe', () => {
  it('is dropped as not mapped when none of its labels is mapped, and counted', () => {
    const result = normalizeRows(context(), rows(plainNode(['Stranger'], { id: '1' }), plainNode([], {})));
    expect(result.nodes).toEqual([]);
    expect(result.dropped).toEqual({ 'not-mapped': 2, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(result.warnings).toEqual(["2 rows were left out because they are not part of this source's mapping."]);
  });

  it('is dropped as ambiguous when its labels match two entity types, also when two types share a label', () => {
    const shared = context({ model: normalizeModelOf(twinSource) });
    const result = normalizeRows(shared, rows(plainNode(['Gadget', 'Person'], { gadgetId: 'g', personId: 'p' }), plainNode(['Gadget'], { gadgetId: 'g', twinId: 't' })));
    expect(result.nodes).toEqual([]);
    expect(result.dropped['ambiguous-type']).toBe(2);
    expect(result.warnings).toEqual(['2 rows were left out because their labels match more than one entity type.']);
  });

  it.each([
    ['absent', {}],
    ['null', { personId: null }],
    ['empty text', { personId: '' }],
    ['a fraction', { personId: 1.5 }],
    ['a float tag', { personId: { $type: 'float', value: 'NaN' } }],
    ['a list', { personId: ['a'] }],
    ['a date', { personId: { $type: 'date', value: '2026-01-02' } }],
    ['a number beyond the safe range', { personId: 2 ** 60 }],
  ])('is listed as an unreferenced hit, counted as having no stable ID, when the property is %s', (_name, properties) => {
    const result = normalizeRows(context(), rows(plainNode(['Person'], properties)));
    expect(result.nodes).toEqual([]);
    expect(result.unreferenced).toHaveLength(1);
    expect(result.unreferenced[0]).toMatchObject({ entityType: 'person', reason: 'no-stable-id' });
    expect(Object.keys(result.unreferenced[0] ?? {}).sort()).toEqual(['entityType', 'properties', 'reason', 'title']);
    expect(result.dropped['no-stable-id']).toBe(1);
    expect(result.warnings).toEqual(['1 row has no usable stable ID, so it is listed and cannot be opened or added.']);
  });

  it('writes one sentence for each reason that occurred, in a fixed order, with the count and no value, label or ID', () => {
    const result = normalizeRows(
      context(),
      rows(plainNode(['Stranger'], { id: 'SECRET-ID' }), plainNode(['Person'], { personId: '' }), plainNode(['Gadget', 'Person'], { gadgetId: 'SECRET-ID' }), plainNode(['Person'], { personId: 'p1' })),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.warnings).toEqual([
      "1 row was left out because they are not part of this source's mapping.",
      '1 row was left out because their labels match more than one entity type.',
      '1 row has no usable stable ID, so it is listed and cannot be opened or added.',
    ]);
    expect(JSON.stringify(result.warnings)).not.toMatch(/SECRET|Stranger|Gadget|Person/);
  });

  it('is never repaired: the other rows of the page are kept and nothing is made up', () => {
    const result = normalizeRows(context(), rows(plainNode(['Person'], {}), plainNode(['Person'], { personId: 'kept' })));
    expect(result.nodes.map((node) => node.ref.stableId)).toEqual(['kept']);
    expect(result.unreferenced.map((hit) => hit.entityType)).toEqual(['person']);
  });

  it('is titled by its title template, or by its entity type alone when a placeholder has no value, never by a made-up ID', () => {
    const result = normalizeRows(context(), rows(plainNode(['Gadget'], { gadgetId: 1.5, title: 'Lamp' }), plainNode(['Gadget'], { gadgetId: 1.5 })));
    expect(result.unreferenced.map((hit) => hit.title)).toEqual(['Gadget Lamp', 'gadget']);
  });

  it('gives a listed record its own sentence, and puts a relationship whose stable ID cannot be used in the aggregate of its ends, flagged', () => {
    const p1 = plainNode(['Person'], { personId: 'p1' });
    const p2 = plainNode(['Person'], { personId: 'p2' });
    const knows = { $type: 'relationship' as const, elementId: 'r-x', type: 'KNOWS', startElementId: p1.elementId, endElementId: p2.elementId, properties: {} };
    const result = normalizeRows(context(), [{ a: p1, r: knows, b: p2 }, { n: plainNode(['Person'], {}) }]);
    expect(result.dropped['no-stable-id']).toBe(1);
    expect(result.unreferenced).toHaveLength(1);
    expect(result.edges.map((edge) => edge.qualityFlags)).toEqual([['no-stable-id']]);
    expect(result.warnings).toEqual(['1 row has no usable stable ID, so it is listed and cannot be opened or added.']);
  });
});

describe('a node whose labels match two entity types', () => {
  const twins = context({ model: normalizeModelOf(twinSource) });
  const both = plainNode(['Gadget'], { gadgetId: 'g1', twinId: 't1' });

  it('is resolved as the type a row asks for, with that type\'s stable ID, and is not counted as dropped', () => {
    const read = [{ n: both, entityTypes: ['twin'] }];
    const result = normalizeRows(twins, read, expectedTypesOf(read, (row) => (Array.isArray(row['entityTypes']) ? row['entityTypes'].map(String) : undefined)));
    expect(result.nodes.map((node) => node.ref)).toEqual([{ sourceId: 'request-source', entityType: 'twin', stableId: 't1' }]);
    expect(result.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
  });

  it('is one node of each type the rows ask for', () => {
    const asked = (row: Readonly<Record<string, unknown>>) => (Array.isArray(row['entityTypes']) ? row['entityTypes'].map(String) : undefined);
    const read = [{ n: both, entityTypes: ['gadget', 'twin'] }];
    const result = normalizeRows(twins, read, expectedTypesOf(read, asked));
    expect(result.nodes.map((node) => [node.ref.entityType, node.ref.stableId])).toEqual([
      ['gadget', 'g1'],
      ['twin', 't1'],
    ]);
    const splitRows = [{ n: both, entityTypes: ['gadget'] }, { n: both, entityTypes: ['twin'] }];
    const split = normalizeRows(twins, splitRows, expectedTypesOf(splitRows, asked));
    expect(split.nodes.map((node) => node.ref.entityType)).toEqual(['gadget', 'twin']);
  });

  it('is resolved as the type the read asks for every node of', () => {
    const read = rows(both);
    const result = normalizeRows(twins, read, expectedTypesOf(read, () => ['gadget']));
    expect(result.nodes.map((node) => node.ref)).toEqual([{ sourceId: 'request-source', entityType: 'gadget', stableId: 'g1' }]);
  });

  it('is left out as ambiguous-type, counted, when the read asks for no type', () => {
    const result = normalizeRows(twins, rows(both));
    expect(result.nodes).toEqual([]);
    expect(result.dropped['ambiguous-type']).toBe(1);
  });

  it('is an unreferenced hit of the asked type when that type\'s stable ID is not usable', () => {
    const read = rows(plainNode(['Gadget'], { gadgetId: 'g1', twinId: 2.5 }));
    const result = normalizeRows(twins, read, expectedTypesOf(read, () => ['twin']));
    expect(result.nodes).toEqual([]);
    expect(result.unreferenced).toEqual([{ entityType: 'twin', title: '2.5', properties: [{ key: 'twinId', value: 2.5, dataClass: 'number', masked: false }], reason: 'no-stable-id' }]);
  });
});

describe('the identity of a node', () => {
  it('is under the sourceId of the request, whatever the record says', () => {
    const [node] = normalizeRows(context({ sourceId: 'mine' }), rows(plainNode(['Person'], { personId: 'p1', sourceId: 'another-source' }))).nodes;
    expect(node?.ref).toEqual({ sourceId: 'mine', entityType: 'person', stableId: 'p1' });
  });

  it.each([
    ['a safe integer', 42, '42'],
    ['a negative integer', -7, '-7'],
    ['an integer beyond the safe range', { $type: 'integer', value: '9223372036854775807' }, '9223372036854775807'],
    ['text', 'p-1', 'p-1'],
  ])('is the exact decimal text for %s', (_name, value, text) => {
    const [node] = normalizeRows(context(), rows(plainNode(['Person'], { personId: value }))).nodes;
    expect(node?.ref.stableId).toBe(text);
  });
});

describe('the rows of another pack', () => {
  it.each(PACKS)('captured from the made records of the %s pack: the node without a stable ID and the node with a label only the other pack maps are dropped, the one lacking key properties is kept and flagged', (pack) => {
    const made = readFixture(pack)['made'] as Record<string, unknown>[];
    const result = normalizeRows({ sourceId: 'x', hasMore: false, model: normalizeModelOf(packSource(pack)) }, made);
    expect(result.dropped).toEqual({ 'not-mapped': 1, 'ambiguous-type': 0, 'no-stable-id': 1 });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.qualityFlags).toContain('missing-property');
    expect(result.nodes[0]?.properties.some((property) => property.dataClass === 'unknown' && property.value === undefined)).toBe(true);
  });

  it.each(PACKS)('captured from the other pack: every node of the %s pack is dropped as not mapped by the other', (pack) => {
    const other = PACKS.find((candidate) => candidate !== pack) as (typeof PACKS)[number];
    const nodes = readFixture(other)['node'] as Record<string, unknown>[];
    const result = normalizeRows({ sourceId: 'x', hasMore: false, model: normalizeModelOf(packSource(pack)) }, nodes);
    expect(result.nodes).toEqual([]);
    expect(result.dropped['not-mapped']).toBe(nodes.length);
  });
});
