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


describe('the comparison check: the larger is named only from lines that show what is compared', () => {
  const LINES = new Map([
    ['r1', 'r1: transaction: Transaction T-1 | figure: 4200; lane: "online"'],
    ['r2', 'r2: transaction: Transaction T-2 | figure: 5000; lane: "branch"'],
    ['r3', 'r3: transaction: Transaction T-3 | stamp: "2026-01-02"; lane: "online"'],
    ['r4', 'r4: customer: Customer C-1 | tier: "retail"'],
    ['r5', 'r5: PAID: Transaction T-1 → Transaction T-2 | stored | figure: 12'],
    ['r6', 'r6: PAID: Transaction T-2 → Transaction T-3 | stored'],
    ['s1', 's1: read of byAccount: 3 shown · exact'],
    ['s2', 's2: read of byDevice: 1 shown · exact'],
  ]);
  const LINES_TEXT: CheckedText = {
    text: [...LINES.values()].join('\n'),
    keys: new Map<string, unknown>([...LINES.keys()].map((key) => [key, true])),
    lines: LINES,
    elementTypes: new Map([['r1', 'entity transaction'], ['r2', 'entity transaction'], ['r3', 'entity transaction'], ['r4', 'entity customer'], ['r5', 'relationship PAID'], ['r6', 'relationship PAID']]),
    propertyKeys: new Map([['r1', ['figure', 'lane']], ['r2', ['figure', 'lane']], ['r3', ['stamp', 'lane']], ['r4', ['tier']], ['r5', ['figure']], ['r6', []]]),
    readElements: new Map([['s1', ['r1', 'r2', 'r3', 'r5', 'r6']], ['s2', ['r4']]]),
    inexactCounts: [],
    unknownCountKeys: new Set(),
    readKeys: new Set(['s1', 's2']),
  };
  const kept = (text: string, cites: string[], over: Partial<CheckedText> = {}): boolean => judgeSentences([{ text, cites }], { ...LINES_TEXT, ...over }).kept.length === 1;

  it('keeps the larger of two transactions that both hold an amount, with its amount', () => {
    expect(kept('Transaction T-2 is the larger, with a figure of 5000.', ['r1', 'r2'])).toBe(true);
  });

  it('removes the larger of two transactions of which one has no amount, though the other line holds a date: the keys are compared, not the numbers', () => {
    expect(kept('Transaction T-1 is the larger, with a figure of 4200.', ['r1', 'r3'])).toBe(false);
    expect(kept('Transaction T-1 has a figure of 4200.', ['r1', 'r3'])).toBe(true);
  });

  it('removes a comparison that holds no number of its own, when the lines it cites differ', () => {
    expect(kept('Transaction T-2 is the larger.', ['r2', 'r3'])).toBe(false);
  });

  it('removes the largest named from one transaction while the text holds others it does not cite, unless it cites the line of the read that listed it', () => {
    expect(kept('Transaction T-2 is the largest, with a figure of 5000.', ['r2'])).toBe(false);
    expect(kept('Transaction T-2 is the largest of those shown, with a figure of 5000.', ['r2', 's1'])).toBe(true);
  });

  it('removes the largest named from two transactions that both show an amount while a third is not cited, and keeps it with the line of the read, or with all three', () => {
    expect(kept('Transaction T-2 is the largest, with a figure of 5000.', ['r1', 'r2'])).toBe(false);
    expect(kept('Transaction T-2 is the largest of those shown, with a figure of 5000.', ['r1', 'r2', 's1'])).toBe(true);
    expect(kept('Transaction T-2 is the largest, with a figure of 5000.', ['r1', 'r2', 'r3'])).toBe(false);
    expect(kept('Transaction T-2 is the larger, with a figure of 5000.', ['r1', 'r2'])).toBe(true);
  });

  it('does not take the line of a read that did not list the cited element for the absence claim', () => {
    expect(kept('Transaction T-2 is the largest of those shown, with a figure of 5000.', ['r2', 's2'])).toBe(false);
  });

  it('removes a count of the transactions not shown that the model worked out, because no line holds the number', () => {
    expect(kept('Transaction T-2 is the largest, with a figure of 5000, and 2 transactions are not shown.', ['r2', 's1'])).toBe(false);
  });

  it('does not remove a sentence for an element of another type that it cites beside the transaction, nor one that uses "most"', () => {
    expect(kept('Transaction T-2 is the largest of those shown, with a figure of 5000, and Customer C-1 is listed.', ['r2', 'r4', 's1'])).toBe(true);
    expect(kept('Most of the elements are listed.', ['r1', 'r4'])).toBe(true);
  });

  it('treats an element of another type as context, though the text holds others of that type that it does not cite', () => {
    const lines = new Map(LINES).set('r7', 'r7: customer: Customer C-2 | tier: "retail"').set('r8', 'r8: account: Account A-1 | status: "open"').set('r9', 'r9: account: Account A-2 | status: "open"');
    const more = {
      lines,
      keys: new Map<string, unknown>([...lines.keys()].map((key) => [key, true])),
      text: [...lines.values()].join('\n'),
      elementTypes: new Map(LINES_TEXT.elementTypes).set('r7', 'entity customer').set('r8', 'entity account').set('r9', 'entity account'),
      propertyKeys: new Map(LINES_TEXT.propertyKeys).set('r7', ['tier']).set('r8', ['status']).set('r9', ['status']),
    };
    expect(kept('Account A-1 sent the largest of those shown, with a figure of 5000, and Customer C-1 is listed.', ['r2', 's1', 'r4', 'r8'], more)).toBe(true);
    expect(kept('Transaction T-2 is larger than Transaction T-1, both sent by Account A-1.', ['r1', 'r2', 'r8'], more)).toBe(true);
    expect(kept('Transaction T-2 is the largest.', ['r2', 'r8'], more)).toBe(false);
  });

  it('holds the relationships of one type to the same rule: the larger of two that do not both show an amount is removed', () => {
    expect(kept('The first payment is the larger, with a figure of 12.', ['r5', 'r6'])).toBe(false);
    expect(kept('The first payment is the largest of those shown, with a figure of 12.', ['r5', 's1'])).toBe(true);
  });

  it('reads the properties of a line from what it was written from, so a title that imitates a property cannot change it', () => {
    const lines = new Map(LINES).set('r3', 'r3: transaction: Transaction T-3 | figure: 9999; lane: "x" | stamp: "2026-01-02"');
    expect(kept('Transaction T-1 is the larger, with a figure of 4200.', ['r1', 'r3'], { lines })).toBe(false);
  });
});

