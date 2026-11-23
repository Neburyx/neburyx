import type { SummarySentence } from '@neburyx/contracts';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseOf, keyMapOf, loadCases, readingOf } from './cases.js';
import { countRuleBroken, numbersUnsupported, SuiteCheckFailed } from './checks.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { replyOf, startRig } from './testing/rig.js';
import { expectClean, twinsOf, viewOf, type Evidence } from './rules.js';
import { node, reading } from './view.js';

const set = loadCases();
const labelled = caseOf(set, 0);

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

const NO_POPULATION_TEST: Mutation = { name: 'the population of a count', from: " || OTHER_POPULATION.test(sentence.text.replace(/\\s+/gu, ' '))", to: '' };
const NO_ARITHMETIC_TEST: Mutation = { name: 'the arithmetic of a count', from: '(matching.length === wanted || matching.filter((key) => !apart(key)).length === wanted)', to: 'matching.length > 0' };

async function summarize(mutation: Mutation | undefined, sentence: SummarySentence, evidence: { readonly view: Evidence['view']; readonly sent?: string }) {
  vi.resetModules();
  if (mutation !== undefined) vi.doMock('../../../ee/ask/src/case-summary/checks.js', async () => mutatedChecks(mutation));
  const { createCaseSummarizer } = await import('../../../ee/ask/src/case-summary/summarizer.js');
  const rig = startRig({ replies: [replyOf(sentence)], settings: { maxCalls: 1 }, factory: createCaseSummarizer });
  const outcome = await rig.summarize(evidence.view);
  return { outcome, rig, sent: evidence.sent ?? '', kept: outcome.status === 'ok' || outcome.status === 'partial' ? outcome.sentences.map(({ text, cites }) => ({ text, cites })) : [] };
}

describe('a count of the cited elements in the case summary, with the product\'s own checks', () => {
  it('shows a count that equals the number of cited elements of the named type, and the suite agrees', async () => {
    const evidence = await viewOf(labelled);
    const { type, keys } = twinsOf(labelled, evidence);
    const right: SummarySentence = { text: `${keys.length} ${type.toLowerCase().replaceAll('_', ' ')}s are listed.`, cites: [...keys] };
    const { kept, sent } = await summarize(undefined, right, evidence);
    expect(kept).toEqual([right]);
    expect(() => expectClean(kept, sent, labelled.invented_names)).not.toThrow();
  });

  it('removes the count that is one more, and counts the removal, and the canary shows it when the test of the arithmetic is taken out', async () => {
    const evidence = await viewOf(labelled);
    const { type, keys } = twinsOf(labelled, evidence);
    const wrong: SummarySentence = { text: `${keys.length + 1} ${type.toLowerCase().replaceAll('_', ' ')}s are listed.`, cites: [...keys] };
    const whole = await summarize(undefined, wrong, evidence);
    expect(whole.kept).toEqual([]);
    expect(whole.outcome.status).toBe('unsupported');
    const weakened = await summarize(NO_ARITHMETIC_TEST, wrong, evidence);
    expect(weakened.kept).toEqual([wrong]);
    expect(() => expectClean(weakened.kept, weakened.sent, labelled.invented_names)).toThrow(SuiteCheckFailed);
  });

  it.each(['At least', 'More than', 'In total'])('removes a count of cited elements said of another population (%s), and the canary shows it when the test of the population is taken out', async (lead) => {
    const evidence = await viewOf(labelled);
    const { type, keys } = twinsOf(labelled, evidence);
    const bounded: SummarySentence = { text: `${lead} ${keys.length} ${type.toLowerCase().replaceAll('_', ' ')}s are listed.`, cites: [...keys] };
    expect((await summarize(undefined, bounded, evidence)).kept).toEqual([]);
    const weakened = await summarize(NO_POPULATION_TEST, bounded, evidence);
    expect(weakened.kept).toEqual([bounded]);
    expect(() => expectClean(weakened.kept, weakened.sent, labelled.invented_names)).toThrow(SuiteCheckFailed);
  });

  it('removes the number of an estimated count stated without its label', async () => {
    const evidence = await viewOf(labelled);
    const sentence: SummarySentence = { text: 'There were 40 transfers.', cites: [evidence.estimated] };
    expect((await summarize(undefined, sentence, evidence)).kept).toEqual([]);
  });
});

