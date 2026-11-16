import type { SummarySentence } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseOf, loadCases } from './cases.js';
import { defined, SuiteCheckFailed } from './checks.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { replyOf, startRig } from './testing/rig.js';
import { expectClean, viewOf, type Evidence } from './rules.js';

const set = loadCases();
const labelled = caseOf(set, 0);

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

const CASES: readonly { readonly mutation: Mutation; readonly breaking: (e: Evidence) => SummarySentence }[] = [
  {
    mutation: { name: 'citations', from: 'return sentence.cites.length > 0 && sentence.cites.every((cite) => assembled.keys.has(cite));', to: 'return true;' },
    breaking: (e) => ({ text: 'The first entity is listed.', cites: [e.first, 'n99'] }),
  },
  {
    mutation: { name: 'numbers on the cited lines', from: 'if (!numbers.every((number) => cited.has(number))) return false;', to: '' },
    breaking: (e) => ({ text: 'The ledger shows 7311.', cites: [e.first] }),
  },
  {
    mutation: { name: 'the unknown count', from: 'if (sentence.cites.some((cite) => assembled.unknownCountKeys.has(cite))) return false;', to: '' },
    breaking: (e) => ({ text: 'There were 7311 transfers.', cites: [e.unknown, e.second] }),
  },
  {
    mutation: { name: 'the label of an inexact count', from: 'return assembled.inexactCounts.every((count) => !standalone.includes(count.value) || sentence.text.includes(count.phrase));', to: 'return true;' },
    breaking: (e) => ({ text: 'There were 40 transfers.', cites: [e.estimated] }),
  },
  {
    mutation: { name: 'names', from: '|| !namesHold(sentence, assembled)', to: '' },
    breaking: (e) => ({ text: `${defined(labelled.invented_names[0], 'an invented name')} is connected.`, cites: [e.first] }),
  },
  {
    mutation: { name: 'verdict wording', from: 'if (holdsVerdict(original, assembled)) {', to: 'if (false) {' },
    breaking: (e) => ({ text: 'This is evidence of fraud.', cites: [e.first] }),
  },
];

async function answerWith(mutation: Mutation | undefined, sentence: SummarySentence, evidence: Evidence) {
  vi.resetModules();
  if (mutation !== undefined) {
    const mutant = await mutatedChecks(mutation);
    vi.doMock('../../../ee/ask/src/case-summary/checks.js', () => mutant);
  }
  const { createCaseSummarizer } = await import('../../../ee/ask/src/case-summary/summarizer.js');
  const rig = startRig({ replies: [replyOf(sentence)], settings: { maxCalls: 1 }, factory: createCaseSummarizer });
  const outcome = await rig.summarize(evidence.view);
  return { kept: outcome.status === 'ok' || outcome.status === 'partial' ? outcome.sentences : [], sent: defined(rig.requests[0], 'the request').values };
}

describe('a test taken out of the product\'s own checks leaves a sentence that the suite fails on', () => {
  for (const { mutation, breaking } of CASES) {
    it(`fails the suite when the source of the product no longer tests ${mutation.name}, and passes it with the product as it is`, async () => {
      const evidence = await viewOf(labelled);
      const sentence = breaking(evidence);
      const whole = await answerWith(undefined, sentence, evidence);
      expect(whole.kept).toEqual([]);
      expect(() => expectClean(whole.kept, whole.sent, labelled.invented_names)).not.toThrow();
      const weakened = await answerWith(mutation, sentence, evidence);
      expect(weakened.kept).toHaveLength(1);
      expect(() => expectClean(weakened.kept, weakened.sent, labelled.invented_names)).toThrow(SuiteCheckFailed);
    });
  }
});

describe('the rule about the title of a cited element, taken out of the product, leaves a good sentence removed and the suite fails on it', () => {
  it('removes the labelled keep sentence that quotes a title once the product reads the whole sentence for a verdict again, and keeps it with the product as it is', async () => {
    const view = defined(set.cases.find((each) => each.id === 'gateway-address-with-a-business-title'), 'the view');
    const quoted = defined(view.sentences.find((sentence) => sentence.label === 'keep' && sentence.text.startsWith('Crimson')), 'the sentence that quotes the title');
    const evidence = await viewOf(view);
    const asked = { text: quoted.text, cites: quoted.cites.map((key) => defined(evidence.keys.get(key), key)) };
    const whole = await answerWith(undefined, asked, evidence);
    expect(whole.kept).toEqual([asked]);
    const mutated = await answerWith({ name: 'the title of a cited element', from: 'return VERDICT.test(left);', to: 'return VERDICT.test(sentence.text);' }, asked, evidence);
    expect(mutated.kept).toEqual([]);
  });
});
