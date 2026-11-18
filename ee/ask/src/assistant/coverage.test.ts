import { describe, expect, it } from 'vitest';
import { askRunResultSchema, type AskRunResult } from '@neburyx/contracts';
import { coverageOf } from './coverage.js';
import { fileQueryResult, okResult } from '../testing/assistant-rig.js';

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
