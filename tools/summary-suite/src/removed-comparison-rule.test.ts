import type { SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from '../../../ee/ai-runtime/src/reply-checks.js';
import { mutatedChecks, type Mutation } from './mutants.js';

const LINES: Record<string, string> = {
  r1: 'r1: transaction: Transaction T-1 | figure: 4200; lane: "online"',
  r2: 'r2: transaction: Transaction T-2 | figure: 5000; lane: "branch"',
  r3: 'r3: transaction: Transaction T-3 | stamp: "2026-01-02"; lane: "online"',
  s1: 's1: read of byAccount: 3 shown · exact',
};
const TEXT: CheckedText = {
  text: Object.values(LINES).join('\n'),
  keys: new Map<string, unknown>([['r1', true], ['r2', true], ['r3', true], ['s1', true]]),
  elementTypes: new Map([['r1', 'entity transaction'], ['r2', 'entity transaction'], ['r3', 'entity transaction']]),
  propertyKeys: new Map([['r1', ['figure', 'lane']], ['r2', ['figure', 'lane']], ['r3', ['stamp', 'lane']]]),
  readElements: new Map([['s1', ['r1', 'r2', 'r3']]]),
  rankedValues: new Map([
    ['r1', [{ key: 'figure', dataClass: 'number', value: '4200' }]],
    ['r2', [{ key: 'figure', dataClass: 'number', value: '5000' }]],
    ['r3', [{ key: 'stamp', dataClass: 'date', value: '2026-01-02T00:00:00.000000000' }]],
  ]),
  elementNames: new Map([['r1', ['Transaction T-1']], ['r2', ['Transaction T-2']], ['r3', ['Transaction T-3']], ['r8', ['Account A-1']], ['r9', ['Account A-2']]]),
  lines: new Map(Object.entries(LINES)),
  inexactCounts: [],
  unknownCountKeys: new Set(),
  readKeys: new Set(['s1']),
};

type Judge = (sentences: readonly SummarySentence[], text: CheckedText) => { readonly kept: readonly SummarySentence[] };

const CASES: readonly { readonly name: string; readonly mutation: Mutation; readonly breaking: SummarySentence }[] = [
  { name: 'a comparison over lines that do not all show an amount (a line holds a date but no amount)', mutation: { name: 'the comparison rule', from: '|| !comparisonHolds(sentence, assembled)', to: '' }, breaking: { text: 'Transaction T-1 is the larger, with a figure of 4200.', cites: ['r1', 'r3'] } },
  { name: 'the largest named from one cited transaction while another is not cited', mutation: { name: 'the comparison rule', from: '|| !comparisonHolds(sentence, assembled)', to: '' }, breaking: { text: 'Transaction T-2 has the largest figure, 5000.', cites: ['r2'] } },
  { name: 'the largest named from two transactions that both show an amount while a third is not cited', mutation: { name: 'the comparison rule', from: '|| !comparisonHolds(sentence, assembled)', to: '' }, breaking: { text: 'Transaction T-2 has the largest figure, 5000.', cites: ['r1', 'r2'] } },
  { name: 'a planted amount that no cited line holds', mutation: { name: 'numbers on the cited lines', from: 'if (!numbers.every((number) => cited.has(number))) return false;', to: '' }, breaking: { text: 'Transaction T-1 has a figure of 4300.', cites: ['r1'] } },
];

describe('a rule taken out of the product\'s own checks leaves a sentence that the suite catches, for an amount in the lines of a tool result', () => {
  for (const { name, mutation, breaking } of CASES) {
    it(`removes ${name} with the product as it is, and keeps it once the product no longer tests ${mutation.name}`, async () => {
      expect(judgeSentences([breaking], TEXT).kept).toEqual([]);
      const mutant = await mutatedChecks(mutation);
      const judge = mutant['judgeSentences'] as Judge;
      expect(judge([breaking], TEXT).kept).toHaveLength(1);
    });
  }

  it('keeps a comparison that cites an element of another type beside the transactions, though the text holds another of that type, and drops it once the product no longer treats it as context', async () => {
    const lines = new Map(Object.entries({ ...LINES, r8: 'r8: account: Account A-1 | status: "open"', r9: 'r9: account: Account A-2 | status: "open"' }));
    const more: CheckedText = { ...TEXT, lines, text: [...lines.values()].join('\n'), keys: new Map<string, unknown>([...lines.keys()].map((key) => [key, true])), elementTypes: new Map([...(TEXT.elementTypes ?? []), ['r8', 'entity account'], ['r9', 'entity account']]), propertyKeys: new Map([...(TEXT.propertyKeys ?? []), ['r8', ['status']], ['r9', ['status']]]) };
    const sentence: SummarySentence = { text: 'Account A-1 sent the larger, with a figure of 5000.', cites: ['r2', 's1', 'r8'] };
    expect(judgeSentences([sentence], more).kept).toHaveLength(1);
    const mutant = (await mutatedChecks({ name: 'the compared types', from: 'if (first === undefined || !compared.has(type)) continue;', to: 'if (first === undefined) continue;' }))['judgeSentences'] as Judge;
    expect(mutant([sentence], more).kept).toEqual([]);
  });

  it('keeps a comparison over lines that all show an amount, and one that cites the line of the read, with the product as it is and with the rule taken out', async () => {
    const mutant = (await mutatedChecks({ name: 'the comparison rule', from: '|| !comparisonHolds(sentence, assembled)', to: '' }))['judgeSentences'] as Judge;
    const good: SummarySentence[] = [{ text: 'Transaction T-2 is the larger, with a figure of 5000.', cites: ['r1', 'r2'] }, { text: 'Transaction T-2 is the larger, with a figure of 5000.', cites: ['r2', 's1'] }];
    expect(judgeSentences(good, TEXT).kept).toHaveLength(2);
    expect(mutant(good, TEXT).kept).toHaveLength(2);
  });
});

describe('the rule that a key of a property written with a capital inside is a name the text sent gave, taken out of the product, leaves a good sentence removed', () => {
  it('keeps the sentence that writes the key as the line does with the product as it is, and removes it once the product no longer reads the key as a name', async () => {
    const line = 'n1 | "transaction" | title: "Transaction T-1" | id: "T-1" | paidValue: 20.83';
    const text: CheckedText = { text: line, keys: new Map<string, unknown>([['n1', true]]), lines: new Map([['n1', line]]), inexactCounts: [], unknownCountKeys: new Set() };
    const good: SummarySentence = { text: 'Transaction T-1 shows paidValue 20.83.', cites: ['n1'] };
    expect(judgeSentences([good], text).kept).toHaveLength(1);
    const mutant = (await mutatedChecks({ name: 'the key of a property as a name', from: '(/\\p{Ll}\\p{Lu}/u.test(token) && sentTokens.has(token))', to: 'false' }))['judgeSentences'] as Judge;
    expect(mutant([good], text).kept).toEqual([]);
  });
});
