import { describe, expect, it } from 'vitest';
import { edgeSchema, type EdgeRef, type ElementRef } from '@neburyx/contracts';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { context, plainNode, plainRelationship } from '../../testing/normalize-fixtures.js';
import { withDerivedEdges, type DerivedClaim } from './derived.js';
import { normalizeModelOf } from './model.js';
import { normalizeRows } from './index.js';

const REQUEST = 'request-source';
const ref = (entityType: string, stableId: string): ElementRef => ({ sourceId: REQUEST, entityType, stableId });
const row = (...values: unknown[]) => ({ values });

/** Two gadgets made by one person, and two others: the supports of a derived link between the first two. */
function graph() {
  const [g1, g2, g3] = [plainNode(['Gadget'], { gadgetId: 'g1', title: 'a', kind: 'k', madeOn: '1' }), plainNode(['Gadget'], { gadgetId: 'g2', title: 'b', kind: 'k', madeOn: '1' }), plainNode(['Gadget'], { gadgetId: 'g3', title: 'c', kind: 'k', madeOn: '1' })] as const;
  const [p1, p2] = [plainNode(['Person'], { personId: 'p1' }), plainNode(['Person'], { personId: 'p2' })] as const;
  const rows = [row(g1, plainRelationship('MADE_BY', g1, p1), p1), row(g2, plainRelationship('MADE_BY', g2, p1), p1), row(g3, plainRelationship('MADE_BY', g3, p2), p2)];
  const normalized = normalizeRows(context(), rows);
  const supportOf = (from: string, to: string): EdgeRef => {
    const edge = normalized.edges.find((candidate) => candidate.from.stableId === from && candidate.to.stableId === to);
    if (edge === undefined) throw new Error('no support');
    return edge.ref;
  };
  return { normalized, supportOf };
}

const claim = (supports: EdgeRef[], overrides: Partial<DerivedClaim> = {}): DerivedClaim => ({ ruleId: 'shared-maker', from: ref('gadget', 'g1'), to: ref('gadget', 'g2'), supports, ...overrides });

