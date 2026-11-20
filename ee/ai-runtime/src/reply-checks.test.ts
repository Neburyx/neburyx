import { describe, expect, it } from 'vitest';
import { createCheckRunner } from './check-runner.js';
import { judgeSentences, judgeInput, parseJudged, type CheckedText, type JudgeInput, type Judged } from './reply-checks.js';

const TEXT: CheckedText = {
  text: 'n1: Ledger A (id a1)\nn2: Ledger B (id b2)',
  keys: new Map([['n1', 'entity'], ['n2', 'entity']]),
  lines: new Map([['n1', 'Ledger A (id a1)'], ['n2', 'Ledger B (id b2)']]),
  inexactCounts: [],
  unknownCountKeys: new Set(),
};

describe('the shared reply checks on a text built without the summary', () => {
  it('keeps a sentence that cites a key the text holds', () => {
    expect(judgeSentences([{ text: 'Ledger A is listed.', cites: ['n1'] }], TEXT).kept).toHaveLength(1);
  });

  it('removes a sentence that cites a key the text does not hold', () => {
    const judged = judgeSentences([{ text: 'Ledger A is listed.', cites: ['n9'] }], TEXT);
    expect(judged.kept).toEqual([]);
    expect(judged.removed).toBe(1);
  });

  it('removes a sentence with a number that is not on the cited lines', () => {
    expect(judgeSentences([{ text: 'Ledger A has 7311 rows.', cites: ['n1'] }], TEXT).kept).toEqual([]);
  });
});

