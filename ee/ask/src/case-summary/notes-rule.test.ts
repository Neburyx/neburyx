import { describe, expect, it } from 'vitest';
import { checkStorable } from './notes-rule.js';
import { NOTES_WORD_LIST_VERSION, NOTES_WORDS } from './notes-words.js';

const NUMBER_WORDS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion'.split(' ');
const ORDINALS = 'primary secondary tertiary first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth twentieth hundredth thousandth'.split(' ');
const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const WEEKDAYS = 'monday tuesday wednesday thursday friday saturday sunday'.split(' ');
const RELATIVE_TIME = 'yesterday today tomorrow tonight recently now ago earlier later soon currently formerly lately once twice again before-now last next previous latest'.split(' ');
const QUANTITIES = 'dozen pair pairs paired couple several many few both all most some none any much more less fewer least multiple numerous single double triple half whole each every another other no one'.split(' ');

describe('the fixed word list', () => {
  it('is versioned', () => {
    expect(NOTES_WORD_LIST_VERSION).toBe(1);
  });

  it.each([
    ['number words', NUMBER_WORDS],
    ['ordinals', ORDINALS],
    ['month names', MONTHS],
    ['weekday names', WEEKDAYS],
    ['relative-time words', RELATIVE_TIME],
    ['quantity words, vague ones included', QUANTITIES],
  ])('holds no word of the category: %s', (_name, words) => {
    expect(words.filter((word) => NOTES_WORDS.has(word))).toEqual([]);
  });

  it('holds only lower-case letters', () => {
    expect([...NOTES_WORDS].filter((word) => !/^[a-z]+$/.test(word))).toEqual([]);
  });
});

describe('the storage rule on plain words', () => {
  it('stores a sentence of listed words, with a capital first letter at the start of a sentence', () => {
    expect(checkStorable('This record is linked to the same source. It shows the shared structure.')).toEqual({ storable: true, wordListVersion: NOTES_WORD_LIST_VERSION });
  });

  it.each([
    ['an unlisted word', 'The record is suspicious.', 'unlisted-word'],
    ['a digit', 'The record has 3 sources.', 'number-or-date'],
    ['a date', 'It was opened on 2026-11-15.', 'number-or-date'],
    ['a month name', 'It was noted in June.', 'number-or-date'],
    ['a quantity word', 'Several records are linked.', 'unlisted-word'],
    ['a number word', 'The record has two sources.', 'number-or-date'],
    ['a name inside the sentence', 'The record is linked to Weldinum.', 'name'],
    ['a listed word in another case', 'The RECORD is linked.', 'unlisted-word'],
    ['a look-alike character', 'The rеcord is linked.', 'unlisted-word'],
    ['a zero-width character', 'The rec​ord is linked.', 'unlisted-word'],
    ['a made-up placeholder', 'The ‹account#1› is linked.', 'unlisted-word'],
    ['a symbol', 'The record is linked to $ sources.', 'unlisted-word'],
  ])('refuses %s', (_name, text, reason) => {
    expect(checkStorable(text)).toEqual({ storable: false, reason, wordListVersion: NOTES_WORD_LIST_VERSION });
  });

  it('accepts a placeholder the conversion made and refuses one it did not', () => {
    const made = new Set(['‹kind#1›']);
    expect(checkStorable('The ‹kind#1› is linked to the same source.', made).storable).toBe(true);
    expect(checkStorable('The ‹kind#2› is linked to the same source.', made).storable).toBe(false);
  });

  it('answers the same twice', () => {
    const text = 'The record is linked to the same source.';
    expect(checkStorable(text)).toEqual(checkStorable(text));
  });
});
