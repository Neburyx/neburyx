import { COVERAGE_SCOPE, type Count, type DegreePreview } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { notRetrievedOf, type CoveragePart } from './coverage-sum.js';

const preview = (total: Count | undefined): DegreePreview | undefined =>
  total === undefined ? undefined : { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W' }, total, byType: [], byNeighborType: [], warnings: [], pageSize: 25 };
const count = (value: number, quality: Exclude<Count['quality'], 'unknown'>): Count => ({ value, quality, scope: 'degree:total' });
const part = (total: Count | undefined, loadedRelationships = 0, loadedExact = true): CoveragePart => ({ preview: preview(total), loadedRelationships, loadedExact });
const answer = (value: number, quality: Count['quality']): Count => ({ value, quality, scope: COVERAGE_SCOPE });
const unknown: Count = { quality: 'unknown', scope: COVERAGE_SCOPE };

describe('the not-yet-retrieved count', () => {
  const cases: readonly (readonly [string, readonly CoveragePart[], Count])[] = [
    ['one contributor, every preview exact', [part(count(7, 'exact'), 2)], answer(5, 'exact')],
    ['one contributor beside an exact part with nothing left', [part(count(7, 'exact'), 2), part(count(3, 'exact'), 3)], answer(5, 'exact')],
    ['two contributors, every preview exact', [part(count(7, 'exact'), 2), part(count(4, 'exact'), 1)], answer(8, 'estimated')],
    ['two contributors that share a relationship are still not exact', [part(count(1, 'exact'), 0), part(count(1, 'exact'), 0)], answer(2, 'estimated')],
    ['nothing left anywhere', [part(count(3, 'exact'), 3), part(count(2, 'exact'), 2)], answer(0, 'exact')],
    ['an estimated preview that contributes', [part(count(40, 'estimated'), 2)], answer(38, 'estimated')],
    ['a lowerBound preview alone', [part(count(500, 'lowerBound'), 20)], answer(480, 'lowerBound')],
    ['a lowerBound part with nothing left beside one exact contributor', [part(count(500, 'lowerBound'), 500), part(count(9, 'exact'), 1)], answer(8, 'lowerBound')],
    ['the largest remainder, not the sum, of two lowerBound parts', [part(count(500, 'lowerBound'), 0), part(count(300, 'lowerBound'), 0)], answer(500, 'lowerBound')],
    ['an estimated remainder is no floor beside a lowerBound part', [part(count(900, 'estimated'), 0), part(count(500, 'lowerBound'), 400)], answer(100, 'lowerBound')],
    ['an estimated part alone with a lowerBound part that has nothing left gives a floor of 0', [part(count(900, 'estimated'), 0), part(count(500, 'lowerBound'), 500)], answer(0, 'lowerBound')],
    ['an exact preview older than the loads is clamped and at best estimated', [part(count(2, 'exact'), 3)], answer(0, 'estimated')],
    ['an estimated preview older than the loads is clamped', [part(count(2, 'estimated'), 3), part(count(4, 'exact'), 1)], answer(3, 'estimated')],
    ['a lowerBound preview with more loaded than its value stays lowerBound, not estimated', [part(count(500, 'lowerBound'), 600)], answer(0, 'lowerBound')],
    ['a clamped exact remainder gives no floor beside a lowerBound part', [part(count(2, 'exact'), 3), part(count(500, 'lowerBound'), 100)], answer(400, 'lowerBound')],
    ['aggregates loaded at the one entity with a remainder leave it exact', [part(count(184533, 'exact'), 52)], answer(184481, 'exact')],
    ['a loaded count resting on an inexact member count makes the remainder estimated', [part(count(100, 'exact'), 10, false)], answer(90, 'estimated')],
    ['an inexact loaded count is no floor beside an unknown part', [part(count(100, 'exact'), 10, false), part(undefined)], unknown],
    ['an inexact loaded count on a lowerBound total gives no floor', [part(count(500, 'lowerBound'), 20, false), part(count(9, 'exact'), 1)], answer(8, 'lowerBound')],
    ['an inexact part does not stop an exact part from being the floor beside an unknown part', [part(count(100, 'exact'), 10, false), part(count(9, 'exact'), 1), part(undefined)], answer(8, 'lowerBound')],
    ['an unknown part beside an exact remainder gives that remainder as a floor', [part(count(184533, 'exact'), 52), part(undefined), part(undefined)], answer(184481, 'lowerBound')],
    ['an unknown part beside a lowerBound remainder gives the largest remainder as a floor', [part(count(500, 'lowerBound'), 20), part(undefined), part(count(300, 'lowerBound'), 0)], answer(480, 'lowerBound')],
    ['an unknown part beside two exact remainders gives the larger, not the sum', [part(count(7, 'exact'), 2), part(count(4, 'exact'), 0), part(undefined)], answer(5, 'lowerBound')],
    ['every part unknown', [part(undefined), part({ quality: 'unknown', scope: 'degree:total' })], unknown],
    ['an unknown part beside only an estimated remainder stays unknown', [part(count(40, 'estimated'), 2), part(undefined)], unknown],
    ['an unknown part beside only a clamped remainder stays unknown', [part(count(2, 'exact'), 3), part(undefined)], unknown],
    ['an unknown part beside a remainder of 0 stays unknown', [part(count(3, 'exact'), 3), part(undefined)], unknown],
    ['the sum above the largest safe integer', [part(count(Number.MAX_SAFE_INTEGER, 'exact')), part(count(1, 'exact'))], unknown],
  ];
  it.each(cases)('%s', (_name, parts, expected) => {
    expect(notRetrievedOf(parts)).toEqual(expected);
  });

  it('subtracts a self-loop once for each of its two ends', () => {
    expect(notRetrievedOf([part(count(5, 'exact'), 2)])).toEqual(answer(3, 'exact'));
  });
});
