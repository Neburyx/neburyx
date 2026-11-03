import { describe, expect, it } from 'vitest';
import { saveStateText } from './save-state-text.js';

describe('the save state text', () => {
  it.each([
    ['2026-10-28T09:42:00Z', 'Saved 09:42 UTC'],
    ['2026-10-28T23:59:59.999Z', 'Saved 23:59 UTC'],
    ['2026-10-29T00:00:00Z', 'Saved 00:00 UTC'],
    ['2026-10-29T01:30:00+02:00', 'Saved 23:30 UTC'],
  ])('says %s as %j', (at, expected) => {
    expect(saveStateText({ kind: 'saved', at })).toBe(expected);
  });

  it('says Unsaved for an unsaved investigation', () => {
    expect(saveStateText({ kind: 'unsaved' })).toBe('Unsaved');
  });
});