describe('25 transactions over 25 cited transactions, in the case summary', () => {
  const transactions = Array.from({ length: 25 }, (_, index) => node('transaction', `T-${index + 1}`, `Transfer T-${index + 1}`));
  const cites = transactions.map((_, index) => `n${index + 1}`);
  const evidence = { view: reading(transactions) };
  const closingSchema = z.object({ action: z.literal('ai.case-summary.closed'), detail: z.object({ summary: z.record(z.string(), z.unknown()) }) });
  const closed = (rig: { readonly events: readonly { readonly action: string }[] }): Record<string, unknown> => closingSchema.parse(rig.events.find((event) => event.action === 'ai.case-summary.closed')).detail.summary;

  it('shows 25, and counts no removal in the closing event', async () => {
    const { kept, rig } = await summarize(undefined, { text: '25 transactions are listed.', cites }, evidence);
    expect(kept).toHaveLength(1);
    expect(closed(rig)).toMatchObject({ outcome: 'ok', sentencesKept: 1, sentencesRemoved: 0 });
  });

  it('removes 26, and counts the removal in the closing event', async () => {
    const { kept, rig } = await summarize(undefined, { text: '26 transactions are listed.', cites }, evidence);
    expect(kept).toEqual([]);
    expect(closed(rig)).toMatchObject({ outcome: 'unsupported', sentencesKept: 0, sentencesRemoved: 1 });
  });
});

describe('the count rule over every pack and every shape of the labelled set, with no code of a domain', () => {
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const counted = set.cases.flatMap((view) =>
    view.facts.flatMap((fact) => {
      const parts = fact.says.split(' ');
      const at = parts.findIndex((each) => WORDS.includes(each.toLowerCase()));
      const next = (parts[at + 1] ?? '').replace(/,$/u, '').toLowerCase();
      const names = view.entities.map((entity) => entity.type.toLowerCase());
      const word = parts[at];
      return word !== undefined && names.some((name) => next === name || next === `${name}s` || next === `${name}es`) ? [{ view, fact, word }] : [];
    }),
  );

  it('covers both packs and the AML views', () => {
    expect(new Set(counted.map((each) => each.view.pack))).toEqual(new Set(['banking-fraud', 'insurance-claims']));
    expect(counted.some((each) => each.view.shape !== undefined)).toBe(true);
    expect(counted.length).toBeGreaterThanOrEqual(10);
  });

  it.each(counted.map((each) => [`${each.view.pack}/${each.view.id}/${each.fact.id}`, each] as const))('keeps the count of %s as stated with its cited elements, in words and in digits, and removes a wrong one', async (_name, { view, fact, word }) => {
    const sentenceOf = (number: string): string => `${fact.says.replace(word, number)}.`;
    const value = WORDS.indexOf(word.toLowerCase());
    const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
    const run = async (text: string): Promise<boolean> => {
      const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
      await probe.summarize(readingOf(view));
      const keys = keyMapOf(view, probe.requests[0]?.values ?? '');
      const rig = startRig({ replies: [replyOf({ text, cites: fact.rests_on.map((key) => keys.get(key) ?? 'none') })], settings: { maxCalls: 1 } });
      await rig.summarize(readingOf(view));
      return (rig.store.runs[0]?.removals.length ?? 0) === 0;
    };
    expect(await run(sentenceOf(word.charAt(0) === word.charAt(0).toUpperCase() ? capital(WORDS[value] ?? '') : (WORDS[value] ?? '')))).toBe(true);
    expect(await run(sentenceOf(String(value)))).toBe(true);
    expect(await run(sentenceOf(capital(WORDS[value + 2] ?? 'twelve')))).toBe(false);
    expect(await run(sentenceOf(String(value + 2)))).toBe(false);
  });
});

