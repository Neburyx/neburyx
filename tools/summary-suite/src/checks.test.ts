import { describe, expect, it } from 'vitest';
import { expectCited, expectNoText, keysOfSentText, SuiteCheckFailed } from './checks.js';

describe('the check helpers fail on a bad output (canaries)', () => {
  it('canary: expectCited fails on a sentence that cites nothing and on a key that was not sent', () => {
    const sent = new Set(['n1']);
    expect(() => expectCited([{ text: 'x', cites: [] }], sent)).toThrow(SuiteCheckFailed);
    expect(() => expectCited([{ text: 'x', cites: ['n9'] }], sent)).toThrow(SuiteCheckFailed);
    expect(() => expectCited([{ text: 'x', cites: ['n1'] }], sent)).not.toThrow();
  });

  it('canary: expectNoText fails when a record holds a sentinel', () => {
    expect(() => expectNoText([{ detail: 'has SENTINEL inside' }], ['SENTINEL'])).toThrow(SuiteCheckFailed);
    expect(() => expectNoText([{ detail: 'clean' }], ['SENTINEL'])).not.toThrow();
  });

  it.each([['two lines', 'first line\nsecond line'], ['a quote', 'say "this" aloud'], ['a control character', 'bell \u0007 here']])('canary: expectNoText finds a sentinel with %s, as a record holds it', (_name, sentinel) => {
    expect(() => expectNoText([{ nested: [{ detail: `prefix ${sentinel} suffix` }] }], [sentinel])).toThrow(SuiteCheckFailed);
    expect(() => expectNoText([{ detail: 'prefix and suffix only' }], [sentinel])).not.toThrow();
  });

  it('reads the keys of a sent text from the start of its lines only', () => {
    expect(keysOfSentText('n1 | a\ne1 | b\n  n9 | not a key line')).toEqual(new Set(['n1', 'e1']));
  });
});
