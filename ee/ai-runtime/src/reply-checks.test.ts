import { describe, expect, it } from 'vitest';
import { createCheckRunner } from './check-runner.js';
import { removalNoteOf } from './removed-sentences.js';
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
    expect(parseJudged({ kept: [{ text: 'x', cites: ['n1'] }], removed: 0, rejected: [], keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeDefined();
    expect(parseJudged({ kept: 'x' })).toBeUndefined();
    expect(parseJudged({ kept: [{ text: 1 }], removed: 0, rejected: [], keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeUndefined();
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

  it('still removes a comparison in a table row, where the numbers of words are not read', () => {
    const row = { text: 'Transaction T-1 is the larger', cites: ['r1', 'r3'] };
    expect(judgeSentences([row], LINES_TEXT, { tableRows: true }).kept).toEqual([]);
    expect(judgeSentences([row], LINES_TEXT, { tableRows: true }).rejected).toEqual([{ text: row.text, reason: 'comparison' }]);
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

describe('a count of the cited elements', () => {
  const line = (key: string, type: string, title: string): string => `${key} | "${type}" | title: "${title}" | id: "${key}x"`;
  const counted: CheckedText = {
    text: ['n1', 'n2', 'n3'].map((key, index) => line(key, 'Transaction', `Item ${'ABC'[index]}`)).concat(line('n4', 'Account', 'Holder D'), 'e1 | "RECEIVED_BY" | n1 -> n4', 'e2 | "RECEIVED_BY" | n2 -> n4').join('\n'),
    keys: new Map(['n1', 'n2', 'n3', 'n4', 'e1', 'e2', 's1'].map((key) => [key, true])),
    lines: new Map([['n1', line('n1', 'Transaction', 'Item A')], ['n2', line('n2', 'Transaction', 'Item B')], ['n3', line('n3', 'Transaction', 'Item C')], ['n4', line('n4', 'Account', 'Holder D')], ['e1', 'e1 | "RECEIVED_BY" | n1 -> n4'], ['e2', 'e2 | "RECEIVED_BY" | n2 -> n4'], ['s1', 's1: a read']]),
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map([['n1', 'entity Transaction'], ['n2', 'entity Transaction'], ['n3', 'entity Transaction'], ['n4', 'entity Account'], ['e1', 'relationship RECEIVED_BY'], ['e2', 'relationship RECEIVED_BY'], ['s1', 'entity Transaction']]),
    readKeys: new Set(['s1']),
  };
  const judged = (text: string, cites: string[], assembled: CheckedText = counted) => judgeSentences([{ text, cites }], assembled);

  it('shows a count that equals the number of cited elements of the named type', () => {
    expect(judged('3 transactions are listed.', ['n1', 'n2', 'n3']).kept).toHaveLength(1);
  });

  it('shows a count of relationships written with the name of their type, and the singular', () => {
    expect(judged('2 received by relationships end at Holder D.', ['e1', 'e2', 'n4']).kept).toHaveLength(1);
    expect(judged('1 transaction is listed.', ['n1']).kept).toHaveLength(1);
  });

  describe('a count written in words', () => {
    const ids = Array.from({ length: 25 }, (_, index) => `TX-${String(index + 1).padStart(3, '0')}`);
    const transactionLine = (key: string, id: string): string => `${key} | "Transaction" | title: "${id}" | id: "${id}"`;
    const linkLine = (key: string, from: string): string => `${key} | "RECEIVED_BY" | ${from} -> n26`;
    const wide: CheckedText = {
      text: [...ids.map((id, index) => transactionLine(`n${index + 1}`, id)), 'n26 | "Account" | title: "ACC-1" | id: "ACC-1"', ...ids.map((_, index) => linkLine(`e${index + 1}`, `n${index + 1}`))].join('\n'),
      keys: new Map([...ids.map((_, index) => `n${index + 1}`), 'n26', ...ids.map((_, index) => `e${index + 1}`)].map((key) => [key, true])),
      lines: new Map([...ids.map((id, index) => [`n${index + 1}`, transactionLine(`n${index + 1}`, id)] as const), ['n26', 'n26 | "Account" | title: "ACC-1" | id: "ACC-1"'], ...ids.map((_, index) => [`e${index + 1}`, linkLine(`e${index + 1}`, `n${index + 1}`)] as const)]),
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: new Map([...ids.map((_, index) => [`n${index + 1}`, 'entity Transaction'] as const), ['n26', 'entity Account'], ...ids.map((_, index) => [`e${index + 1}`, 'relationship RECEIVED_BY'] as const)]),
    };
    const cites = [...ids.map((_, index) => `n${index + 1}`), ...ids.map((_, index) => `e${index + 1}`)];
    const keptWide = (text: string, over: string[] = cites): boolean => judged(text, over, wide).kept.length === 1;

    it('shows a count in words that equals the cited elements of the type, with the ids and the type of the relationship in the sentence', () => {
      expect(keptWide('Twenty-five transactions, TX-001 through TX-025, are each linked to the account by a RECEIVED_BY relationship.')).toBe(true);
      expect(keptWide('There are twenty-five transactions in view.')).toBe(true);
      expect(keptWide('Twenty-five received by relationships are in view.')).toBe(true);
    });

    it('removes a wrong count in words, in a capital and in lower case', () => {
      expect(keptWide('Twenty-six transactions, TX-001 through TX-025, are each linked to the account by a RECEIVED_BY relationship.')).toBe(false);
      expect(keptWide('There are twenty-four transactions in view.')).toBe(false);
      expect(keptWide('Twenty transactions are in view.')).toBe(false);
    });

    it('reads the words up to ten as a count, and removes a wrong one, as it does the digits', () => {
      expect(keptWide('Three transactions are listed.', ['n1', 'n2', 'n3'])).toBe(true);
      expect(keptWide('Four transactions are listed.', ['n1', 'n2', 'n3'])).toBe(false);
      expect(keptWide('Five transactions are in view.', ['n1', 'n2', 'n3'])).toBe(false);
      expect(keptWide('One account is in view.', ['n26'])).toBe(true);
      expect(keptWide('Two accounts are in view.', ['n26'])).toBe(false);
    });

    it('does not read a small number word that opens no count', () => {
      expect(keptWide('One of the transactions is TX-001.', ['n1'])).toBe(true);
    });

    it('removes a count in words said of another population, as it removes the digits', () => {
      expect(keptWide('At least twenty-five transactions are in view.')).toBe(false);
      expect(keptWide('In total there are twenty-five transactions.')).toBe(false);
    });

    it('removes a count in words stated without the phrase of a count that is a lower bound, an estimate or not known, with the reason count', () => {
      const payments = (line: string, over: Partial<CheckedText>): CheckedText => ({ ...counted, lines: new Map([['p1', line]]), keys: new Map([['p1', true]]), elementTypes: new Map([['p1', 'entity Payment']]), ...over });
      const lower = payments('p1 | "Payment" | title: "P" | id: "p1x" | members: ≥ 25 (lower bound)', { inexactCounts: [{ phrase: '≥ 25 (lower bound)', value: '25' }] });
      const estimated = payments('p1 | "Payment" | title: "P" | id: "p1x" | members: ~25 (estimated)', { inexactCounts: [{ phrase: '~25 (estimated)', value: '25' }] });
      const unknown = payments('p1 | "Payment" | title: "P" | id: "p1x" | members: not known', { unknownCountKeys: new Set(['p1']) });
      for (const held of [lower, estimated, unknown]) {
        expect(judged('Twenty-five payments are listed.', ['p1'], held).kept).toEqual([]);
        expect(judged('Twenty-five payments are listed.', ['p1'], held).rejected).toEqual([{ text: 'Twenty-five payments are listed.', reason: 'count' }]);
      }
      expect(judged('There are ≥ 25 (lower bound) payments, twenty-five of them listed.', ['p1'], lower).kept).toHaveLength(1);
    });

    it('removes another number written in words that no cited line holds, though the count of the sentence stands', () => {
      expect(keptWide('Twenty-five transactions sum to ninety-nine.')).toBe(false);
      expect(keptWide('Twenty-five transactions represent ninety-nine percent.')).toBe(false);
      expect(keptWide('Twenty-five transactions have a fee of twenty-five.')).toBe(false);
      expect(keptWide('Twenty-five of them are in view.')).toBe(false);
    });

    it('keeps a quoted title that is written in number words, as a name, and removes one that was not sent', () => {
      const titled: CheckedText = { ...wide, text: `${wide.text}\nn27 | "Widget" | title: "Twenty-five widgets" | id: "WID-1"`, keys: new Map([...wide.keys, ['n27', true]]), lines: new Map([...wide.lines, ['n27', 'n27 | "Widget" | title: "Twenty-five widgets" | id: "WID-1"']]), elementTypes: new Map([...(wide.elementTypes ?? []), ['n27', 'entity Widget']]) };
      expect(judged('"Twenty-five widgets" is listed.', ['n27'], titled).kept).toHaveLength(1);
      expect(judged('"Twenty-six widgets" is listed.', ['n27'], titled).kept).toEqual([]);
    });

    it('does not let a number word in the title of a cited element back a number of the sentence', () => {
      const titled: CheckedText = { ...wide, text: `${wide.text}\nn27 | "Company" | title: "Five Rivers Ltd" | id: "CO-1"`, keys: new Map([...wide.keys, ['n27', true]]), lines: new Map([...wide.lines, ['n27', 'n27 | "Company" | title: "Five Rivers Ltd" | id: "CO-1"']]), elementTypes: new Map([...(wide.elementTypes ?? []), ['n27', 'entity Company']]) };
      expect(judged('Five Rivers Ltd received 5 transfers.', ['n27'], titled).kept).toEqual([]);
    });

    it('keeps a number in words that a cited line holds, in a property value or in the meaning of a type, as it kept it before', () => {
      const labelled: CheckedText = { ...wide, text: `${wide.text}\nn27 | "Widget" | title: "W" | id: "WID-1" | label: "twenty-five"\nm1: a widget is held for twenty-five days`, keys: new Map([...wide.keys, ['n27', true], ['m1', true]]), lines: new Map([...wide.lines, ['n27', 'n27 | "Widget" | title: "W" | id: "WID-1" | label: "twenty-five"'], ['m1', 'm1: a widget is held for twenty-five days']]), elementTypes: new Map([...(wide.elementTypes ?? []), ['n27', 'entity Widget']]), descriptionKeys: new Set(['m1']) };
      expect(judged('The label is twenty-five.', ['n27'], labelled).kept).toHaveLength(1);
      expect(judged('A widget is held for twenty-five days.', ['m1'], labelled).kept).toHaveLength(1);
      expect(judged('The label is twenty-six.', ['n27'], labelled).kept).toEqual([]);
    });

    it('does not read a number word that opens no count as one, and does not excuse it in a table row', () => {
      expect(keptWide('One of the transactions is TX-001.', ['n1'])).toBe(true);
      expect(judgeSentences([{ text: 'Twenty-five transactions', cites }], wide, { tableRows: true }).kept).toEqual([]);
    });

    it('counts a number in words of a kind', () => {
      expect(keptWide('Twenty-five relationships are in view.', cites.filter((key) => key.startsWith('e')))).toBe(true);
      expect(keptWide('Twenty-six relationships are in view.', cites.filter((key) => key.startsWith('e')))).toBe(false);
    });
  });

  describe('a count that leaves out the elements of the type named apart from it', () => {
    const keys = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const titles = ['AC-5001', 'AC-5002', 'AC-5003', 'AC-5004', 'AC-5005', 'AC-5100'];
    const accountLines = keys.map((key, index) => `${key} | "account" | title: "${titles[index]}" | id: "${titles[index]}"`);
    const apart: CheckedText = {
      text: accountLines.join('\n'),
      keys: new Map(keys.map((key) => [key, true])),
      lines: new Map(keys.map((key, index) => [key, accountLines[index] ?? ''])),
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: new Map(keys.map((key) => [key, 'entity account'])),
    };
    const verdict = (text: string, cited = keys): boolean => judgeSentences([{ text, cites: cited }], apart).kept.length === 1;

    it.each([
      ['5 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
      ['Five accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
      ['The account AC-5100 received from five accounts, AC-5001 to AC-5005.'],
      ['Six accounts, AC-5001, AC-5002, AC-5003, AC-5004, AC-5005 and AC-5100, are listed.'],
    ])('keeps the count when the one named apart is left out: %s', (text) => {
      expect(verdict(text)).toBe(true);
    });

    it.each([
      ['6 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
      ['Four accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
      ['Six accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
      ['4 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.'],
    ])('removes a wrong count, the same for digits and words: %s', (text) => {
      expect(verdict(text)).toBe(false);
    });

    it.each([
      ['AC-5001 to AC-5005, five accounts, transferred to the account AC-5100.', true],
      ['AC-5001 to AC-5005, 5 accounts, transferred to the account AC-5100.', true],
      ['AC-5001 to AC-5005, three accounts, transferred to the account AC-5100.', false],
      ['Five accounts (AC-5001 to AC-5005) transferred to the account AC-5100.', true],
      ['Three accounts (AC-5001 to AC-5005) transferred to the account AC-5100.', false],
      ['5 accounts (AC-5001, AC-5002, AC-5003, AC-5004 and AC-5005) transferred to the account AC-5100.', true],
      ['4 accounts (AC-5001, AC-5002, AC-5003, AC-5004 and AC-5005) transferred to the account AC-5100.', false],
    ])('reads a list of names before the count or in parentheses as the count’s own: %s', (text, expected) => {
      expect(verdict(text)).toBe(expected);
    });

    it.each([
      ['There were transfers from five accounts to AC-5100.', true],
      ['There were transfers from six accounts to AC-5100.', false],
      ['There were payments from AC-5100 to five accounts.', true],
      ['There were payments from AC-5100 to six accounts.', false],
      ['Five accounts and AC-5100 are listed.', true],
      ['Six accounts and AC-5100 are listed.', false],
    ])('does not take a name joined to the count by to or and alone for part of it: %s', (text, expected) => {
      expect(verdict(text)).toBe(expected);
    });

    it('compares names as the same text whether they are written composed or decomposed', () => {
      const cafe = apart.lines.get('a6')?.replace('AC-5100', 'Caf\u00e9').replace('AC-5100', 'Caf\u00e9') ?? '';
      const accented: CheckedText = { ...apart, text: [...apart.lines.values()].slice(0, 5).concat(cafe).join('\n'), lines: new Map([...apart.lines, ['a6', cafe]]) };
      const said = (text: string): boolean => judgeSentences([{ text, cites: keys }], accented).kept.length === 1;
      expect(said('Five accounts, AC-5001 to AC-5005, transferred to the account Cafe\u0301.')).toBe(true);
      expect(said('Six accounts, AC-5001 to AC-5005, transferred to the account Cafe\u0301.')).toBe(false);
      expect(said('Five accounts, AC-5001 to AC-5005, transferred to the account Caf\u00e9.')).toBe(true);
    });

    it('keeps a count of the cited elements when none is named apart, and removes one that counts the one named apart too', () => {
      expect(verdict('Five accounts are listed.', keys.slice(0, 5))).toBe(true);
      expect(verdict('Six accounts are listed.', keys.slice(0, 5))).toBe(false);
    });
  });

  describe('the name of a type, whatever its length or its white space', () => {
    const longType = 'registered_commercial_banking_institution_with_extended_supervision_and_reporting_duties';
    const longLines = ['n1', 'n2', 'n3'].map((key, index) => `${key} | "${longType}" | title: "Bank ${index + 1}" | id: "b${index + 1}"`);
    const long: CheckedText = {
      text: longLines.join('\n'),
      keys: new Map(['n1', 'n2', 'n3'].map((key) => [key, true])),
      lines: new Map(['n1', 'n2', 'n3'].map((key, index) => [key, longLines[index] ?? ''])),
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: new Map(['n1', 'n2', 'n3'].map((key) => [key, `entity ${longType}`])),
    };
    const name = longType.replaceAll('_', ' ');
    const said = (text: string): boolean => judgeSentences([{ text, cites: ['n1', 'n2', 'n3'] }], long).kept.length === 1;

    it('reads a type name of any length, in digits and in words, and removes a wrong count', () => {
      expect(name.length).toBeGreaterThan(80);
      expect(said(`3 ${name}s are listed.`)).toBe(true);
      expect(said(`Three ${name}s are listed.`)).toBe(true);
      expect(said(`Four ${name}s are listed.`)).toBe(false);
      expect(said(`4 ${name}s are listed.`)).toBe(false);
    });

    it('reads the name across more white space than one space', () => {
      expect(said(`Three   ${name.replaceAll(' ', '  ')}s are listed.`)).toBe(true);
      expect(said(`Four   ${name.replaceAll(' ', '  ')}s are listed.`)).toBe(false);
    });
  });

  describe('a count of a kind: entities, relationships or elements', () => {
    const mixed: CheckedText = { ...counted, elementTypes: new Map([...(counted.elementTypes ?? []), ['e2', 'relationship OWNS']]) };

    it('shows the number of cited relationships of every type, and of cited entities', () => {
      expect(judged('2 relationships are in view.', ['e1', 'e2'], mixed).kept).toHaveLength(1);
      expect(judged('4 entities are in view.', ['n1', 'n2', 'n3', 'n4'], mixed).kept).toHaveLength(1);
      expect(judged('1 entity is in view.', ['n4'], mixed).kept).toHaveLength(1);
    });

    it('shows the number of all cited elements as elements', () => {
      expect(judged('6 elements are in view.', ['n1', 'n2', 'n3', 'n4', 'e1', 'e2'], mixed).kept).toHaveLength(1);
    });

    it.each([
      ['3 relationships are in view.', ['e1', 'e2']],
      ['2 relationships are in view.', ['e1', 'n1']],
      ['5 entities are in view.', ['n1', 'n2', 'n3', 'n4']],
      ['7 elements are in view.', ['n1', 'n2', 'n3', 'n4', 'e1', 'e2']],
    ])('removes the wrong count: %s', (text, cites) => {
      expect(judged(text, cites, mixed).kept).toEqual([]);
    });

    it.each(['In total 2 relationships are in view.', 'At least 2 relationships are in view.', '2 relationships are not yet retrieved.'])('removes a kind count said of another population: %s', (text) => {
      expect(judged(text, ['e1', 'e2'], mixed).kept).toEqual([]);
    });

    it('does not take a longer word for the kind', () => {
      expect(judged('2 relationshipsx are in view.', ['e1', 'e2'], mixed).kept).toEqual([]);
    });
  });

  it.each([2, 4])('removes the count %i over three cited transactions, once', (wrong) => {
    const result = judged(`${wrong} transactions are listed.`, ['n1', 'n2', 'n3']);
    expect(result.kept).toEqual([]);
    expect(result.removed).toBe(1);
  });

  it('judges a number a cited line holds as before', () => {
    const held: CheckedText = { ...counted, lines: new Map([...counted.lines, ['n1', 'n1 | "Transaction" | title: "Item A" | id: "n1x" | rows: 7']]) };
    expect(judged('Item A has 7 rows.', ['n1'], held).kept).toHaveLength(1);
    expect(judged('Item A has 8 rows.', ['n1'], held).kept).toEqual([]);
  });

  it('verifies no count when the text carries no element types', () => {
    const { elementTypes: _types, ...untyped } = counted;
    expect(judged('3 transactions are listed.', ['n1', 'n2', 'n3'], untyped).kept).toEqual([]);
  });

  it('does not count the line of a read or of a meaning as an element', () => {
    expect(judged('4 transactions are listed.', ['n1', 'n2', 'n3', 's1']).kept).toEqual([]);
    const meant: CheckedText = { ...counted, descriptionKeys: new Set(['n3']) };
    expect(judged('3 transactions are listed.', ['n1', 'n2', 'n3'], meant).kept).toEqual([]);
  });

  it('keeps the own-value rule of a table cell whatever the cited elements number', () => {
    const row = [{ text: '3 transactions', cites: ['n1', 'n2', 'n3'] }];
    expect(judgeSentences(row, counted, { tableRows: true }).kept).toEqual([]);
    expect(judgeInput({ sentences: row, text: counted, tableRows: true }).kept).toEqual([]);
    expect(judgeInput({ sentences: row, text: counted }).kept).toHaveLength(1);
  });

  it.each(['3 items are listed.', '3 accounts are listed.', 'The 3 are listed.'])('does not verify a count that names no type or another type: %s', (text) => {
    expect(judged(text, ['n1', 'n2', 'n3']).kept).toEqual([]);
  });

  it.each([
    'In total there are 3 transactions.',
    'Altogether 3 transactions were read.',
    'The source holds 3 transactions.',
    '3 transactions are not yet retrieved.',
    '3 hidden transactions remain.',
    'At least 3 transactions are listed.',
    'About 3 transactions are listed.',
    'There are more than 3 transactions.',
  ])('does not let cited elements stand for another population: %s', (text) => {
    expect(judged(text, ['n1', 'n2', 'n3']).kept).toEqual([]);
  });

  it('leaves a source-wide sentence to the cited-line rule alone: a cited line that holds the number keeps it as before', () => {
    const held: CheckedText = { ...counted, lines: new Map([...counted.lines, ['n1', 'n1 | "Transaction" | title: "Item A" | id: "n1x" | rows: 3']]) };
    expect(judged('In total there are 3 transactions.', ['n1', 'n2', 'n3'], held).kept).toHaveLength(1);
  });

  it.each(['3 transactions have a fee of 3.', '3 transactions represent 3%.', 'Of 3 transactions, 3 are listed twice.'])('judges each number of a sentence on its own, so a verified count does not support the same number elsewhere: %s', (text) => {
    expect(judged(text, ['n1', 'n2', 'n3']).kept).toEqual([]);
  });

  it.each(['3 transactions are not\tshown.', 'At\nleast 3 transactions are listed.', '3 transactions are in the\nsource.', '3 transactions are not  yet\nretrieved.'])('reads the words of another population across any whitespace: %s', (text) => {
    expect(judged(text, ['n1', 'n2', 'n3']).kept).toEqual([]);
  });

  it('keeps the identity of a type that differs by case or repeated whitespace, and reads its name as written in a sentence', () => {
    const odd: CheckedText = { ...counted, keys: new Map([...counted.keys, ['n5', true], ['n6', true]]), lines: new Map([...counted.lines, ['n5', 'n5 | "Widget" | title: "Eps" | id: "e5x"'], ['n6', 'n6 | "widget" | title: "Zeta" | id: "z6x"']]), elementTypes: new Map([...(counted.elementTypes ?? []), ['n5', 'entity Widget'], ['n6', 'entity widget']]) };
    expect(judged('1 widget is listed.', ['n5', 'n6'], odd).kept).toHaveLength(1);
    expect(judged('2 widgets are listed.', ['n5', 'n6'], odd).kept).toEqual([]);
    const spaced: CheckedText = { ...counted, keys: new Map([...counted.keys, ['n7', true], ['n8', true]]), lines: new Map([...counted.lines, ['n7', 'n7 | "money  movement" | title: "Eta" | id: "h7x"'], ['n8', 'n8 | "money  movement" | title: "Theta" | id: "t8x"']]), elementTypes: new Map([...(counted.elementTypes ?? []), ['n7', 'entity money  movement'], ['n8', 'entity money  movement']]) };
    expect(judged('2 money movements are listed.', ['n7', 'n8'], spaced).kept).toHaveLength(1);
  });

  it('reads the name of a type across any whitespace after the number', () => {
    expect(judged('3\ntransactions are listed.', ['n1', 'n2', 'n3']).kept).toHaveLength(1);
    expect(judged('2 received\nby relationships end at Holder D.', ['e1', 'e2', 'n4']).kept).toHaveLength(1);
  });

  it('keeps a wrong count that equals a property value in a cited line, as the cited-line rule always has (a known gap, pinned so that a tightening is a deliberate change)', () => {
    const held: CheckedText = { ...counted, lines: new Map([...counted.lines, ['n1', 'n1 | "Transaction" | title: "Item A" | id: "n1x" | rows: 4']]) };
    expect(judged('4 transactions are listed.', ['n1', 'n2', 'n3'], held).kept).toHaveLength(1);
  });

  it('keeps a figure a cited line states with its label, and removes it without the label', () => {
    const stated: CheckedText = { ...counted, lines: new Map([...counted.lines, ['s1', 's1: read of transactions: ≥ 3 (lower bound)']]), inexactCounts: [{ phrase: '≥ 3 (lower bound)', value: '3' }] };
    expect(judged('The read found ≥ 3 (lower bound) transactions.', ['s1'], stated).kept).toHaveLength(1);
    expect(judged('The read found 3 transactions.', ['s1'], stated).kept).toEqual([]);
  });

  it('removes a count that equals the number of cited elements when the text gives that figure as a lower bound or an estimate', () => {
    const bounded: CheckedText = { ...counted, inexactCounts: [{ phrase: '~3 (estimated)', value: '3' }] };
    expect(judged('3 transactions are listed.', ['n1', 'n2', 'n3'], bounded).kept).toEqual([]);
  });

  it('removes a number about an element whose count is not known', () => {
    const unknown: CheckedText = { ...counted, unknownCountKeys: new Set(['n1']) };
    expect(judged('3 transactions are listed.', ['n1', 'n2', 'n3'], unknown).kept).toEqual([]);
  });

  it.each(['The 3 transactions sum to 42.', 'The 3 transactions are 75% of the source.', 'Item A ranks 2 of 3 transactions.'])('removes a figure the check cannot verify: %s', (text) => {
    expect(judged(text, ['n1', 'n2', 'n3']).kept).toEqual([]);
  });
});

describe('the reason a sentence was removed', () => {
  const typed: CheckedText = { ...TEXT, elementTypes: new Map([['n1', 'entity Ledger'], ['n2', 'entity Ledger']]), unknownCountKeys: new Set(['n2']) };

  it.each([
    ['verdict', 'Ledger A is guilty.', ['n1']],
    ['key', 'n1 sent money to n2.', ['n1']],
    ['citation', 'Ledger A is listed.', ['n9']],
    ['number', 'Ledger A has 7311 rows.', ['n1']],
    ['count', 'Ledger B has 5 rows.', ['n2']],
    ['comparison', 'Ledger A is the largest.', ['n1']],
    ['name', 'Ledger Zed is listed.', ['n1']],
  ])('names %s as the reason, one for the one sentence removed', (reason, text, cites) => {
    const judged = judgeSentences([{ text, cites }], typed);
    expect(judged.kept).toEqual([]);
    expect(judged.rejected).toEqual([{ text, reason }]);
    expect(judged.rejected).toHaveLength(judged.removed);
  });

  it('names an estimated count stated without its label as a count', () => {
    const estimated: CheckedText = { ...typed, unknownCountKeys: new Set(), inexactCounts: [{ phrase: '~40 (estimated)', value: '40' }], lines: new Map([...TEXT.lines, ['n1', 'Ledger A members: ~40 (estimated)']]) };
    expect(judgeSentences([{ text: 'Ledger A has 40 members.', cites: ['n1'] }], estimated).rejected).toEqual([{ text: 'Ledger A has 40 members.', reason: 'count' }]);
  });

  it('keeps no reason for a sentence that is kept, and one reason for each removal among several', () => {
    const judged = judgeSentences([{ text: 'Ledger A is listed.', cites: ['n1'] }, { text: 'Ledger A has 7311 rows.', cites: ['n1'] }, { text: 'Ledger B is guilty.', cites: ['n2'] }], typed);
    expect(judged.rejected.map((each) => each.reason)).toEqual(['number', 'verdict']);
    expect(judged.kept).toHaveLength(1);
  });

  it('survives the trip through a worker, and a result with a reason that is not one of the set is refused', async () => {
    const runner = createCheckRunner({ thresholdMs: 0, workerUrl: new URL('./check-worker.ts', import.meta.url) });
    const check = { name: 'judge', inline: judgeInput, module: { url: new URL('./reply-checks.ts', import.meta.url).href, exportName: 'judgeInput' }, parse: parseJudged };
    const input = { sentences: [{ text: 'Ledger A has 7311 rows.', cites: ['n1'] }], text: typed };
    expect(await runner.run(check, input, { timeoutMs: 5000 })).toEqual({ status: 'done', value: judgeSentences(input.sentences, typed) });
    expect(parseJudged({ kept: [], removed: 1, rejected: [{ text: 'x', reason: 'because' }], keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeUndefined();
    expect(parseJudged({ kept: [], removed: 1, rejected: [], keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeUndefined();
  });

  it('writes the note for the model from the submitted text and fixed words alone', () => {
    const note = removalNoteOf([{ text: 'Ledger Zed has 99 rows.', reason: 'name' }, { text: 'Ledger A is guilty.', reason: 'verdict' }]);
    expect(note).toBe('Removed: "Ledger Zed has 99 rows." (it holds a name, an identifier or a quoted text that the text sent does not hold).\nRemoved: "Ledger A is guilty." (it states a conclusion about guilt, intent or an offence; describe only what the elements show).');
    expect(removalNoteOf([])).toBe('');
    expect(removalNoteOf([{ text: '2 figures', reason: 'cell' }])).toContain('in a table the count of the cited elements does not stand for it');
    expect(removalNoteOf([{ text: 'Figure A', reason: 'row' }])).toContain('a line of a read, a meaning or a note');
  });
});
