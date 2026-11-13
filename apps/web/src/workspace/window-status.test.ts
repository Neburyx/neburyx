import type { Count } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ExpandStore, TypeProgress } from '../api/expand-store.js';
import { windowAllTimeText } from './expand-copy.js';
import { narrowingWindowOf, showAllTime, windowStatusOf } from './window-status.js';

const progress = (over: Partial<TypeProgress> = {}): TypeProgress => ({ loaded: 3, hasMore: true, cursor: 'c', restartNeeded: false, ...over });
const windowCount = (value: number | undefined, quality: Count['quality'] = 'exact'): Count => ({ ...(value === undefined ? {} : { value }), quality, scope: 'expand:window' });

describe('the window of a chain that narrows it', () => {
  it('is the number of days when the server says it applied to some type', () => {
    expect(narrowingWindowOf({ days: 7 }, progress({ window: { applied: 'full', notAppliedTo: [] } }))).toEqual({ days: 7 });
    expect(narrowingWindowOf({ days: 7 }, progress({ window: { applied: 'partial', notAppliedTo: ['B'] } }))).toEqual({ days: 7 });
  });

  it.each([
    ['all time', 'all' as const, progress({ window: { applied: 'full', notAppliedTo: [] } })],
    ['no window chosen', undefined, progress()],
    ['an answer that says nothing of a window', { days: 7 }, progress()],
    ['a window that applied to none', { days: 7 }, progress({ window: { applied: 'none', notAppliedTo: ['A'] } })],
    ['no progress yet', { days: 7 }, undefined],
  ])('is none for %s', (_name, window, state) => {
    expect(narrowingWindowOf(window, state)).toBeUndefined();
  });
});

describe('what the controls say of a windowed chain', () => {
  it('says the count as a count for the window with its quality, and never as a total', () => {
    const status = windowStatusOf({ days: 7 }, progress({ matching: windowCount(41), window: { applied: 'full', notAppliedTo: [] } }));
    expect(status?.count).toBe('In the last 7 days: 41 · exact');
    expect(windowStatusOf({ days: 30 }, progress({ matching: windowCount(2000, 'lowerBound'), window: { applied: 'full', notAppliedTo: [] } }))?.count).toBe('In the last 30 days: ≥ 2,000 · lower bound');
    expect(windowStatusOf({ days: 1 }, progress({ matching: windowCount(5), window: { applied: 'full', notAppliedTo: [] } }))?.count).toBe('In the last day: 5 · exact');
  });

  it('says for a partly windowed page which types it was all time for', () => {
    const status = windowStatusOf({ days: 7 }, progress({ matching: windowCount(9), window: { applied: 'partial', notAppliedTo: ['TOUCHED', 'MET'] } }));
    expect(status?.count).toBe('In the last 7 days for dated relationships, all time for TOUCHED, MET: 9 · exact');
    expect(status?.notes).toEqual(['Not filtered by date: TOUCHED, MET.', 'Relationships with no date are not included.']);
  });

  it('says it could not count when the count has no number, and offers no number', () => {
    const status = windowStatusOf({ days: 7 }, progress({ matching: windowCount(undefined, 'unknown'), window: { applied: 'full', notAppliedTo: [] } }));
    expect(status?.count).toBe('The relationships in the window could not be counted.');
  });

  it('gives no count line for a count that is not for the window', () => {
    const status = windowStatusOf({ days: 7 }, progress({ matching: { value: 4, quality: 'exact', scope: 'expand:count' }, window: { applied: 'full', notAppliedTo: [] } }));
    expect(status?.count).toBeUndefined();
  });

  it('says a rule that is true whatever the number: with no number, with a number, and nothing for none left out', () => {
    const base = { matching: windowCount(3) };
    expect(windowStatusOf({ days: 7 }, progress({ ...base, window: { applied: 'full', notAppliedTo: [] } }))?.notes).toEqual(['Relationships with no date are not included.']);
    expect(windowStatusOf({ days: 7 }, progress({ ...base, window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 0 } }))?.notes).toEqual([]);
    expect(windowStatusOf({ days: 7 }, progress({ ...base, window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 6 } }))?.notes).toEqual(['6 relationships with no date are not included.']);
    expect(windowStatusOf({ days: 7 }, progress({ ...base, window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 1 } }))?.notes).toEqual(['1 relationship with no date is not included.']);
  });

  it('says everything in the window is loaded only when the chain has ended', () => {
    const window = { applied: 'full' as const, notAppliedTo: [] };
    expect(windowStatusOf({ days: 7 }, progress({ window, hasMore: false, cursor: undefined }))?.ended).toBe('Everything in the last 7 days is loaded. Choose a longer window or All time for more.');
    expect(windowStatusOf({ days: 7 }, progress({ window }))?.ended).toBeUndefined();
    expect(windowStatusOf({ days: 7 }, progress({ window, hasMore: false, restartNeeded: true }))?.ended).toBeUndefined();
  });

  it('says nothing for all time, for a window that applied to none and for no chain', () => {
    expect(windowStatusOf('all', progress())).toBeUndefined();
    expect(windowStatusOf({ days: 7 }, progress({ window: { applied: 'none', notAppliedTo: ['A'] } }))).toBeUndefined();
    expect(windowStatusOf(undefined, undefined)).toBeUndefined();
  });
});

