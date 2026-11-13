import { describe, expect, it } from 'vitest';
import { context, plainNode, plainRelationship } from '../../testing/normalize-fixtures.js';
import { parsedPatternParams, patternMappingOf, step } from '../../testing/pattern-fixtures.js';
import { normalizeModelOf } from './index.js';
import { isNormalizedPattern, normalizePattern } from './pattern.js';

const [source] = patternMappingOf().sources;
if (source === undefined) throw new Error('the mapping has no source');
const model = normalizeModelOf(source);

const maker = (id: string) => plainNode(['Maker'], { makerId: id });
const tool = (id: string) => plainNode(['Tool'], { toolId: id });
const shop = (id: string) => plainNode(['Shop'], { shopId: id });
const ID_PROPERTY: Record<string, string | undefined> = { LINKS: 'linkId', USES_TOOL: 'useId', ENDORSES: 'endorseId' };
const rel = (type: string, from: { elementId: string }, to: { elementId: string }, id: string) => plainRelationship(type, from, to, ID_PROPERTY[type] === undefined ? {} : { [ID_PROPERTY[type] ?? '']: id });

const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' });
const paramsOf = (steps: Record<string, unknown>[]) => ({ ...parsedPatternParams(steps) });
const contextFor = (steps: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => context({ model, params: paramsOf(steps), ...overrides });

const FLAGS = { bounded: false, stopListed: false, heavy: [] as unknown[] };

describe('the normalized result of a pattern run', () => {
  it('holds a one-step match with its anchor, its relationship and its hop count', () => {
    const a = maker('A-1');
    const x = maker('N-1');
    const row = { a, ...FLAGS, x, mid: [], r1: rel('LINKS', a, x, 'L-1'), hops: 1 };
    const result = normalizePattern(contextFor([step()]), [row]);
    expect(isNormalizedPattern(result)).toBe(true);
    expect(result.anchorFound).toBe(true);
    expect(result.matches).toEqual([{ match: expect.objectContaining({ entityType: 'maker', stableId: 'N-1' }), hops: 1, through: [], relationships: [{ relationshipType: 'LINKS', from: expect.objectContaining({ stableId: 'A-1' }), to: expect.objectContaining({ stableId: 'N-1' }), stableId: 'L-1' }] }]);
    expect(result.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'N-1']);
    expect(result.edges).toHaveLength(1);
  });

  it('holds a two-step match with the entity between, each hop’s relationship type, and the entity read as the type its step names', () => {
    const [a, t, x] = [maker('A-1'), tool('T-1'), maker('N-1')];
    const row = { a, ...FLAGS, x, mid: [t], r1: rel('USES_TOOL', a, t, 'U-1'), r2: rel('USES_TOOL', x, t, 'U-2'), hops: 2 };
    const result = normalizePattern(contextFor([TOOL, BACK]), [row]);
    expect(result.matches).toEqual([{ match: expect.objectContaining({ entityType: 'maker', stableId: 'N-1' }), hops: 2, through: [expect.objectContaining({ entityType: 'tool', stableId: 'T-1' })], relationships: [expect.objectContaining({ relationshipType: 'USES_TOOL', from: expect.objectContaining({ stableId: 'A-1' }), to: expect.objectContaining({ stableId: 'T-1' }), stableId: 'U-1' }), expect.objectContaining({ relationshipType: 'USES_TOOL', from: expect.objectContaining({ stableId: 'N-1' }), to: expect.objectContaining({ stableId: 'T-1' }), stableId: 'U-2' })] }]);
    expect(result.edges).toHaveLength(2);
  });

  it('holds a four-step match with three entities between in order', () => {
    const [a, t, s, m, x] = [maker('A-1'), tool('T-1'), shop('S-1'), maker('M-1'), maker('N-1')];
    const steps = [TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' }), step({ relationshipTypes: ['ENDORSES'], arrivesAt: 'maker' }), step()];
    const row = { a, ...FLAGS, x, mid: [t, s, m], r1: rel('USES_TOOL', a, t, 'U-1'), r2: rel('STOCKED_AT', t, s, 'K-1'), r3: rel('ENDORSES', s, m, 'E-1'), r4: rel('LINKS', m, x, 'L-1'), hops: 4 };
    const result = normalizePattern(contextFor(steps), [row]);
    expect(result.matches[0]?.relationships.map((hop) => hop.relationshipType)).toEqual(['USES_TOOL', 'STOCKED_AT', 'ENDORSES', 'LINKS']);
    expect(result.matches[0]?.relationships.map((hop) => hop.stableId)).toEqual(['U-1', undefined, 'E-1', 'L-1']);
    expect(result.matches[0]).toMatchObject({ hops: 4 });
    expect(result.matches[0]?.through.map((ref) => ref?.entityType)).toEqual(['tool', 'shop', 'maker']);
  });

  it('answers the anchor with no match for the one row of a read that found nothing, and nothing found for no row', () => {
    const none = normalizePattern(contextFor([step()]), [{ a: maker('A-1'), ...FLAGS, x: null, mid: [], r1: null, hops: 1 }]);
    expect(none).toMatchObject({ anchorFound: true, matches: [], supernodes: [], bounded: false, stopListed: false });
    expect(normalizePattern(contextFor([step()]), [])).toMatchObject({ anchorFound: false, matches: [] });
  });

  it('reads the flags of the read and the supernodes it did not traverse, once each', () => {
    const a = maker('A-1');
    const heavy = [tool('T-9'), tool('T-9')];
    const row = { a, bounded: true, stopListed: true, heavy, x: null, mid: [], r1: null, hops: 2 };
    const result = normalizePattern(contextFor([TOOL, BACK]), [row]);
    expect(result).toMatchObject({ bounded: true, stopListed: true });
    expect(result.supernodes).toEqual([expect.objectContaining({ entityType: 'tool', stableId: 'T-9' })]);
  });

  it('leaves out a match with no usable stable ID and counts it by reason, and keeps a match whose entity between has none, without that entity', () => {
    const a = maker('A-1');
    const bad = plainNode(['Maker'], {});
    const row = { a, ...FLAGS, x: bad, mid: [], r1: rel('LINKS', a, bad, 'L-1'), hops: 1 };
    const result = normalizePattern(contextFor([step()]), [row]);
    expect(result.matches).toEqual([]);
    expect(result.dropped['no-stable-id']).toBeGreaterThan(0);
    const t = plainNode(['Tool'], {});
    const x = maker('N-1');
    const through = normalizePattern(contextFor([TOOL, BACK]), [{ a, ...FLAGS, x, mid: [t], r1: rel('USES_TOOL', a, t, 'U-1'), r2: rel('USES_TOOL', x, t, 'U-2'), hops: 2 }]);
    expect(through.matches).toHaveLength(1);
    expect(through.matches[0]?.through).toEqual([null]);
    expect(through.matches[0]?.relationships).toEqual([
      expect.objectContaining({ relationshipType: 'USES_TOOL', from: expect.objectContaining({ stableId: 'A-1' }), to: null, stableId: 'U-1' }),
      expect.objectContaining({ relationshipType: 'USES_TOOL', from: expect.objectContaining({ stableId: 'N-1' }), to: null, stableId: 'U-2' }),
    ]);
    expect(through.dropped['no-stable-id']).toBeGreaterThan(0);
    const [t1, s1, m1, y] = [tool('T-1'), plainNode(['Shop'], {}), maker('M-1'), maker('N-2')];
    const steps = [TOOL, step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' }), step({ relationshipTypes: ['ENDORSES'], arrivesAt: 'maker' }), step()];
    const four = normalizePattern(contextFor(steps), [{ a, ...FLAGS, x: y, mid: [t1, s1, m1], r1: rel('USES_TOOL', a, t1, 'U-1'), r2: rel('STOCKED_AT', t1, s1, 'K-1'), r3: rel('ENDORSES', s1, m1, 'E-1'), r4: rel('LINKS', m1, y, 'L-1'), hops: 4 }]);
    expect(four.matches[0]?.through.map((ref) => ref?.stableId ?? null)).toEqual(['T-1', null, 'M-1']);
    expect(four.matches[0]?.relationships.map((hop) => [hop.from?.stableId ?? null, hop.to?.stableId ?? null])).toEqual([['A-1', 'T-1'], ['T-1', null], [null, 'M-1'], ['M-1', 'N-2']]);
  });

  it('lists each match once, and marks the page as cut for a read that was bounded', () => {
    const [a, x] = [maker('A-1'), maker('N-1')];
    const row = { a, bounded: true, stopListed: false, heavy: [], x, mid: [], r1: rel('LINKS', a, x, 'L-1'), hops: 1 };
    const result = normalizePattern(contextFor([step()]), [row, row]);
    expect(result.matches).toHaveLength(1);
    expect(result.warnings).toBeDefined();
  });

  it('reads nothing for parameters that are not a pattern run’s', () => {
    expect(normalizePattern(context({ model, params: {} }), [{ a: maker('A-1') }])).toMatchObject({ anchorFound: false, matches: [] });
    expect(isNormalizedPattern({})).toBe(false);
  });

  it('holds no query text: a sentinel in the stable IDs is data, and nothing else of the request is carried', () => {
    const [a, x] = [maker('zz-sentinel'), maker('N-1')];
    const result = normalizePattern(contextFor([step()]), [{ a, ...FLAGS, x, mid: [], r1: rel('LINKS', a, x, 'L-1'), hops: 1 }]);
    expect(JSON.stringify(result)).not.toMatch(/MATCH|RETURN|\$steps/);
  });
});
