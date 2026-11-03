import { describe, expect, it } from 'vitest';
import { FULL_MASK, maskValue } from './mask.js';

describe('the full mask', () => {
  it('is six bullets', () => {
    expect(FULL_MASK).toBe('••••••');
  });

  it.each([
    ['a date', '2026-01-02', 'date'],
    ['a text', 'free text of any length at all, however long it is', 'text'],
    ['no class', 'Ivo Lowe', undefined],
  ] as const)('is what a value gets for %s', (_name, value, piiClass) => {
    expect(maskValue(value, piiClass)).toBe(FULL_MASK);
  });

  it.each([
    ['a number', 4],
    ['a list', ['a']],
    ['a map', { a: 1 }],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
  ])('is what %s gets, whatever its class', (_name, value) => {
    for (const piiClass of ['name', 'email', 'phone', 'date', 'text', undefined] as const) expect(maskValue(value, piiClass)).toBe(FULL_MASK);
  });
});

describe('a name', () => {
  it('shows the initial and three bullets for each word', () => {
    expect(maskValue('Ivo Lowe', 'name')).toBe('I••• L•••');
    expect(maskValue('Mary Jane Watson', 'name')).toBe('M••• J••• W•••');
    expect(maskValue('Cher', 'name')).toBe('C•••');
  });

  it('has the same width for names of different lengths with the same number of words, and keeps each name\'s own initials', () => {
    expect(maskValue('Al Li', 'name')).toBe('A••• L•••');
    expect(maskValue('Alexandria Livingston', 'name')).toBe('A••• L•••');
    expect(maskValue('Al Li', 'name')).toHaveLength(maskValue('Alexandria Livingston', 'name').length);
    expect(maskValue('Bo Cy', 'name')).toBe('B••• C•••');
    expect(maskValue('Bo Cy', 'name')).not.toBe(maskValue('Al Li', 'name'));
  });

  it('counts words by white space of any kind, and takes a whole character as the initial', () => {
    expect(maskValue('  Ivo \t  Lowe  ', 'name')).toBe('I••• L•••');
    expect(maskValue('Émile Zola', 'name')).toBe('É••• Z•••');
    expect(maskValue('😀smile Ok', 'name')).toBe('😀••• O•••');
  });

  it.each([[''], ['   '], ['\n\t']])('is the full mask for the empty name %j', (value) => {
    expect(maskValue(value, 'name')).toBe(FULL_MASK);
  });
});

describe('an email', () => {
  it('shows the initial, three bullets, @ and three bullets', () => {
    expect(maskValue('jane.doe@example.test', 'email')).toBe('j•••@•••');
    expect(maskValue('x@y', 'email')).toBe('x•••@•••');
  });

  it('has the same width for emails of different lengths, and keeps its own initial', () => {
    expect(maskValue('a@b.c', 'email')).toHaveLength(maskValue('someone.with.a.long.name@a-very-long-domain.example.test', 'email').length);
    expect(maskValue('z@b.c', 'email')).toBe('z•••@•••');
  });

  it.each([['no at sign'], ['two@signs@here'], ['@nolocal.test'], ['nodomain@'], ['@'], ['']])('is the full mask when the value is %j, which does not fit', (value) => {
    expect(maskValue(value, 'email')).toBe(FULL_MASK);
  });
});

describe('a phone', () => {
  it('shows the country code, six bullets and the last two digits', () => {
    expect(maskValue('+1-555-8945', 'phone')).toBe('+1 ••••••45');
    expect(maskValue('+44 20 7946 0958', 'phone')).toBe('+44 ••••••58');
    expect(maskValue('+353 (1) 234 5678', 'phone')).toBe('+353 ••••••78');
  });

  it('has the same width for phones with the same country code, and keeps its own last two digits', () => {
    expect(maskValue('+1-555-8945', 'phone')).toHaveLength(maskValue('+1 (800) 555-0100 ext 7', 'phone').length);
    expect(maskValue('+1-555-1234', 'phone')).toBe('+1 ••••••34');
  });

  it.each([
    ['no plus sign', '1-555-8945'],
    ['no separator after the country code', '+15558945'],
    ['fewer than two digits after the country code', '+1-5'],
    ['no digits', '+-'],
    ['a plus sign only', '+'],
    ['text', 'call me'],
    ['empty', ''],
  ])('is the full mask when the value has %s, which does not fit', (_name, value) => {
    expect(maskValue(value, 'phone')).toBe(FULL_MASK);
  });
});

describe('a class is never guessed from the value', () => {
  it('masks an email-looking text fully when the class is text or absent', () => {
    expect(maskValue('jane@example.test', 'text')).toBe(FULL_MASK);
    expect(maskValue('jane@example.test')).toBe(FULL_MASK);
    // the class the mapping gives is the class used: a phone-looking value in a name field is masked as a name
    expect(maskValue('+1-555-8945', 'name')).toBe('+•••');
  });
});