describe('the check as a worker thread runs it', () => {
  const sentences = [{ text: 'Ledger A is listed.', cites: ['n1'] }, { text: 'Ledger A has 7311 rows.', cites: ['n1'] }];

  it('gives the same result in a worker as in place, with the real check module', async () => {
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 5, clock: () => now, workerUrl: new URL('./check-worker.ts', import.meta.url) });
    const check = { name: 'judge', inline: (input: JudgeInput): Judged => (now += 100, judgeInput(input)), module: { url: new URL('./reply-checks.ts', import.meta.url).href, exportName: 'judgeInput' }, parse: parseJudged };
    const inPlace = await runner.run(check, { sentences, text: TEXT }, { timeoutMs: 5000 });
    const inWorker = await runner.run(check, { sentences, text: TEXT }, { timeoutMs: 5000 });
    expect(inPlace).toEqual({ status: 'done', value: judgeSentences(sentences, TEXT) });
    expect(inWorker).toEqual(inPlace);
  });

  it('reads only the result of the check', () => {
    expect(parseJudged({ kept: [{ text: 'x', cites: ['n1'] }], removed: 0, keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeDefined();
    expect(parseJudged({ kept: 'x' })).toBeUndefined();
    expect(parseJudged({ kept: [{ text: 1 }], removed: 0, keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeUndefined();
  });
});

describe('a conclusion that is denied is no verdict, and no other word of the verdict list is excused', () => {
  const verdict = (text: string): boolean => judgeSentences([{ text, cites: ['n1'] }], TEXT).verdictFound;

  it.each([
    'No conclusion can be drawn about Ledger A.',
    'Ledger A cannot be concluded to mean anything.',
    'The elements do not support a conclusion.',
    'Nothing is a conclusion about Ledger A.',
    'Ledger A is listed without any conclusion.',
    'One cannot conclude more than what Ledger A shows.',
  ])('does not count %s', (text) => {
    expect(verdict(text)).toBe(false);
  });

  it.each([
    'Ledger A leads to the conclusion that it is a risk.',
    'We can conclude that Ledger A matters.',
    'Not only can we conclude it, the pattern repeats.',
    'Not only concluded, Ledger A is flagged.',
    'The elements, in short, give no hint at all, so the conclusion stands.',
    'There is no conclusion other than that Ledger A is responsible for it.',
    'One cannot conclude it is not fraud.',
    'No conclusion can be drawn, but this is fraud.',
  ])('still counts %s', (text) => {
    expect(verdict(text)).toBe(true);
  });
});

describe('the checks of a sentence that cites a meaning line', () => {
  const MEANING = 'm1: entity type Ledger: "A ledger holds up to 12 entries."';
  const WITH_MEANING: CheckedText = {
    ...TEXT,
    keys: new Map([...TEXT.keys, ['m1', true]]),
    lines: new Map([...TEXT.lines, ['m1', MEANING]]),
    descriptionKeys: new Set(['m1']),
  };

  it('keeps a sentence that restates the meaning, the number in it included', () => {
    expect(judgeSentences([{ text: 'A ledger holds up to 12 entries.', cites: ['m1'] }], WITH_MEANING).kept).toHaveLength(1);
  });

  it('removes a sentence that names what the meaning does not hold', () => {
    expect(judgeSentences([{ text: 'A ledger holds Zeta entries.', cites: ['m1'] }], WITH_MEANING).kept).toEqual([]);
  });

  it('holds a number about an element to the element lines, not to the meaning', () => {
    expect(judgeSentences([{ text: 'Ledger A holds 12 entries.', cites: ['n1', 'm1'] }], WITH_MEANING).kept).toEqual([]);
  });

  it('rejects a verdict word in a description and exempts only the type name', () => {
    const verdict: CheckedText = { ...WITH_MEANING, lines: new Map([...WITH_MEANING.lines, ['m1', 'm1: entity type Ledger: "A ledger that is proof of fraud."']]) };
    expect(judgeSentences([{ text: 'A ledger that is proof of fraud.', cites: ['m1'] }], verdict).verdictFound).toBe(true);
    const named: CheckedText = { ...WITH_MEANING, lines: new Map([...WITH_MEANING.lines, ['m1', 'm1: entity type Fraud Ledger: "A book of entries."']]) };
    expect(judgeSentences([{ text: 'A Fraud Ledger.', cites: ['m1'] }], named).verdictFound).toBe(false);
  });
});

describe('the lines of the typology, cited by keys of their own', () => {
  const LINES: CheckedText = {
    text: 'n1: Ledger A (id a1)\nt1: Fan-in: many sources send money to one receiver.',
    keys: new Map<string, unknown>([['n1', 'entity'], ['t1', true], ['s1', true]]),
    lines: new Map([['n1', 'Ledger A (id a1)'], ['t1', 't1: Fan-in: many sources send money to one receiver.'], ['s1', 's1: read of typology: 1 line']]),
    inexactCounts: [],
    unknownCountKeys: new Set(),
    readKeys: new Set(['s1', 't1']),
  };

  it('takes a key in brackets out of the shown text, as it does for an element', () => {
    const judged = judgeSentences([{ text: 'A fan-in is many sources sending money to one receiver (t1).', cites: ['t1'] }], LINES);
    expect(judged.kept).toEqual([{ text: 'A fan-in is many sources sending money to one receiver.', cites: ['t1'] }]);
    expect(judged.keysStripped).toBe(1);
  });

  it('removes a sentence that writes the key where a name stands', () => {
    const judged = judgeSentences([{ text: 't1 describes many sources sending money to one receiver.', cites: ['t1'] }], LINES);
    expect(judged.kept).toEqual([]);
    expect(judged.keysRemoved).toBe(1);
  });

  it('checks a sentence that cites only typology lines for names against those lines, so it cannot name an element it does not cite', () => {
    expect(judgeSentences([{ text: 'A fan-in is many sources sending money to one receiver.', cites: ['t1'] }], LINES).kept).toHaveLength(1);
    expect(judgeSentences([{ text: 'Ledger A is a fan-in.', cites: ['t1'] }], LINES).kept).toEqual([]);
    expect(judgeSentences([{ text: 'Ledger A is a fan-in.', cites: ['t1', 'n1'] }], LINES).kept).toHaveLength(1);
  });
});

