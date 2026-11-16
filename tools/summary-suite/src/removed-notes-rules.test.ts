import { sealToken } from '@neburyx/ee-ask';
import type { CaseSummaryOutcome } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCases } from './cases.js';
import { defined } from './checks.js';
import { mutatedModule, type Mutation } from './mutants.js';
import { viewOf, type Evidence } from './rules.js';
import { startNotesRig } from './testing/notes.js';
import { INVESTIGATION, KEYS, replyOf, startRig } from './testing/rig.js';

const set = loadCases();
const ring = defined(set.cases.find((each) => each.id === 'ring-on-one-device'), 'the ring view');
/** The ring view with a property value that is an ordinary word of the list on its last entity, which no sentence cites. */
const withListedValue = { ...ring, entities: ring.entities.map((entity, index) => (index === ring.entities.length - 1 ? { ...entity, props: { ...(entity.props ?? {}), kind: 'address' } } : entity)) };

type Sentence = { readonly text: string; readonly cites: (e: Evidence) => string[]; readonly view?: typeof ring };

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/notes-rule.js');
  vi.doUnmock('../../../ee/ask/src/case-summary/notes-convert.js');
  vi.resetModules();
});

async function markOf(file: 'notes-rule' | 'notes-convert', mutation: Mutation | undefined, sentence: Sentence): Promise<CaseSummaryOutcome> {
  vi.resetModules();
  if (mutation !== undefined) {
    const mutant = await mutatedModule(`${file}.ts`, mutation);
    vi.doMock(`../../../ee/ask/src/case-summary/${file}.js`, () => mutant);
  }
  const { createCaseSummarizer } = await import('../../../ee/ask/src/case-summary/summarizer.js');
  const evidence = await viewOf(sentence.view ?? ring);
  const rig = startRig({ replies: [replyOf({ text: sentence.text, cites: sentence.cites(evidence) })], settings: { maxCalls: 1 }, factory: createCaseSummarizer });
  return rig.summarize(evidence.view);
}

const first = async (outcome: CaseSummaryOutcome) => (outcome.status === 'ok' ? defined(outcome.sentences[0], 'the sentence') : undefined);

const RULES: { readonly name: string; readonly file: 'notes-rule' | 'notes-convert'; readonly mutation: Mutation; readonly sentence: Sentence; readonly whole: object; readonly weakened: object }[] = [
  {
    name: 'a word of a date',
    file: 'notes-rule',
    mutation: { name: 'the date words', from: "if (NUMBER_OR_DATE_WORDS.has(word.toLowerCase())) return fail('number-or-date');", to: '' },
    sentence: { text: 'The record is listed on monday.', cites: (e) => [e.first] },
    whole: { storable: false, notStorable: 'number' },
    weakened: { storable: false, notStorable: 'word' },
  },
  {
    name: 'a symbol that is no word',
    file: 'notes-rule',
    mutation: { name: 'the stray symbols', from: "if (/[^\\s.,;:()!?\"'’-]/u.test(punctuation)) return fail('unlisted-word');", to: '' },
    sentence: { text: 'The records are linked & open.', cites: (e) => [e.first] },
    whole: { storable: false, notStorable: 'word' },
    weakened: { storable: true },
  },
  {
    name: 'a property value of an element the sentence does not cite',
    file: 'notes-convert',
    mutation: { name: 'the property values', from: "if (wholeToken(value).test(text)) return { storable: false, reason: 'property-value' };", to: '' },
    sentence: { text: 'The record is an address.', cites: (e) => [e.first], view: withListedValue },
    whole: { storable: false, notStorable: 'value' },
    weakened: { storable: true },
  },
];

describe('a rule of the storage of AI notes taken out of the product leaves a sentence stored or wrongly marked, and the suite fails on it', () => {
  it.each(RULES)('fails the suite when the source of the product no longer tests $name, and passes it with the product as it is', async (each) => {
    expect(await first(await markOf(each.file, undefined, each.sentence))).toMatchObject(each.whole);
    expect(await first(await markOf(each.file, each.mutation, each.sentence))).toMatchObject(each.weakened);
  });

  it('fails the suite when the source of the copy no longer checks the word list version of the token, and passes it with the product as it is', async () => {
    const mutant = await mutatedModule('copy-route.ts', { name: 'the word list version at copy', from: 'if (!opened.ok || opened.payload.wordListVersion !== NOTES_WORD_LIST_VERSION) throw', to: 'if (!opened.ok) throw' });
    const token = sealToken(
      KEYS,
      {
        investigationId: INVESTIGATION,
        generatedBy: 'analyst-1',
        policyVersion: 'policy-1',
        modelRef: 'claude-sonnet-5-5',
        promptId: 'case-summary',
        promptVersion: '1',
        sentences: [{ text: 'The record is listed.', cites: ['n1'] }],
        inputRefs: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } }],
        propertyValuesSent: false,
        runId: '0192f000-0000-7000-8000-0000000000aa',
        mask: false,
        wordListVersion: 1,
        templates: [{ storable: true, text: 'The record is listed.', placeholders: [] }],
      },
      Date.now(),
    );
    const whole = startNotesRig();
    await expect(whole.copy(token)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(whole.stored.appended).toBe(0);
    const weakened = startNotesRig({ createCopyRoute: mutant['createCopyToNotesRoute'] as never });
    expect((await weakened.copy(token)).copied).toBe(1);
  });
});

