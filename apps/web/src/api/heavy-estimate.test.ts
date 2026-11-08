import type { Count, DegreeByType, DegreePreview } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { heavyDecision, type EstimateAsk } from './heavy-estimate.js';

const ref = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const count = (value: number | undefined, quality: Count['quality'] = 'exact'): Count => (value === undefined ? { quality: 'unknown', scope: 'x' } : { value, quality, scope: 'x' });
const pair = (relationshipType: string, direction: 'out' | 'in', c: Count, neighborTypes: string[]): DegreeByType => ({ relationshipType, direction, count: c, neighborTypes });
const previewOf = (byType: DegreeByType[], threshold = 500): DegreePreview => ({ ref, total: count(0), byType, byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: threshold });
const ask = (neighborTypes: string[], relTypes?: string[]): EstimateAsk => ({ ref, neighborTypes, ...(relTypes === undefined ? {} : { relTypes }) });
const heavy = (value: number, quality: 'exact' | 'estimated' | 'lowerBound', threshold = 500) => ({ kind: 'heavy', estimate: { value, quality }, threshold, pageSize: 25 });
const none = { kind: 'none' };

describe('the estimate of an ask', () => {
  it('1: warns for an exact sum over the threshold', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(1000), ['person']), pair('SENT', 'in', count(240), ['person'])]), ask(['person']))).toEqual(heavy(1240, 'exact'));
  });

  it.each([[499, none], [500, none], [501, heavy(501, 'exact')]])('2: an exact sum of %i against 500', (value, expected) => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(value), ['person'])]), ask(['person']))).toEqual(expected);
  });

  it('2: an estimated sum warns only above the threshold, labelled estimated', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(500, 'estimated'), ['person'])]), ask(['person']))).toEqual(none);
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(501, 'estimated'), ['person'])]), ask(['person']))).toEqual(heavy(501, 'estimated'));
  });

  it.each([[499, none], [500, heavy(500, 'lowerBound')], [501, heavy(501, 'lowerBound')]])('3: a lowerBound of %i against 500', (value, expected) => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(value, 'lowerBound'), ['person'])]), ask(['person']))).toEqual(expected);
  });

  it('3: a capped pair beside an exact pair is a heavy lowerBound sum', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(500, 'lowerBound'), ['person']), pair('SENT', 'in', count(3), ['person'])]), ask(['person']))).toEqual(heavy(503, 'lowerBound'));
  });

  it('3: two capped pairs sum to a lowerBound', () => {
    expect(heavyDecision(previewOf([pair('A', 'out', count(500, 'lowerBound'), ['person']), pair('B', 'out', count(500, 'lowerBound'), ['person'])]), ask(['person']))).toEqual(heavy(1000, 'lowerBound'));
  });

  it('4: a pair shared with a type that is not asked adds nothing and makes the result a floor', () => {
    const preview = previewOf([pair('SENT', 'out', count(900), ['person', 'company']), pair('OWNS', 'out', count(600), ['person'])]);
    expect(heavyDecision(preview, ask(['person']))).toEqual(heavy(600, 'lowerBound'));
    expect(heavyDecision(preview, ask(['person', 'company']))).toEqual(heavy(1500, 'exact'));
  });

  it('4: a floor below the threshold gives no warning, and only left-out pairs give none', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(900), ['person', 'company']), pair('OWNS', 'out', count(100), ['person'])]), ask(['person']))).toEqual(none);
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(900), ['person', 'company'])]), ask(['person']))).toEqual(none);
  });

  it('5: an unknown pair beside known pairs leaves the known ones as a floor; nothing known gives none', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(undefined), ['person']), pair('OWNS', 'out', count(700), ['person'])]), ask(['person']))).toEqual(heavy(700, 'lowerBound'));
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(undefined), ['person'])]), ask(['person']))).toEqual(none);
  });

  it('6: only the asked relationship types count, and none named means every pair', () => {
    const preview = previewOf([pair('SENT', 'out', count(900), ['person']), pair('OWNS', 'out', count(10), ['person'])]);
    expect(heavyDecision(preview, ask(['person'], ['OWNS']))).toEqual(none);
    expect(heavyDecision(preview, ask(['person'], ['SENT']))).toEqual(heavy(900, 'exact'));
    expect(heavyDecision(preview, ask(['person'], []))).toEqual(heavy(910, 'exact'));
  });

  it('6: a pair of a type that is not asked is not counted', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(9000), ['company'])]), ask(['person']))).toEqual(none);
  });

  it('7: no types, or the preview of another node, gives none', () => {
    const preview = previewOf([pair('SENT', 'out', count(9000), ['person'])]);
    expect(heavyDecision(preview, ask([]))).toEqual(none);
    expect(heavyDecision(preview, { ...ask(['person']), ref: { ...ref, stableId: 'A-2' } })).toEqual(none);
    expect(heavyDecision(preview, { ...ask(['person']), ref: { ...ref, sourceId: 'other' } })).toEqual(none);
  });

  it('uses the threshold of the preview', () => {
    expect(heavyDecision(previewOf([pair('SENT', 'out', count(41), ['person'])], 40), ask(['person']))).toEqual(heavy(41, 'exact', 40));
  });
});
