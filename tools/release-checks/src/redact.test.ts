import { describe, expect, it } from 'vitest';
import { longEnough, redact, secretValues } from './redact.js';

describe('redact', () => {
  it('masks every occurrence of a secret', () => {
    expect(redact('a pw1234 b pw1234', ['pw1234'])).toBe('a *** b ***');
  });

  it('masks the longer secret whole when one holds another', () => {
    expect(redact('bolt://host:7687 host', ['host', 'bolt://host:7687'])).toBe('*** ***');
  });

  it('reads only the named settings, and not a value shorter than three characters', () => {
    expect(secretValues({ NBX_EE_PASSWORD: 'long-enough', NBX_EE_USER: 'ab', OTHER: 'xxxxxx' })).toEqual(['long-enough']);
  });

  it('drops values shorter than three characters', () => {
    expect(longEnough(['ab', 'abc', ''])).toEqual(['abc']);
  });
});
