import { describe, expect, it } from 'vitest';
import { nodeSchema } from '@neburyx/contracts';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { context, plainNode } from '../../testing/normalize-fixtures.js';
import { normalizeRows } from './index.js';
import { mappingOf, sourceWith } from '../../testing/gate-fixtures.js';
import type { SourceModel } from '../../mapping/model.js';
import { normalizeModelOf } from './model.js';

const REQUEST = 'request-source';

describe.each(PACKS)('a node captured from the %s pack', (pack) => {
  const source = packSource(pack);
  const [entity] = source.entities;
  const context = { sourceId: REQUEST, hasMore: false, model: normalizeModelOf(source) };
  const captured = readFixture(pack)['node'] as Record<string, unknown>[];
  const plain = (captured[0] ?? {})['n'] as { properties: Record<string, unknown> };

  it('becomes a Node with the identity the mapping gives it, under the sourceId of the request', () => {
    const result = normalizeRows(context, captured);
    expect(result.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(result.warnings).toEqual([]);
    const [node] = result.nodes;
    expect(result.nodes).toHaveLength(1);
    expect(nodeSchema.safeParse(node).success).toBe(true);
    expect(node?.ref).toEqual({ sourceId: REQUEST, entityType: entity?.type, stableId: String(plain.properties[entity?.stableId ?? '']) });
    expect(node?.display.type).toBe(entity?.type);
    expect(node?.authorization).toEqual({ canInspect: true, canExport: true });
    expect(node?.qualityFlags).toEqual([]);
    expect(node?.provenanceRefs).toEqual([]);
    expect(node && 'technicalId' in node.ref).toBe(false);
  });

  it('has a title filled from the title template of its entity type', () => {
    const [node] = normalizeRows(context, captured).nodes;
    const expected = (entity?.title ?? '').replace(/\{([^{}]*)\}/g, (_whole, key: string) => String(plain.properties[key]));
    expect(node?.display.title).toBe(expected);
  });

  it('has only properties the mapping names, each unmasked, with the kind of its value', () => {
    const [node] = normalizeRows(context, captured).nodes;
    const named = new Set([entity?.stableId, ...(entity?.titleProperties ?? []), ...(entity?.search ?? []), ...(entity?.reference ?? []), ...(entity?.pii ?? []), ...(entity?.filterable ?? []), ...(entity?.display.keyProperties ?? []), entity?.display.stateProperty]);
    expect(node?.properties.length).toBeGreaterThan(0);
    for (const property of node?.properties ?? []) {
      expect(named.has(property.key)).toBe(true);
      expect(property.masked).toBe(false);
    }
  });

  it('shows no property that the mapping does not name', () => {
    const named = new Set([entity?.stableId, ...(entity?.titleProperties ?? []), ...(entity?.search ?? []), ...(entity?.reference ?? []), ...(entity?.pii ?? []), ...(entity?.filterable ?? []), ...(entity?.display.keyProperties ?? []), entity?.display.stateProperty]);
    const row = { n: { ...(captured[0] as { n: object }).n, properties: { ...plain.properties, unmapped_zz: 'secret', other_zz: 4 } } };
    const [node] = normalizeRows(context, [row]).nodes;
    expect((node?.properties ?? []).map((property) => property.key).every((key) => named.has(key))).toBe(true);
    expect(JSON.stringify(node)).not.toContain('secret');
  });
});

describe('the properties and the title of a node', () => {
  const rows = (properties: Record<string, unknown>) => [{ n: plainNode(['Gadget'], { gadgetId: 'g1', ...properties }) }];

  it('fills the title from the template, and falls back to the type and the stable ID with a flag when a placeholder has no value', () => {
    const [full] = normalizeRows(context(), rows({ title: 'Lamp', kind: 'k', madeOn: '2026' })).nodes;
    expect(full?.display.title).toBe('Gadget Lamp');
    expect(full?.qualityFlags).toEqual([]);
    const [bare] = normalizeRows(context(), rows({ kind: 'k', madeOn: '2026' })).nodes;
    expect(bare?.display.title).toBe('gadget g1');
    expect(bare?.qualityFlags).toContain('title-incomplete');
  });

  it('lists a key or title property the record lacks with no value and the kind unknown, and flags the node', () => {
    const [node] = normalizeRows(context(), rows({ title: 'Lamp' })).nodes;
    const missing = (node?.properties ?? []).filter((property) => property.dataClass === 'unknown');
    expect(missing.map((property) => property.key)).toEqual(['kind', 'madeOn']);
    expect(missing.every((property) => !('value' in property))).toBe(true);
    expect(node?.qualityFlags).toEqual(['missing-property']);
  });

  it('shows only mapped properties, and a mapped property that is not a key or title property is not listed when the record lacks it', () => {
    const [node] = normalizeRows(context(), rows({ title: 'Lamp', kind: 'k', madeOn: '2026', stray: 'SECRET' })).nodes;
    expect((node?.properties ?? []).map((property) => property.key)).toEqual(['gadgetId', 'title', 'kind', 'madeOn']);
    expect(JSON.stringify(node)).not.toContain('SECRET');
  });

  it.each([
    ['text', 'x', 'x', 'text'],
    ['a number', 4, 4, 'number'],
    ['a float', 1.5, 1.5, 'number'],
    ['a boolean', false, false, 'boolean'],
    ['an integer beyond the safe range', { $type: 'integer', value: '9223372036854775807' }, '9223372036854775807', 'number'],
    ['a date', { $type: 'date', value: '2026-01-02' }, '2026-01-02', 'date'],
    ['a dateTime', { $type: 'dateTime', value: '2026-01-02T03:04:05+02:00' }, '2026-01-02T03:04:05+02:00', 'dateTime'],
    ['a localDateTime', { $type: 'localDateTime', value: '2026-01-02T03:04:05' }, '2026-01-02T03:04:05', 'localDateTime'],
    ['a time', { $type: 'time', value: '10:11:12Z' }, '10:11:12Z', 'time'],
    ['a localTime', { $type: 'localTime', value: '10:11:12' }, '10:11:12', 'localTime'],
    ['a duration', { $type: 'duration', value: 'P1D' }, 'P1D', 'duration'],
    ['a list', [1, 2], [1, 2], 'list'],
    ['a map', { k: 1 }, { k: 1 }, 'other'],
  ])('keeps %s as its value with the kind of the value', (_name, value, shown, dataClass) => {
    const [node] = normalizeRows(context(), rows({ title: 'Lamp', kind: value, madeOn: '2026' })).nodes;
    expect(node?.properties.find((property) => property.key === 'kind')).toEqual({ key: 'kind', value: shown, dataClass, masked: false });
  });

  it('renders a title placeholder from a tagged value as its text', () => {
    const [node] = normalizeRows(context(), rows({ title: { $type: 'integer', value: '9223372036854775807' }, kind: 'k', madeOn: '2026' })).nodes;
    expect(node?.display.title).toBe('Gadget 9223372036854775807');
  });
});

describe('a mapped property named like a member of every object', () => {
  const mapped = mappingOf(
    sourceWith('alpha', {
      entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', title: 'Gadget {constructor}', display: { key_properties: ['toString'] } }],
      relationships: [],
    }),
  ).sources[0] as SourceModel;

  it('is missing, not found on the prototype chain, when the record lacks it', () => {
    const model = { sourceId: 'request-source', hasMore: false, model: normalizeModelOf(mapped) };
    const [node] = normalizeRows(model, [{ n: plainNode(['Gadget'], { gadgetId: 'g1' }) }]).nodes;
    expect(node?.display.title).toBe('gadget g1');
    expect(node?.qualityFlags).toEqual(expect.arrayContaining(['missing-property', 'title-incomplete']));
    expect(node?.properties.filter((property) => property.key === 'constructor' || property.key === 'toString')).toEqual([
      { key: 'constructor', dataClass: 'unknown', masked: false },
      { key: 'toString', dataClass: 'unknown', masked: false },
    ]);
  });

  it('is read when the record has it itself, and a stable ID of that name is not found on the prototype either', () => {
    const model = { sourceId: 'request-source', hasMore: false, model: normalizeModelOf(mapped) };
    const [node] = normalizeRows(model, [{ n: plainNode(['Gadget'], { gadgetId: 'g1', constructor: 'own', toString: 'x' }) }]).nodes;
    expect(node?.display.title).toBe('Gadget own');
    const keyed = mappingOf(sourceWith('alpha', { entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'valueOf' }], relationships: [] })).sources[0] as SourceModel;
    const result = normalizeRows({ sourceId: 'request-source', hasMore: false, model: normalizeModelOf(keyed) }, [{ n: plainNode(['Gadget'], { other: 1 }) }]);
    expect(result.dropped['no-stable-id']).toBe(1);
  });
});