describe('the suite\'s own rule for a count written in words', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => `n${index + 1}`);
  const sent = twelve.map((key, index) => `${key} | "widget" | title: "Item ${String.fromCharCode(65 + index)}" | id: "w${index + 1}"`).join('\n');

  it('supports a count in words from eleven that equals the cited elements of the type', () => {
    expect(numbersUnsupported({ text: 'Twelve widgets are listed.', cites: twelve }, sent)).toEqual([]);
    expect(numbersUnsupported({ text: 'Twelve of the widgets are listed.', cites: twelve }, sent)).toEqual(['12']);
  });

  it('does not support a wrong count in words, nor one said of another population', () => {
    expect(numbersUnsupported({ text: 'Thirteen widgets are listed.', cites: twelve }, sent)).toEqual(['13']);
    expect(numbersUnsupported({ text: 'At least twelve widgets are listed.', cites: twelve }, sent)).toEqual(['12']);
  });

  it('does not support another number written in words that no cited line holds, though the count of the sentence stands', () => {
    expect(numbersUnsupported({ text: 'Twelve widgets sum to ninety-nine.', cites: twelve }, sent)).toEqual(['99']);
    expect(numbersUnsupported({ text: 'Twelve widgets represent ninety-nine percent.', cites: twelve }, sent)).toEqual(['99']);
    expect(numbersUnsupported({ text: 'Twelve of them are listed.', cites: ['n1'] }, sent)).toEqual(['12']);
  });

  it('supports a number in words that a cited line holds, quoted or not', () => {
    const held = 'n1 | "widget" | title: "W" | id: "w1" | label: "twenty-five"\nn2 | "widget" | title: "V" | id: "w2" | rating: thirty';
    expect(numbersUnsupported({ text: 'The label is twenty-five.', cites: ['n1'] }, held)).toEqual([]);
    expect(numbersUnsupported({ text: 'The rating is thirty.', cites: ['n2'] }, held)).toEqual([]);
    expect(numbersUnsupported({ text: 'The label is twenty-six.', cites: ['n1'] }, held)).toEqual(['26']);
  });

  it('does not read the words of a quoted title as a number', () => {
    expect(numbersUnsupported({ text: '"Twelve widgets" is listed.', cites: ['n1'] }, sent)).toEqual([]);
  });

  it('breaks the rule of the quality of a count when a count that is not known is stated in words', () => {
    const lines = 'n1 | "payment" | title: "P" | id: "p1x" | members: not known';
    expect(countRuleBroken({ text: 'Twenty-five payments are listed.', cites: ['n1'] }, lines)).toBe(true);
    expect(countRuleBroken({ text: 'The payments are listed.', cites: ['n1'] }, lines)).toBe(false);
  });

  it('reads the words up to ten as a count too, and does not read one that opens no count', () => {
    expect(numbersUnsupported({ text: 'Three widgets are listed.', cites: twelve }, sent)).toEqual(['3']);
    expect(numbersUnsupported({ text: 'Twelve widgets are listed.', cites: twelve }, sent)).toEqual([]);
    expect(numbersUnsupported({ text: 'One of the widgets is listed.', cites: twelve }, sent)).toEqual([]);
  });

});

