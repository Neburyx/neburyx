import { describe, expect, it } from 'vitest';
import { parsedPatternParams, patternAllowlist, patternMappingOf, step } from '../testing/pattern-fixtures.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS } from '../testing/pattern-fixtures.js';
import { patternCountQualityOf, patternNoticesOf } from './templates/pattern-notices.js';
import { patternRequestOf } from './templates/pattern-request.js';

const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' });
const requestOf = (steps: Record<string, unknown>[], mapping = patternMappingOf()) => patternRequestOf(patternAllowlist(mapping), parsedPatternParams(steps));
const QUIET = { stopListed: false, supernodes: [], bounded: false };
const codes = (notices: readonly { code: string }[]) => notices.map((notice) => notice.code);

describe('the notices of a pattern run', () => {
  it('say nothing for a one-step run that was not cut and had no window', () => {
    expect(patternNoticesOf(QUIET, requestOf([step()]))).toEqual([]);
  });

  it('say a stop-list skip, and say so alone, with no read-bounded notice', () => {
    expect(codes(patternNoticesOf({ ...QUIET, stopListed: true }, requestOf([TOOL, BACK])))).toEqual(['stopListSkipped']);
  });

  it('say the supernodes that were not traversed with their entities, and say so alone', () => {
    const entity = { sourceId: 'demo', entityType: 'tool', stableId: 'T-9' };
    expect(patternNoticesOf({ ...QUIET, supernodes: [entity] }, requestOf([TOOL, BACK]))).toEqual([{ code: 'supernodesSkipped', entities: [entity] }]);
  });

  it('say a read that hit a bound', () => {
    expect(codes(patternNoticesOf({ ...QUIET, bounded: true }, requestOf([step()])))).toEqual(['readBounded']);
  });

  it('say that no stop-list applies to the entities between when there are steps between and the mapping has none for them', () => {
    const plain = linkedMappingOf({ entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS, derived: [], patterns: [] });
    expect(codes(patternNoticesOf(QUIET, requestOf([TOOL, BACK], plain)))).toEqual(['noStopList']);
    expect(codes(patternNoticesOf(QUIET, requestOf([step()], plain)))).toEqual([]);
  });

  it('say that undated relationships were left out only when a window is applied, and that the window did not apply to the types with no time, each type once', () => {
    expect(codes(patternNoticesOf(QUIET, requestOf([step({ ...WINDOW })])))).toEqual(['undatedExcluded']);
    const mixed = requestOf([step({ relationshipTypes: ['LINKS', 'TRUSTS'], ...WINDOW }), step({ relationshipTypes: ['TRUSTS'], ...WINDOW })]);
    expect(patternNoticesOf(QUIET, mixed)).toEqual([{ code: 'noStopList' }, { code: 'undatedExcluded' }, { code: 'windowNotApplied', relationshipTypes: ['TRUSTS'] }]);
    expect(codes(patternNoticesOf(QUIET, requestOf([step({ relationshipTypes: ['LINKS', 'TRUSTS'] })])))).toEqual([]);
  });

  it('say a window on a step whose types have no time: it is accepted, nothing is left out as undated, and the run says it did not apply', () => {
    const notices = patternNoticesOf(QUIET, requestOf([step({ relationshipTypes: ['TRUSTS'], ...WINDOW })]));
    expect(notices).toEqual([{ code: 'windowNotApplied', relationshipTypes: ['TRUSTS'] }]);
  });
});

describe('the quality of the count of a pattern run', () => {
  const entity = { sourceId: 'demo', entityType: 'tool', stableId: 'T-9' };
  it('is exact when nothing bounded or skipped the read, and a lower bound otherwise', () => {
    expect(patternCountQualityOf(QUIET, false)).toBe('exact');
    expect(patternCountQualityOf(QUIET, true)).toBe('lowerBound');
    expect(patternCountQualityOf({ ...QUIET, bounded: true }, false)).toBe('lowerBound');
    expect(patternCountQualityOf({ ...QUIET, supernodes: [entity] }, false)).toBe('lowerBound');
    expect(patternCountQualityOf({ ...QUIET, stopListed: true }, false)).toBe('lowerBound');
  });
});
