import { describe, expect, it } from 'vitest';
import type { Field } from '../form-model.js';
import { fieldsSummary, paramsInWords } from './preset-summary.js';

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
      { label: 'Window (UTC)', text: '2026-10-21 – 2026-10-28' },
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
    expect(paramsInWords({ labels }, { ref: { entityType: 'a', stableId: 'x' }, window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25, minShared: 2, via: ['PAYS'] })).toBe('Window (UTC) 2026-10-21 – 2026-10-28, Max matching accounts 25, Min shared 2, Via PAYS');
  });

  it('is empty for no parameters', () => {
    expect(paramsInWords({ labels }, {})).toBe('');
  });

  it('writes a relative window by its days and skips what it cannot read without throwing', () => {
    expect(paramsInWords({ labels }, { window: { days: 1 } })).toBe('Window (UTC) Last 1 day');
    expect(paramsInWords({ labels }, { window: { from: 5, to: {} }, limit: null, via: [] })).toBe('');
  });
});
