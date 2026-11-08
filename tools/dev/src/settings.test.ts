import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './settings.js';

describe('reading an env file', () => {
  it('reads comments, quotes and blank lines', () => {
    const values = parseEnvFile('# a comment\n\nA=1\nB="two"\n  C = three \nnot a setting\nD=x # not a comment\n');
    expect(Object.fromEntries(values)).toEqual({ A: '1', B: 'two', C: 'three', D: 'x # not a comment' });
  });
});