describe('the suite\'s own rule for a count that leaves out the elements named apart from it', () => {
  const titles = ['AC-5001', 'AC-5002', 'AC-5003', 'AC-5004', 'AC-5005', 'AC-5100'];
  const keys = titles.map((_, index) => `n${index + 1}`);
  const sent = titles.map((title, index) => `n${index + 1} | "account" | title: "${title}" | id: "${title}"`).join('\n');
  const unsupported = (text: string, cites: string[] = keys): string[] => numbersUnsupported({ text, cites }, sent);

  it.each([
    '5 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.',
    'Five accounts, AC-5001 to AC-5005, transferred to the account AC-5100.',
    'The account AC-5100 received from five accounts, AC-5001 to AC-5005.',
    'Six accounts, AC-5001, AC-5002, AC-5003, AC-5004, AC-5005 and AC-5100, are listed.',
  ])('supports the count that leaves out the one named apart: %s', (text) => {
    expect(unsupported(text)).toEqual([]);
  });

  it.each([
    ['Four accounts, AC-5001 to AC-5005, transferred to the account AC-5100.', '4'],
    ['4 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.', '4'],
    ['Seven accounts, AC-5001 to AC-5005, transferred to the account AC-5100.', '7'],
  ])('does not support a count that is neither the cited elements nor the cited elements less those named apart, digits or words: %s', (text, value) => {
    expect(unsupported(text)).toEqual([value]);
  });

  it.each([
    ['AC-5001 to AC-5005, five accounts, transferred to the account AC-5100.', []],
    ['AC-5001 to AC-5005, three accounts, transferred to the account AC-5100.', ['3']],
    ['Five accounts (AC-5001 to AC-5005) transferred to the account AC-5100.', []],
    ['Three accounts (AC-5001 to AC-5005) transferred to the account AC-5100.', ['3']],
    ['4 accounts (AC-5001, AC-5002, AC-5003, AC-5004 and AC-5005) transferred to the account AC-5100.', ['4']],
  ])('reads a list of names before the count or in parentheses as the count’s own: %s', (text, expected) => {
    expect(unsupported(text)).toEqual(expected);
  });

  it.each([
    ['Funds moved from five accounts to AC-5100.', []],
    ['Funds moved from four accounts to AC-5100.', ['4']],
    ['Payments from AC-5100 to five accounts.', []],
    ['Payments from AC-5100 to four accounts.', ['4']],
    ['Five accounts and AC-5100 are listed.', []],
    ['Four accounts and AC-5100 are listed.', ['4']],
  ])('does not take a name joined to the count by to or and alone for part of it: %s', (text, expected) => {
    expect(unsupported(text)).toEqual(expected);
  });

  it('does not let a number word in a title back a number of the sentence', () => {
    const held = 'n1 | "company" | title: "Five Rivers Ltd" | id: "CO-1"';
    expect(numbersUnsupported({ text: 'Five Rivers Ltd received 5 transfers.', cites: ['n1'] }, held)).toEqual(['5']);
  });

  it('does not take a name that two cited elements share for a target apart', () => {
    const shared = 'n1 | "account" | title: "Ana Silva" | id: "x1"\nn2 | "account" | title: "Ana Silva" | id: "x2"';
    expect(numbersUnsupported({ text: 'Ana Silva appears on two accounts.', cites: ['n1', 'n2'] }, shared)).toEqual([]);
    expect(numbersUnsupported({ text: 'Ana Silva appears on three accounts.', cites: ['n1', 'n2'] }, shared)).toEqual(['3']);
  });

  it('compares names composed or decomposed as the same text', () => {
    const accented = sent.replaceAll('AC-5100', 'Caf\u00e9');
    const said = (text: string): string[] => numbersUnsupported({ text, cites: keys }, accented);
    expect(said('Five accounts, AC-5001 to AC-5005, transferred to the account Cafe\u0301.')).toEqual([]);
    expect(said('Four accounts, AC-5001 to AC-5005, transferred to the account Cafe\u0301.')).toEqual(['4']);
  });

  it('reads a type name of any length and across any white space', () => {
    const type = 'registered commercial banking institution with extended supervision and reporting duties';
    const lines = ['n1', 'n2', 'n3'].map((key, index) => `${key} | "${type.replaceAll(' ', '_')}" | title: "Bank ${index + 1}" | id: "b${index + 1}"`).join('\n');
    expect(numbersUnsupported({ text: `Three  ${type.replaceAll(' ', '  ')}s are listed.`, cites: ['n1', 'n2', 'n3'] }, lines)).toEqual([]);
    expect(numbersUnsupported({ text: `Four ${type}s are listed.`, cites: ['n1', 'n2', 'n3'] }, lines)).toEqual(['4']);
  });

  it.each([
    '6 accounts, AC-5001 to AC-5005, transferred to the account AC-5100.',
    'Six accounts, AC-5001 to AC-5005, transferred to the account AC-5100.',
  ])('supports a count that equals all the cited elements, since its number is what the sentence cites: %s', (text) => {
    expect(unsupported(text)).toEqual([]);
  });

  it('supports four accounts of a cycle that names one of them at both ends', () => {
    const four = keys.slice(0, 4);
    expect(unsupported('Four accounts transfer in a closed cycle from AC-5001 back to AC-5001.', four)).toEqual([]);
    expect(unsupported('Five accounts transfer in a closed cycle from AC-5001 back to AC-5001.', four)).toEqual(['5']);
  });

  it('supports a count when none is named apart, and does not when it counts more than is cited', () => {
    expect(unsupported('Five accounts are listed.', keys.slice(0, 5))).toEqual([]);
    expect(unsupported('Six accounts are listed.', keys.slice(0, 5))).toEqual(['6']);
  });
});

