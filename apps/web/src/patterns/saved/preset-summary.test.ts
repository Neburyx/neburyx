import { describe, expect, it } from 'vitest';
import type { Field } from '../form-model.js';
import { dateRange, fieldsSummary, paramsInWords, windowName } from './preset-summary.js';

const FIELDS: readonly Field[] = [
  { name: 'window', label: 'Window (UTC)', kind: 'window' },
  { name: 'direction', label: 'Direction', kind: 'choice', options: [{ value: 'out', text: 'Outgoing' }] },
  { name: 'via', label: 'Via', kind: 'choice', list: true, options: [{ value: 'PAYS', text: 'PAYS' }] },
  { name: 'limit', label: 'Limit', kind: 'integer' },
  { name: 'minShared', label: 'Min shared', kind: 'integer' },
];

describe('the summary of the parameters of a built-in run', () => {
  it('lists each field that holds a value in the form’s labels, the choices by their text and the window as two dates, and never the starting entity', () => {
    expect(fieldsSummary(FIELDS, { ref: { entityType: 'a', stableId: 'x' }, window: { from: '2026-10-21', to: '2026-10-28' }, direction: 'out', via: ['PAYS'], limit: 25 })).toEqual([
      { label: 'Window (UTC)', text: '21–28 Oct 2026' },
      { label: 'Direction', text: 'Outgoing' },
      { label: 'Via', text: 'PAYS' },
      { label: 'Limit', text: '25' },
    ]);
  });

  it('lists nothing for parameters that are not set', () => {
    expect(fieldsSummary(FIELDS, {})).toEqual([]);
  });

  it('writes a relative window by its days, and lists nothing for a stored window or value it cannot read', () => {
    expect(fieldsSummary(FIELDS, { window: { days: 14 }, limit: 25 })).toEqual([
      { label: 'Window (UTC)', text: 'Last 14 days' },
      { label: 'Limit', text: '25' },
    ]);
    expect(fieldsSummary(FIELDS, { window: { from: 3, to: null }, limit: { nested: true }, via: [] })).toEqual([]);
  });
});

describe('the stored parameters of a saved run in a line', () => {
  const labels = [{ key: 'limit', text: 'Max matching accounts' }, { key: 'window', text: 'Window (UTC)' }];

  it('uses the preset’s labels or the parameter’s plain name, writes a window as two dates and a list by its first value, and never lists the starting entity', () => {
    expect(paramsInWords({ labels }, { ref: { entityType: 'a', stableId: 'x' }, window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25, minShared: 2, via: ['PAYS'] })).toBe('Window (UTC) 21–28 Oct 2026, Max matching accounts 25, Min shared 2, Via PAYS');
  });

  it('is empty for no parameters', () => {
    expect(paramsInWords({ labels }, {})).toBe('');
  });

  it('writes a relative window by its days and skips what it cannot read without throwing', () => {
    expect(paramsInWords({ labels }, { window: { days: 1 } })).toBe('Window (UTC) Last 1 day');
    expect(paramsInWords({ labels }, { window: { from: 5, to: {} }, limit: null, via: [] })).toBe('');
  });
});

describe('the dates of a window as the frames write them', () => {
  it('writes one month with the days joined, two months and two years in full, and a day alone', () => {
    expect(dateRange('2026-10-21', '2026-10-28')).toBe('21–28 Oct 2026');
    expect(dateRange('2026-10-28', '2026-11-03')).toBe('28 Oct – 3 Nov 2026');
    expect(dateRange('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 – 3 Jan 2027');
    expect(dateRange('2026-10-21', '2026-10-21')).toBe('21 Oct 2026');
  });

  it('keeps a day that is not on the calendar as it was written, and knows a leap day', () => {
    expect(dateRange('2026-02-31', '2026-03-02')).toBe('2026-02-31 – 2026-03-02');
    expect(dateRange('2027-02-29', '2027-03-02')).toBe('2027-02-29 – 2027-03-02');
    expect(dateRange('2028-02-27', '2028-02-29')).toBe('27–29 Feb 2028');
  });

  it('keeps a value that is not a date as it was written', () => {
    expect(dateRange('soon', '2026-10-28')).toBe('soon – 2026-10-28');
    expect(dateRange('2026-13-01', '2026-10-28')).toBe('2026-13-01 – 2026-10-28');
  });

  it('names a window by its days or its dates, and none for a run without one', () => {
    expect(windowName({ window: { days: 7 } })).toBe('7-day window');
    expect(windowName({ window: { from: '2026-10-21', to: '2026-10-28' } })).toBe('21–28 Oct 2026');
    expect(windowName({ limit: 25 })).toBeUndefined();
    expect(windowName({ window: 'x' })).toBeUndefined();
  });
});
