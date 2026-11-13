import { ASK_MAX_RESOLUTIONS, ASK_MESSAGE_MAX_LENGTH } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { blockedAfter, canBeSearchValue, codePointCount, editBetween, isTooLong, pickLimitReached, picksAfter, rangeAfter, withoutWord, withPick } from './ask-model.js';

describe('the edit between two texts', () => {
  it('is the one stretch that differs', () => {
    expect(editBetween('which widgets', 'which big widgets')).toEqual({ start: 6, removed: 0, inserted: 4 });
    expect(editBetween('which big widgets', 'which widgets')).toEqual({ start: 6, removed: 4, inserted: 0 });
    expect(editBetween('abc', 'abc')).toEqual({ start: 3, removed: 0, inserted: 0 });
    expect(editBetween('abcd', 'axyd')).toEqual({ start: 1, removed: 2, inserted: 2 });
  });
});

describe('a range after an edit', () => {
  const before = 'one two three four';
  const range = { start: 8, end: 13 };

  it('stays when the edit ends before it starts or starts where it ends and leaves it standing alone', () => {
    expect(rangeAfter(range, { start: 13, removed: 0, inserted: 1 }, before, 'one two three  four')).toEqual(range);
    expect(rangeAfter(range, { start: 15, removed: 4, inserted: 0 }, before, 'one two three ')).toEqual(range);
  });

  it('moves when the edit is before it, also when a space is typed right before it', () => {
    expect(rangeAfter(range, { start: 0, removed: 0, inserted: 3 }, before, 'so one two three four')).toEqual({ start: 11, end: 16 });
    expect(rangeAfter(range, { start: 3, removed: 4, inserted: 0 }, before, 'one three four')).toEqual({ start: 4, end: 9 });
    expect(rangeAfter(range, { start: 8, removed: 0, inserted: 1 }, before, 'one two  three four')).toEqual({ start: 9, end: 14 });
  });

  it('is gone when the edit touches it', () => {
    expect(rangeAfter(range, { start: 10, removed: 0, inserted: 1 }, before, 'one two thxree four')).toBeUndefined();
    expect(rangeAfter(range, { start: 6, removed: 4, inserted: 0 }, before, 'one twoee four')).toBeUndefined();
  });

  it('is gone when a letter or digit is typed against it, or the space before it is taken away', () => {
    expect(rangeAfter(range, { start: 13, removed: 0, inserted: 1 }, before, 'one two threes four')).toBeUndefined();
    expect(rangeAfter(range, { start: 8, removed: 0, inserted: 1 }, before, 'one two xthree four')).toBeUndefined();
    expect(rangeAfter(range, { start: 7, removed: 1, inserted: 0 }, before, 'one twothree four')).toBeUndefined();
    expect(rangeAfter(range, { start: 13, removed: 0, inserted: 1 }, before, 'one two three4 four')).toBeUndefined();
  });
});

describe('the picks and the blocked words after an edit', () => {
  it('keep the ones before, move the ones after and drop the ones touched', () => {
    const before = 'abc  defg  hijk';
    const picks = [
      { start: 0, end: 3, value: true as const },
      { start: 5, end: 9, value: true as const },
    ];
    expect(picksAfter(picks, { start: 4, removed: 0, inserted: 2 }, before, 'abc    defg  hijk')).toEqual([picks[0], { start: 7, end: 11, value: true }]);
    expect(picksAfter(picks, { start: 6, removed: 1, inserted: 1 }, before, 'abc  dxfg  hijk')).toEqual([picks[0]]);
  });

  it('move a blocked word and drop it when it is changed', () => {
    const tokens = [{ start: 6, end: 13, text: 'zorvath' }];
    expect(blockedAfter(tokens, { start: 0, removed: 0, inserted: 3 }, 'which zorvath', 'xx which zorvath')).toEqual([{ start: 9, end: 16, text: 'zorvath' }]);
    expect(blockedAfter(tokens, { start: 8, removed: 1, inserted: 0 }, 'which zorvath', 'which zrvath')).toEqual([]);
  });
});

describe('removing a word', () => {
  it('takes the space before it, else the space after it, and says what changed', () => {
    expect(withoutWord('which zorvath share', { start: 6, end: 13 })).toEqual({ text: 'which share', edit: { start: 5, removed: 8, inserted: 0 } });
    expect(withoutWord('zorvath is here', { start: 0, end: 7 })).toEqual({ text: 'is here', edit: { start: 0, removed: 8, inserted: 0 } });
    expect(withoutWord('which zorvath', { start: 6, end: 13 })).toEqual({ text: 'which', edit: { start: 5, removed: 8, inserted: 0 } });
  });

  it('keeps the offsets right after an emoji (two code units)', () => {
    const text = '😀 zorvath ok';
    const start = text.indexOf('zorvath');
    expect(withoutWord(text, { start, end: start + 7 }).text).toBe('😀 ok');
  });
});

describe('the limits', () => {
  it('counts the question in code points and the picks against the contract', () => {
    expect(codePointCount('😀')).toBe(1);
    expect(isTooLong('😀'.repeat(ASK_MESSAGE_MAX_LENGTH))).toBe(false);
    expect(isTooLong('😀'.repeat(ASK_MESSAGE_MAX_LENGTH).length > ASK_MESSAGE_MAX_LENGTH ? `${'😀'.repeat(ASK_MESSAGE_MAX_LENGTH)}x` : '')).toBe(true);
    expect(pickLimitReached(Array.from({ length: ASK_MAX_RESOLUTIONS }, (_, index) => ({ start: index, end: index + 1, value: true as const })))).toBe(true);
  });

  it('allows a search value only for a word that starts and ends on a letter or digit and is short enough', () => {
    expect(canBeSearchValue('zorvath')).toBe(true);
    expect(canBeSearchValue('a')).toBe(true);
    expect(canBeSearchValue('(zorvath)')).toBe(false);
    expect(canBeSearchValue('x'.repeat(201))).toBe(false);
  });

  it('keeps one pick for a range', () => {
    const first = { start: 0, end: 3, value: true as const };
    const again = { start: 0, end: 3, ref: { sourceId: 's', entityType: 't', stableId: 'i' } };
    expect(withPick([first], again)).toEqual([again]);
  });
});