describe('the suite\'s own rule for the count of cited elements', () => {
  const sent = ['n1 | "category" | title: "Alpha" | id: "a1"', 'n2 | "category" | title: "Beta" | id: "b2"', 'n3 | "widget" | title: "Gamma" | id: "g3"', 'n4 | "widget" | title: "Delta" | id: "d4"', 'e1 | "widget" | n3 -> n4', 'n5 | "Widget" | title: "Eps" | id: "e5"', 'n6 | "widget" | title: "Zeta" | id: "z6"', 'n7 | "money  movement" | title: "Eta" | id: "h7"', 'n8 | "money  movement" | title: "Theta" | id: "t8"'].join('\n');
  const unsupported = (text: string, cites: string[]): string[] => numbersUnsupported({ text, cites }, sent);

  it.each([
    ['2 categories are listed.', ['n1', 'n2']],
    ['2 widgets are listed.', ['n3', 'n4', 'e1']],
    ['1 widget is a relationship.', ['n3', 'e1']],
    ['1 widget is listed.', ['n5', 'n6']],
    ['2 money movements are listed.', ['n7', 'n8']],
    ['1 relationship is listed.', ['e1', 'n3']],
    ['2 entities are listed.', ['n1', 'n2', 'e1']],
    ['3 elements are listed.', ['n1', 'n2', 'e1']],
  ])('supports a correct count: %s', (text, cites) => {
    expect(unsupported(text, cites)).toEqual([]);
  });

  it.each([
    ['3 widgets are listed.', ['n3', 'n4', 'e1']],
    ['Twenty-two widgets are listed.', ['n3', 'n4', 'e1']],
    ['2 widgets are listed.', ['n5', 'n6']],
    ['2 categories have a fee of 2.', ['n1', 'n2']],
    ['2 categories are unretrieved.', ['n1', 'n2']],
    ['2 categories are not\tshown.', ['n1', 'n2']],
    ['At\nleast 2 categories are listed.', ['n1', 'n2']],
    ['2 relationships are listed.', ['e1', 'n3']],
    ['3 entities are listed.', ['n1', 'n2', 'e1']],
    ['In total 1 relationship is listed.', ['e1']],
  ])('does not support a number that is no count of the cited elements: %s', (text, cites) => {
    expect(unsupported(text, cites)).not.toEqual([]);
  });
});
