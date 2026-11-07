import { describe, expect, it } from 'vitest';
import { isWellFormed } from './well-formed.js';
import { decodeStored, encodeStored } from './stored-text.js';

describe('the stored form of an ID', () => {
  it.each(['plain', 'with spaces', 'é😀', '', 'a\u0000b', '\u0000', 'a\ud800b', 'a\udc00b', '\ud800', '~e1:abc', '~e1:', 'x'.repeat(200_000), `${'\u0000'.repeat(1000)}z`])('gives %s back exactly, and holds no NUL or lone surrogate', (text) => {
    const stored = encodeStored(text);
    expect(decodeStored(stored)).toBe(text);
    expect(stored).not.toContain('\u0000');
    expect(isWellFormed(stored)).toBe(true);
  });

  it('leaves an ID that can be held as it is, and reads a marker that is not an encoding as an ID', () => {
    expect(encodeStored('A-1')).toBe('A-1');
    expect(decodeStored('A-1')).toBe('A-1');
    expect(decodeStored('~e1:!!!')).toBe('~e1:!!!');
    expect(decodeStored('~e1:YQ')).toBe('~e1:YQ');
    // a well-formed encoding that encodeStored would not make is an ID that happens to look like one
    expect(decodeStored('~e1:YQA')).toBe('~e1:YQA');
  });
});