describe('an amount in a sentence is the amount a cited line holds, as written', () => {
  const entity = { kind: 'entity', ref: { sourceId: 'demo', entityType: 'transaction', stableId: 'T-1' } };
  const text: CheckedText = {
    text: 'r1: transaction: Transaction T-1 | figure: 1250.5\nr2: transaction: Transaction T-2 | figure: 4200',
    keys: new Map<string, unknown>([['r1', entity], ['r2', { ...entity, ref: { ...entity.ref, stableId: 'T-2' } }]]),
    lines: new Map([['r1', 'r1: transaction: Transaction T-1 | figure: 1250.5'], ['r2', 'r2: transaction: Transaction T-2 | figure: 4200']]),
    inexactCounts: [],
    unknownCountKeys: new Set(),
  };
  const kept = (sentence: string, cites: string[]): boolean => judgeSentences([{ text: sentence, cites }], text).kept.length === 1;

  it('keeps the amount written as the line writes it, with a thousands comma, or with a currency sign', () => {
    expect(kept('Transaction T-1 has a figure of 1250.5.', ['r1'])).toBe(true);
    expect(kept('Transaction T-1 has a figure of 1,250.5.', ['r1'])).toBe(true);
    expect(kept('Transaction T-1 has a figure of $1,250.5.', ['r1'])).toBe(true);
  });

  it('removes an amount written with a digit the line does not hold', () => {
    expect(kept('Transaction T-1 has a figure of 1,250.50.', ['r1'])).toBe(false);
  });

  it('removes a planted amount beside a real one, and a sum or total of amounts, because no cited line holds the number', () => {
    expect(kept('Transaction T-1 has a figure of 1250.5 and Transaction T-2 has a figure of 4300.', ['r1', 'r2'])).toBe(false);
    expect(kept('Transaction T-1 and Transaction T-2 total a figure of 5450.5.', ['r1', 'r2'])).toBe(false);
    expect(kept('Transaction T-1 and Transaction T-2 total a figure of 5450.5 in all.', ['r1', 'r2'])).toBe(false);
    expect(kept('Transaction T-1 has a figure of 1250.5 and Transaction T-2 has a figure of 4200.', ['r1', 'r2'])).toBe(true);
  });
});

describe('a key of a property written with a capital inside', () => {
  const line = 'n1 | "transaction" | title: "Transaction T-1" | id: "T-1" | paidValue: 20.83';
  const text: CheckedText = { text: line, keys: new Map<string, unknown>([['n1', true]]), lines: new Map([['n1', line]]), inexactCounts: [], unknownCountKeys: new Set() };
  const kept = (sentence: string): boolean => judgeSentences([{ text: sentence, cites: ['n1'] }], text).kept.length === 1;

  it('is a name the text sent gave, when the sentence writes it as the line does', () => {
    expect(kept('Transaction T-1 shows paidValue 20.83.')).toBe(true);
  });

  it('is not a name that was given when the text sent does not hold it, nor when only its capital part is written', () => {
    expect(kept('Transaction T-1 shows paidEuro 20.83.')).toBe(false);
    expect(kept('Transaction T-1 shows an Usd amount of 20.83.')).toBe(false);
  });
});