describe('a window that leaves nothing', () => {
  it('is empty when the chain ended with nothing loaded, and says nothing of a count or of everything loaded', () => {
    const status = windowStatusOf({ days: 7 }, progress({ hasMore: false, inChain: 0, matching: windowCount(0), window: { applied: 'full', notAppliedTo: [] } }));
    expect(status?.empty).toEqual({ days: 7 });
    expect(status?.count).toBeUndefined();
    expect(status?.ended).toBeUndefined();
  });

  it.each([
    ['pages follow', progress({ hasMore: true, inChain: 0, window: { applied: 'full', notAppliedTo: [] } })],
    ['something was loaded', progress({ hasMore: false, inChain: 2, window: { applied: 'full', notAppliedTo: [] } })],
  ])('is not empty when %s', (_name, state) => {
    expect(windowStatusOf({ days: 7 }, state)?.empty).toBeUndefined();
  });
});

describe('a window that leaves nothing under filters', () => {
  it('is not named as the cause, and does not say everything in the window is loaded', () => {
    const status = windowStatusOf({ days: 7 }, progress({ hasMore: false, inChain: 0, window: { applied: 'full', notAppliedTo: [] } }), true);
    expect(status?.empty).toBeUndefined();
    expect(status?.ended).toBeUndefined();
  });
});

describe('the all-time degree beside an empty window', () => {
  it.each([
    [{ value: 40, quality: 'exact', scope: 's' }, '40 relationships in all time (exact).'],
    [{ value: 1, quality: 'exact', scope: 's' }, '1 relationship in all time (exact).'],
    [{ value: 3300, quality: 'estimated', scope: 's' }, '~ 3,300 (estimated) relationships in all time.'],
    [{ value: 3300, quality: 'lowerBound', scope: 's' }, '≥ 3,300 · lower bound relationships in all time.'],
    [{ quality: 'unknown', scope: 's' }, undefined],
    [undefined, undefined],
  ] as Array<[Count | undefined, string | undefined]>)('says %j as %s', (count, text) => {
    expect(windowAllTimeText(count)).toBe(text);
  });
});

describe('widening to all time', () => {
  it('asks the chain again with its own relationship types, filters and rank, and only the window changed', () => {
    const load = vi.fn(async () => 'ok');
    const setWindow = vi.fn();
    const store = {
      load,
      setWindow,
      refinementOf: () => ({ filters: [], rank: { on: 'neighbor', property: 'band', direction: 'desc' }, window: { days: 7 } }),
      relTypesOf: () => ['link-a'],
    } as unknown as ExpandStore;
    showAllTime(store, { sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, 'type-b');
    expect(setWindow).toHaveBeenCalledWith({ sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, 'all');
    expect(load).toHaveBeenCalledWith({ sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, { first: ['type-b'], more: [], relTypes: ['link-a'], refinement: { filters: [], rank: { on: 'neighbor', property: 'band', direction: 'desc' }, window: 'all' } });
  });
});
