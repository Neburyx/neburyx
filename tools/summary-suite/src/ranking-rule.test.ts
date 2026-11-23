import { afterEach, describe, expect, it, vi } from 'vitest';
import { classesOf, keyMapOf, loadCases, readingOf, sentenceInKeys, type LabelledCase } from './cases.js';
import { defined, rankingBroken } from './checks.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { replyOf, startRig } from './testing/rig.js';

const set = loadCases();
const caseOf = (id: string): LabelledCase => {
  const found = set.cases.find((labelled) => labelled.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

const NO_RANKING_TEST: Mutation = { name: 'the ranking test', from: 'return comparedElementsHold(sentence, assembled) && rankingHolds(sentence, assembled) && claimsAreBacked(sentence, assembled);', to: 'return comparedElementsHold(sentence, assembled) && claimsAreBacked(sentence, assembled);' };
const NO_TIE_RULE: Mutation = { name: 'the tie rule', from: 'if (top === undefined || (next !== undefined && compareValues(dataClass, top[1].value, next[1].value) === 0)) return false;', to: 'if (top === undefined) return false;' };
const NO_MASKED_RULE: Mutation = {
  name: 'the rule of a missing or masked value',
  from: 'if (!cited.includes(key) || entry === undefined || entry.value === undefined || !ORDERED_CLASSES.has(entry.dataClass)) return false;',
  to: 'if (!cited.includes(key) || entry === undefined) return false;\n    if (entry.value === undefined || !ORDERED_CLASSES.has(entry.dataClass)) continue;',
};

async function keptWith(labelled: LabelledCase, sentenceId: string, mutation?: Mutation): Promise<boolean> {
  vi.resetModules();
  const sentence = labelled.sentences.find((candidate) => candidate.id === sentenceId);
  if (sentence === undefined) throw new Error(`no sentence ${sentenceId}`);
  const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
  await probe.summarize(readingOf(labelled));
  const keys = keyMapOf(labelled, probe.requests[0]?.values ?? '');
  if (mutation !== undefined) vi.doMock('../../../ee/ask/src/case-summary/checks.js', async () => mutatedChecks(mutation));
  const { createCaseSummarizer } = await import('../../../ee/ask/src/case-summary/summarizer.js');
  const rig = startRig({ replies: [JSON.stringify({ sentences: [sentenceInKeys(sentence, keys)] })], settings: { maxCalls: 1 }, factory: createCaseSummarizer });
  await rig.summarize(readingOf(labelled));
  return (rig.store.runs[0]?.removals.length ?? 0) === 0;
}

describe('the suite\'s own rule for a ranking, over the views of both packs and an AML view', () => {
  const labelled = set.cases.flatMap((view) => view.sentences.filter((sentence) => sentence.rule === 'comparison' || /\b(?:largest|smallest|earliest|latest)\b/u.test(sentence.text)).map((sentence) => [`${view.pack}/${view.id}/${sentence.id}`, view, sentence.id, sentence.label] as const));

  it('holds a right ranking and a wrong one for each of the two packs and an AML view, with a tie, a masked value, a missing value, a date and an integer beyond what a double holds', () => {
    expect(new Set(labelled.map(([, view]) => view.pack))).toEqual(new Set(['banking-fraud', 'insurance-claims']));
    expect(labelled.some(([, view]) => view.shape !== undefined)).toBe(true);
    expect(labelled.some(([, , , label]) => label === 'keep')).toBe(true);
    expect(labelled.filter(([, , , label]) => label === 'remove').length).toBeGreaterThanOrEqual(5);
  });

  it.each(labelled)('judges %s as the product does', async (_name, view, id, label) => {
    expect(await keptWith(view, id)).toBe(label === 'keep');
  });
});

describe('a canary for each rule of a ranking: with the rule taken out of the product the wrong ranking is kept, and the suite\'s own rule still shows it', () => {
  const CASES: readonly (readonly [string, Mutation, string, string])[] = [
    ['the ranking test', NO_RANKING_TEST, 'merchant-with-many-payments', 's9'],
    ['the tie rule', NO_TIE_RULE, 'claims-filed-by-one-claimant', 's8'],
    ['the rule of a masked or missing value', NO_MASKED_RULE, 'aml-cycle', 's11'],
  ];

  it.each(CASES)('%s', async (_name, mutation, caseId, sentenceId) => {
    const view = caseOf(caseId);
    expect(await keptWith(view, sentenceId)).toBe(false);
    const sentence = view.sentences.find((candidate) => candidate.id === sentenceId);
    expect(sentence?.rule).toBe('comparison');
    const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
    await probe.summarize(readingOf(view));
    const sent = probe.requests[0]?.values ?? '';
    expect(rankingBroken(sentenceInKeys(defined(sentence, 'the labelled sentence'), keyMapOf(view, sent)), sent, classesOf(view))).toBe(true);
    expect(await keptWith(view, sentenceId, mutation)).toBe(true);
  });
});

describe('the suite\'s own rule leaves a property named with a ranking word, and a quantity, alone', () => {
  const sent = ['n1 | "widget" | title: "Item A" | id: "W-1" | minimumBalance: 10', 'n2 | "widget" | title: "Item B" | id: "W-2" | minimumBalance: 20'].join('\n');
  const classes = new Map([['minimumBalance', 'number']]);

  it('does not take a property that begins with the word for a ranking, and takes the ranking of it', () => {
    expect(rankingBroken({ text: 'Item A has a minimum balance of 10.', cites: ['n1'] }, sent, classes)).toBe(false);
    expect(rankingBroken({ text: 'Item A has a maximum of 10 widgets.', cites: ['n1'] }, sent, classes)).toBe(false);
    expect(rankingBroken({ text: 'Item A has the smallest minimum balance, 10.', cites: ['n1', 'n2'] }, sent, classes)).toBe(false);
    expect(rankingBroken({ text: 'Item B has the smallest minimum balance, 20.', cites: ['n1', 'n2'] }, sent, classes)).toBe(true);
  });

  it('takes a ranking word joined by a hyphen for a ranking', () => {
    expect(rankingBroken({ text: 'Item A is the highest-value widget, 10.', cites: ['n1'] }, sent, classes)).toBe(true);
    expect(rankingBroken({ text: 'Item A is a non-maximum widget.', cites: ['n1'] }, sent, classes)).toBe(false);
  });
});
