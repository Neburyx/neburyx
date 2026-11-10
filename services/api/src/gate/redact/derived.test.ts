import { describe, expect, it } from 'vitest';
import { redactContext } from '../../testing/normalize-fixtures.js';
import { fixtureRows, PACKS, packSource } from '../../testing/pack-fixtures.js';
import { withDerivedEdges } from '../normalize/derived.js';
import { normalizeRows, type Normalized } from '../normalize/index.js';
import { normalizeModelOf } from '../normalize/model.js';
import type { GraphEdge } from '@neburyx/contracts';
import { redactResult } from './index.js';

const REQUEST = 'the-request';

/** The same derived edge under another source, so that it is a second one. */
const anotherSource = (edge: GraphEdge): GraphEdge => ('derived' in edge.ref ? { ...edge, ref: { sourceId: 'another', derived: edge.ref.derived } } : edge);

/** A dropped derived relationship leaves no trace for the person: the same warnings and the same drop counts as before, and no new key. */
function expectNoHint(result: Normalized, before: Normalized): void {
  expect(result.warnings).toEqual(before.warnings);
  expect(result.dropped).toEqual(before.dropped);
  expect(JSON.stringify(result.warnings)).not.toMatch(/left out|not shown|not-visible|hidden|[A-Z]{2}-\d|ZZ-/);
}

describe.each(PACKS)('the derived edge of the %s pack\'s captured supports', (pack) => {
  const source = packSource(pack);
  const model = normalizeModelOf(source);
  const context = { sourceId: REQUEST, hasMore: false, model };
  const [rule] = source.derived;
  const supports = normalizeRows(context, fixtureRows(pack, 'supports'));
  const [first, second] = supports.edges;
  if (first === undefined || second === undefined) throw new Error('the supports fixture holds two edges');
  const whole = withDerivedEdges(context, supports, [{ ruleId: rule?.id ?? '', from: first.from, to: second.from, supports: supports.edges.map((edge) => edge.ref) }]);

  const run = (result: Normalized, mask: boolean): Normalized => redactResult(result, redactContext(model, mask));

  it('has a derived edge to begin with', () => {
    expect(whole.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(1);
  });

  it.each([[true], [false]])('is kept, with the flag %s, when both ends and every support are in the result', (mask) => {
    const result = run(whole, mask);
    expect(result.edges).toEqual(whole.edges);
    expect(result.warnings).toEqual(whole.warnings);
  });

  it.each([[true], [false]])('is dropped, with the flag %s, when a supporting edge is not in the result, and the rest is unchanged', (mask) => {
    const withoutSupport = { ...whole, edges: whole.edges.filter((edge) => edge !== first) };
    const result = run(withoutSupport, mask);
    expect(result.edges.some((edge) => edge.semantics === 'derived')).toBe(false);
    expect(result.edges).toEqual(withoutSupport.edges.filter((edge) => edge.semantics !== 'derived'));
    expect(result.nodes.length).toBe(whole.nodes.length);
    expectNoHint(result, whole);
  });

  it.each([[true], [false]])('is dropped, with the flag %s, when an end is not a node of the result', (mask) => {
    const derived = whole.edges.find((edge) => edge.semantics === 'derived');
    const withoutEnd = { ...whole, nodes: whole.nodes.filter((node) => JSON.stringify(node.ref) !== JSON.stringify(derived?.from)) };
    const result = run(withoutEnd, mask);
    expect(result.edges.some((edge) => edge.semantics === 'derived')).toBe(false);
    expectNoHint(result, whole);
  });

  it('never drops a stored or an aggregate edge by this rule, even with no node in the result', () => {
    const result = run({ ...supports, nodes: [] }, true);
    expect(result.edges).toEqual(supports.edges);
  });

  it('drops several derived edges as it drops one: with no count, no warning and no other hint', () => {
    const derived = whole.edges.filter((edge) => edge.semantics === 'derived');
    const twice = { ...whole, edges: [...whole.edges.filter((edge) => edge !== first), ...derived.map(anotherSource)] };
    const result = run(twice, false);
    expect(result.edges.some((edge) => edge.semantics === 'derived')).toBe(false);
    expectNoHint(result, twice);
  });
});

describe('the derived-edge rule on references written in another order', () => {
  const source = packSource('banking-fraud');
  const model = normalizeModelOf(source);
  const context = { sourceId: REQUEST, hasMore: false, model };
  const [rule] = source.derived;
  const supports = normalizeRows(context, fixtureRows('banking-fraud', 'supports'));
  const [first, second] = supports.edges;
  if (first === undefined || second === undefined) throw new Error('the supports fixture holds two edges');
  const whole = withDerivedEdges(context, supports, [{ ruleId: rule?.id ?? '', from: first.from, to: second.from, supports: supports.edges.map((edge) => edge.ref) }]);

  /** The same value with the fields of every object in reverse order. The shape does not change, which the type cannot show, so the result is typed as the input. */
  function reordered<T>(value: T): T {
    if (Array.isArray(value)) return value.map(reordered) as T;
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reordered(entry)])) as T;
    return value;
  }

  it('keeps the derived edge when its ends and supports are written with their fields in another order', () => {
    const shuffled = { ...whole, edges: whole.edges.map((edge) => (edge.semantics === 'derived' ? { ...edge, from: reordered(edge.from), to: reordered(edge.to), derivation: reordered(edge.derivation) } : edge)) };
    const result = redactResult(shuffled, redactContext(model, false));
    expect(result.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(1);
  });

  it('keeps the derived edge when the nodes and the supports are written in another field order', () => {
    const shuffled = { ...whole, nodes: whole.nodes.map((node) => ({ ...node, ref: reordered(node.ref) })), edges: whole.edges.map((edge) => (edge.semantics === 'derived' ? edge : { ...edge, ref: reordered(edge.ref) })) };
    const result = redactResult(shuffled, redactContext(model, true));
    expect(result.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(1);
  });
});

describe('the warnings when a derived edge is dropped', () => {
  const source = packSource('banking-fraud');
  const model = normalizeModelOf(source);
  const context = { sourceId: REQUEST, hasMore: false, model };
  const [rule] = source.derived;
  const supports = normalizeRows(context, fixtureRows('banking-fraud', 'supports'));
  const [first, second] = supports.edges;
  if (first === undefined || second === undefined) throw new Error('the supports fixture holds two edges');
  const whole = withDerivedEdges(context, supports, [{ ruleId: rule?.id ?? '', from: first.from, to: second.from, supports: supports.edges.map((edge) => edge.ref) }]);
  const broken: Normalized = { ...whole, edges: whole.edges.filter((edge) => edge !== first), warnings: ['a warning of the template'] };

  it('keeps the warnings the result already had and adds none about the relationship it dropped', () => {
    const result = redactResult(broken, redactContext(model, false));
    expect(result.warnings).toEqual(['a warning of the template']);
  });

  it('says nothing more when it is run again on its own result', () => {
    const once = redactResult(broken, redactContext(model, false));
    const twice = redactResult(once, redactContext(model, false));
    expect(twice).toEqual(once);
    const extra = { ...once, edges: [...once.edges, ...whole.edges.filter((edge) => edge.semantics === 'derived').map((edge) => ({ ...edge, ref: { ...edge.ref, sourceId: 'another' } }))] };
    const thrice = redactResult(extra, redactContext(model, false));
    expect(thrice.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(0);
    expect(thrice.warnings).toContain('a warning of the template');
    expect(thrice.warnings.filter((warning) => /derived|left out|not shown/.test(warning))).toEqual([]);
  });
});

