import { describe, expect, it } from 'vitest';
import { askRunResultSchema, type AskRunResult } from '@neburyx/contracts';
import { coverageOf, degreeCountsOf } from './coverage.js';
import { degreeResult, derivedRuleResult, expandResult, fileQueryResult, okResult } from '../testing/assistant-rig.js';

const withCount = (base: AskRunResult, count: unknown): AskRunResult => {
  if (base.templateId !== 'shared-attribute' || base.result.status !== 'ok') throw new Error('fixture');
  return askRunResultSchema.parse({ ...base, result: { ...base.result, count } });
};

const fileQueryWith = (count: unknown): AskRunResult => {
  const base = fileQueryResult();
  if (base.templateId !== 'file-query') throw new Error('fixture');
  return askRunResultSchema.parse({ ...base, result: { ...base.result, count } });
};

describe('the coverage line of a template result: matches, never the nodes it lists', () => {
  it('counts the matches it lists and not the anchor beside them, so one match of one counted is exact with nothing left', () => {
    const fixture = okResult();
    if (fixture.templateId !== 'shared-attribute' || fixture.result.status !== 'ok') throw new Error('fixture');
    expect([fixture.result.matchIds.length, fixture.result.nodes.length]).toEqual([1, 2]);
    expect(coverageOf(okResult())).toBe('1 match shown · exact');
  });

  it('says how much is not yet retrieved from the matches counted, not from the nodes listed', () => {
    expect(coverageOf(withCount(okResult(), { quality: 'exact', value: 148, scope: 'test' }))).toBe('1 match shown · 147 not yet retrieved · exact');
  });

  it('writes the sign of an estimate and of a lower bound before the figure not yet retrieved', () => {
    expect(coverageOf(withCount(okResult(), { quality: 'estimated', value: 40, scope: 'test' }))).toBe('1 match shown · ~ 39 not yet retrieved · estimated');
    expect(coverageOf(withCount(okResult(), { quality: 'lowerBound', value: 26, scope: 'test' }))).toBe('1 match shown · ≥ 25 not yet retrieved · lower bound');
  });

  it('writes the plural of matches', () => {
    const two = okResult();
    if (two.templateId !== 'shared-attribute' || two.result.status !== 'ok') throw new Error('fixture');
    const [first, second] = two.result.nodes;
    const matched = askRunResultSchema.parse({ ...two, result: { ...two.result, matchIds: [first?.ref, second?.ref], count: { quality: 'exact', value: 2, scope: 'test' } } });
    expect(coverageOf(matched)).toBe('2 matches shown · exact');
  });

  it('gives no figure for a count that is unknown', () => {
    expect(coverageOf(withCount(okResult(), { quality: 'unknown', scope: 'test' }))).toBe('1 match shown · count unknown');
  });
});

describe('the coverage line of a file query: rows, as the query counted them', () => {
  it('says the rows the query returned and never a figure not yet retrieved, even when duplicated rows made the nodes fewer than the rows', () => {
    expect(coverageOf(fileQueryResult())).toBe('2 rows · exact');
    expect(coverageOf(fileQueryWith({ quality: 'exact', value: 5, scope: 'rows' }))).toBe('5 rows · exact');
  });

  it('writes a cut query as a lower bound of rows, and an unknown count without a figure', () => {
    expect(coverageOf(fileQueryWith({ quality: 'lowerBound', value: 25, scope: 'rows' }))).toBe('≥ 25 rows · lower bound');
    expect(coverageOf(fileQueryWith({ quality: 'unknown', scope: 'rows' }))).toBe('rows count unknown');
  });
});

describe('the coverage line of a result with no count of its own', () => {
  it('says how many elements it lists and does not invent a count', () => {
    const entity = okResult();
    if (entity.templateId !== 'shared-attribute' || entity.result.status !== 'ok') throw new Error('fixture');
    const [first] = entity.result.nodes;
    expect(coverageOf(askRunResultSchema.parse({ templateId: 'entity', result: first }))).toBe('1 shown');
  });
});

describe('the coverage line of an expansion: the neighbours it lists, never the anchor beside them', () => {
  it('counts two neighbours of three listed nodes as two matches, exact when no page has more', () => {
    expect(coverageOf(expandResult())).toBe('2 matches shown · exact');
  });

  it('says a lower bound when the count of a page is not exact even though it has no more', () => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('fixture');
    const dropped = askRunResultSchema.parse({ ...base, result: { ...base.result, pages: base.result.pages.map((page) => ({ ...page, matchingTotal: { quality: 'lowerBound', value: 2, scope: 'test' } })) } });
    expect(coverageOf(dropped)).toBe('2 matches shown · lower bound');
  });

  it('says a lower bound when a page has more', () => {
    expect(coverageOf(expandResult(true))).toBe('2 matches shown · lower bound');
  });
});

describe('the coverage line of a derived rule run: the other ends, never the anchor listed once for each rule', () => {
  it('counts the other ends of two rules and not their two anchors', () => {
    expect(coverageOf(derivedRuleResult())).toBe('3 matches shown · exact');
  });

  it('says what is not yet retrieved from the counts of the rules, and the worst quality of them', () => {
    expect(coverageOf(derivedRuleResult({ quality: 'lowerBound', value: 28 }))).toBe('3 matches shown · ≥ 27 not yet retrieved · lower bound');
  });

  it('says the count is unknown when a rule\'s count is', () => {
    expect(coverageOf(derivedRuleResult({ quality: 'unknown' }))).toBe('3 matches shown · count unknown');
  });
});

describe('the counts a degree read states', () => {
  it('writes the connected elements by the display name of their type and in all, each with its quality as the copy rules write it', () => {
    const names = new Map([['gadget', 'Gadget'], ['widget', 'Widget']]);
    expect(degreeCountsOf(degreeResult(), names)).toBe('connected elements by type: Gadget 169,756 (exact) · Widget ≥ 1,000 · lower bound · all types 184,533 (exact)');
  });

  it('writes the type itself when no display name is known, and states none for a read that is not a degree read', () => {
    expect(degreeCountsOf(degreeResult())).toContain('gadget 169,756 (exact)');
    expect(degreeCountsOf(okResult())).toBeUndefined();
  });
});
