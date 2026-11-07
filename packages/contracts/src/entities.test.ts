import { describe, expect, it } from 'vitest';
import { canCarryInPath, entityPathSchema, pathSegmentOf, valueOfPathSegment } from './entities.js';

describe('a value as a path segment', () => {
  it.each([
    ['.', '~.'],
    ['..', '~..'],
    ['...', '~...'],
    ['~', '~~'],
    ['~~', '~~~'],
    ['~.', '~~.'],
    ['~..', '~~..'],
    ['.~', '~.~'],
    ['~abc', '~abc'],
    ['a.b', 'a.b'],
    ['a/b', 'a/b'],
    ['%2E', '%2E'],
    ['9223372036854775807', '9223372036854775807'],
    ['-9223372036854775808', '-9223372036854775808'],
    ['A-1', 'A-1'],
    ['.a', '.a'],
    ['a~', 'a~'],
  ])('sends %j as %j, which comes back as the value and survives a URL parser as one segment', (value, segment) => {
    expect(pathSegmentOf(value)).toBe(segment);
    expect(valueOfPathSegment(segment)).toBe(value);
    const path = new URL(`http://localhost/v1/entities/demo/widget/${encodeURIComponent(segment)}`).pathname;
    expect(path.split('/')).toHaveLength(6);
    expect(valueOfPathSegment(decodeURIComponent(path.split('/')[5] ?? ''))).toBe(value);
  });

  it('takes a segment a client did not escape as the value it spells', () => {
    expect(valueOfPathSegment('..')).toBe('..');
    expect(valueOfPathSegment('.')).toBe('.');
  });

  it('has no value for the bare tilde, which no value is sent as, and does not return an empty string for it', () => {
    expect(valueOfPathSegment('~')).toBeUndefined();
    expect(valueOfPathSegment('')).toBe('');
  });

  it('is one to one: every value comes back, and no segment is a dot segment', () => {
    const alphabet = ['.', '~', 'a'];
    const values: string[] = [];
    for (let length = 1; length <= 5; length += 1) {
      const build = (prefix: string): void => {
        if (prefix.length === length) return void values.push(prefix);
        for (const letter of alphabet) build(prefix + letter);
      };
      build('');
    }
    const segments = new Set<string>();
    for (const value of values) {
      const segment = pathSegmentOf(value);
      expect(valueOfPathSegment(segment), value).toBe(value);
      expect(/^\.+$/.test(segment), value).toBe(false);
      segments.add(segment);
    }
    expect(segments.size).toBe(values.length);
  });
});

describe('the path of an entity read', () => {
  it('gives the values the segments stand for, and counts the length of the value', () => {
    expect(entityPathSchema.parse({ sourceId: 'demo', entityType: '~..', stableId: '~.' })).toEqual({ sourceId: 'demo', entityType: '..', stableId: '.' });
    expect(entityPathSchema.safeParse({ sourceId: 'demo', entityType: 'widget', stableId: `~${'.'.repeat(400)}` }).success).toBe(true);
    for (const unaddressable of ['a\u0000b', 'a\u0085b', 'a\ud800b', 'x'.repeat(401)]) {
      expect(entityPathSchema.safeParse({ sourceId: 'demo', entityType: 'widget', stableId: unaddressable }).success, JSON.stringify(unaddressable)).toBe(false);
    }
    expect(entityPathSchema.safeParse({ sourceId: 'demo', entityType: 'widget', stableId: `~${'.'.repeat(401)}` }).success).toBe(false);
  });

  it.each([
    ['a lone tilde as the stable ID', { sourceId: 'demo', entityType: 'widget', stableId: '~' }],
    ['a lone tilde as the entity type', { sourceId: 'demo', entityType: '~', stableId: 'A-1' }],
  ])('refuses %s as a malformed segment, and not as an empty value', (_name, path) => {
    expect(entityPathSchema.safeParse(path).success).toBe(false);
  });

  it('applies the integer text rule to the value and not to the segment', () => {
    expect(entityPathSchema.parse({ sourceId: 'demo', entityType: 'widget', stableId: '9223372036854775807' }).stableId).toBe('9223372036854775807');
  });
});

describe('the references a path can carry', () => {
  it.each([
    ['an ID of ordinary text', 'W-1', true],
    ['an ID of exactly 400 characters', 'a'.repeat(400), true],
    ['an ID of 401 characters', 'a'.repeat(401), false],
    ['an ID with a control character', 'a\u0000b', false],
    ['an ID with a delete character', 'a\u007fb', false],
    ['an unpaired high surrogate', 'a\ud800', false],
    ['an unpaired low surrogate', '\udc00a', false],
    ['a pair of surrogates', '😀', true],
    ['dots only', '..', true],
  ])('says %s is %s', (_name, reference, expected) => {
    expect(canCarryInPath(reference)).toBe(expected);
  });
});
