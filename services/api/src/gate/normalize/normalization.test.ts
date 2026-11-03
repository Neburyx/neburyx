import { describe, expect, it } from 'vitest';
import { edgeSchema, nodeSchema } from '@neburyx/contracts';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { countOf } from './count.js';
import { withDerivedEdges } from './derived.js';
import { normalizeModelOf } from './model.js';
import { normalizeRows } from './index.js';

// The Normalization suite (TAS §17): identity, source scope, masked and missing properties, stored versus derived edges. It runs on the records captured from the demo
// containers through the real adapter (tools/demo-graph/fixtures/normalization), so 64-bit integers, temporal values, nodes, relationships and paths are the real thing.
// Every type, label and property name comes from the pack mapping.

describe.each(PACKS)('the Normalization suite on the %s pack', (pack) => {
  const source = packSource(pack);
  const other = PACKS.find((candidate) => candidate !== pack) as (typeof PACKS)[number];
  const model = normalizeModelOf(source);
  const context = { sourceId: 'the-request', hasMore: false, model };
  const fixture = readFixture(pack);
  const rows = (name: string) => fixture[name] as Record<string, unknown>[];

  it('identity: a node is identified by the entity type of its label and its stable ID, under the sourceId of the request', () => {
    const result = normalizeRows(context, rows('node'));
    const [entity] = source.entities;
    expect(result.nodes).toHaveLength(1);
    expect(nodeSchema.safeParse(result.nodes[0]).success).toBe(true);
    expect(result.nodes[0]?.ref.sourceId).toBe('the-request');
    expect(result.nodes[0]?.ref.entityType).toBe(entity?.type);
  });

  it('source scope: nothing is invented for a row without a stable ID or for a row that belongs to another source', () => {
    const made = normalizeRows(context, rows('made'));
    expect(made.dropped).toEqual({ 'not-mapped': 1, 'ambiguous-type': 0, 'no-stable-id': 1 });
    expect(made.nodes).toHaveLength(1);
    const foreign = normalizeRows(context, readFixture(other)['node'] as Record<string, unknown>[]);
    expect(foreign.nodes).toEqual([]);
    expect(foreign.edges).toEqual([]);
    expect(foreign.dropped['not-mapped']).toBeGreaterThan(0);
    expect(foreign.warnings).toHaveLength(1);
  });

  it('masked and missing properties: every property is unmasked here, and a mapped property the record lacks is listed with no value and flagged', () => {
    const made = normalizeRows(context, rows('made'));
    const kept = made.nodes[0];
    expect(kept?.qualityFlags).toContain('missing-property');
    expect(kept?.properties.filter((property) => property.dataClass === 'unknown').every((property) => !('value' in property))).toBe(true);
    const all = [...normalizeRows(context, rows('node')).nodes, ...made.nodes].flatMap((node) => node.properties);
    expect(all.every((property) => property.masked === false)).toBe(true);
  });

  it('stored versus derived: a stored edge is stored, a derived edge carries its rule and the supports it came from, and the two are never confused', () => {
    const stored = normalizeRows(context, rows('stored'));
    expect(stored.edges.every((edge) => edge.semantics === 'stored')).toBe(true);
    const supports = normalizeRows(context, rows('supports'));
    const [rule] = source.derived;
    const [first, second] = supports.edges;
    if (first === undefined || second === undefined) throw new Error('the supports hold two edges');
    const result = withDerivedEdges(context, supports, [{ ruleId: rule?.id ?? '', from: first.from, to: second.from, supports: supports.edges.map((edge) => edge.ref) }]);
    const derived = result.edges.filter((edge) => edge.semantics === 'derived');
    expect(derived).toHaveLength(1);
    expect(edgeSchema.safeParse(derived[0]).success).toBe(true);
    expect(derived[0]?.derivation?.supportingEdgeRefs).toEqual(supports.edges.map((edge) => edge.ref));
    expect(result.edges.filter((edge) => edge.semantics === 'stored')).toHaveLength(supports.edges.length);
  });

  it('aggregate: relationships of a type without a stable ID are one edge for the pair with a member count that says how sure it is', () => {
    const result = normalizeRows(context, rows('members'));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.memberCount).toEqual({ value: 2, quality: 'exact', scope: 'members' });
    expect(normalizeRows({ ...context, hasMore: true }, rows('members')).edges[0]?.memberCount?.quality).toBe('lowerBound');
  });

  it('a count with no value is unknown and carries no number', () => {
    for (const value of [undefined, null, Number.NaN, -1, 1.5, { $type: 'integer', value: '9223372036854775807' }]) {
      const count = countOf(value, 'exact', 'members');
      expect(count.quality).toBe('unknown');
      expect('value' in count).toBe(false);
    }
  });

  it('values: a 64-bit integer keeps its digits, the temporal values keep their text, a node, a relationship and a path are what the driver sent', () => {
    const [values] = rows('values');
    expect(values).toMatchObject({
      bigInteger: { $type: 'integer', value: '9223372036854775807' },
      smallInteger: 7,
      aDate: { $type: 'date', value: '2026-01-02' },
      aDateTime: { $type: 'dateTime', value: '2026-01-02T03:04:05.123456789+02:00' },
      aDuration: { $type: 'duration', value: 'P1Y2M3DT4H5M6S' },
      aPoint: { $type: 'point', srid: 7203, x: 1.5, y: 2.5 },
    });
    const [entity] = source.entities;
    const properties = { [entity?.stableId ?? '']: { $type: 'integer', value: '9223372036854775807' } };
    const node = normalizeRows(context, [{ n: { $type: 'node', elementId: 'x', labels: [entity?.label], properties } }]).nodes[0];
    expect(node?.ref.stableId).toBe('9223372036854775807');
    const path = normalizeRows(context, rows('path'));
    expect(path.nodes).toHaveLength(3);
    expect(path.edges).toHaveLength(2);
    expect((rows('relationship')[0] as { r: { $type: string } }).r.$type).toBe('relationship');
  });
});