describe('a derived edge', () => {
  it('is built from the rule of the mapping and the edges that support it, with the version of the mapping', () => {
    const { normalized, supportOf } = graph();
    const supports = [supportOf('g1', 'p1'), supportOf('g2', 'p1')];
    const result = withDerivedEdges(context(), normalized, [claim(supports)]);
    const derived = result.edges.find((edge) => edge.semantics === 'derived');
    expect(edgeSchema.safeParse(derived).success).toBe(true);
    expect(derived).toMatchObject({
      ref: { sourceId: REQUEST, derived: { ruleId: 'shared-maker', from: ref('gadget', 'g1'), to: ref('gadget', 'g2') } },
      type: 'shared-maker',
      semantics: 'derived',
      derivation: { ruleId: 'shared-maker', ruleVersion: 3, supportingEdgeRefs: supports },
    });
    expect(result.edges).toHaveLength(normalized.edges.length + 1);
    expect(result.dropped['not-mapped']).toBe(0);
  });

  it('takes the version from the mapping and ignores a version or a kind a claim carries', () => {
    const { normalized, supportOf } = graph();
    const claimed = { ...claim([supportOf('g1', 'p1'), supportOf('g2', 'p1')]), ruleVersion: 99, semantics: 'stored' } as DerivedClaim;
    const derived = withDerivedEdges(context(), normalized, [claimed]).edges.find((edge) => 'derived' in edge.ref);
    expect(derived?.derivation?.ruleVersion).toBe(3);
    expect(derived?.semantics).toBe('derived');
  });

  it('is never the stored edge between the same two entities: the two are two edges that differ in kind', () => {
    const { normalized, supportOf } = graph();
    const stored = normalized.edges.length;
    const result = withDerivedEdges(context(), normalized, [claim([supportOf('g1', 'p1'), supportOf('g2', 'p1')])]);
    expect(result.edges.filter((edge) => edge.from.stableId === 'g1' && edge.to.stableId === 'g2')).toHaveLength(1);
    expect(result.edges.slice(0, stored).every((edge) => edge.semantics === 'stored')).toBe(true);
  });

  it('is one edge when claimed twice', () => {
    const { normalized, supportOf } = graph();
    const supports = [supportOf('g1', 'p1'), supportOf('g2', 'p1')];
    expect(withDerivedEdges(context(), normalized, [claim(supports), claim(supports)]).edges.filter((edge) => 'derived' in edge.ref)).toHaveLength(1);
  });

  describe('is left out, and counted as not mapped, when it does not follow its rule', () => {
    const cases: readonly (readonly [string, (supportOf: (from: string, to: string) => EdgeRef) => DerivedClaim])[] = [
      ['a rule the mapping does not hold', (supportOf) => claim([supportOf('g1', 'p1'), supportOf('g2', 'p1')], { ruleId: 'invented' })],
      ['ends that are not entities of the rule', (supportOf) => claim([supportOf('g1', 'p1'), supportOf('g2', 'p1')], { to: ref('person', 'p1') })],
      ['a support that is not in the result', () => claim([{ sourceId: REQUEST, stableId: 'absent' }, { sourceId: REQUEST, stableId: 'absent-too' }])],
      ['too few supports', (supportOf) => claim([supportOf('g1', 'p1')])],
      ['too many supports', (supportOf) => claim([supportOf('g1', 'p1'), supportOf('g2', 'p1'), supportOf('g3', 'p2')])],
      ['supports that do not meet at one middle entity', (supportOf) => claim([supportOf('g1', 'p1'), supportOf('g3', 'p2')], { to: ref('gadget', 'g3') })],
      ['supports that do not start at the from entity', (supportOf) => claim([supportOf('g3', 'p2'), supportOf('g2', 'p1')])],
      ['supports that do not end at the to entity', (supportOf) => claim([supportOf('g1', 'p1'), supportOf('g2', 'p1')], { to: ref('gadget', 'g3') })],
    ];
    it.each(cases)('%s', (_name, build) => {
      const { normalized, supportOf } = graph();
      const result = withDerivedEdges(context(), normalized, [build(supportOf)]);
      expect(result.edges).toEqual(normalized.edges);
      expect(result.dropped['not-mapped']).toBe(1);
      expect(result.warnings).toEqual(["1 row was left out because they are not part of this source's mapping."]);
    });

    it('a support of the wrong type', () => {
      const { normalized } = graph();
      const [g1, g2, p1] = [plainNode(['Gadget'], { gadgetId: 'g1', title: 'a', kind: 'k', madeOn: '1' }), plainNode(['Gadget'], { gadgetId: 'g2', title: 'b', kind: 'k', madeOn: '1' }), plainNode(['Person'], { personId: 'p1' })] as const;
      const other = normalizeRows(context(), [row(p1, plainRelationship('KNOWS', p1, p1, { linkId: 'L1' }), p1), row(g1, plainRelationship('MADE_BY', g1, p1), p1), row(g2, plainRelationship('MADE_BY', g2, p1), p1)]);
      const knows = other.edges.find((edge) => edge.type === 'KNOWS');
      const made = other.edges.find((edge) => edge.from.stableId === 'g2');
      const result = withDerivedEdges(context(), other, [claim([(knows ?? normalized.edges[0])?.ref as EdgeRef, made?.ref as EdgeRef])]);
      expect(result.dropped['not-mapped']).toBe(1);
    });
  });
});

describe.each(PACKS)('the supports of a derived rule captured from the %s pack', (pack) => {
  const source = packSource(pack);
  const model = { sourceId: REQUEST, hasMore: false, model: normalizeModelOf(source) };
  const [rule] = source.derived;
  const rows = readFixture(pack)['supports'] as Record<string, unknown>[];

  it('give a derived edge between the two ends, with the rule version of the mapping, and nothing derived without its supports', () => {
    const normalized = normalizeRows(model, rows);
    expect(normalized.edges).toHaveLength(2);
    const [first, second] = normalized.edges;
    const result = withDerivedEdges(model, normalized, [{ ruleId: rule?.id ?? '', from: first?.from as ElementRef, to: second?.from as ElementRef, supports: [first?.ref as EdgeRef, second?.ref as EdgeRef] }]);
    const derived = result.edges.find((edge) => edge.semantics === 'derived');
    expect(edgeSchema.safeParse(derived).success).toBe(true);
    expect(derived?.derivation?.ruleVersion).toBe(rule?.ruleVersion);
    expect(derived?.type).toBe(rule?.id);
    const alone = withDerivedEdges(model, normalized, [{ ruleId: rule?.id ?? '', from: first?.from as ElementRef, to: second?.from as ElementRef, supports: [first?.ref as EdgeRef] }]);
    expect(alone.edges.some((edge) => edge.semantics === 'derived')).toBe(false);
  });
});
