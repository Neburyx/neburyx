import { sealToken } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { loadCases, sentenceInKeys } from './cases.js';
import { defined } from './checks.js';
import { viewOf } from './rules.js';
import { INVESTIGATION, KEYS, replyOf, startRig } from './testing/rig.js';
import { startNotesRig } from './testing/notes.js';

const set = loadCases();
const first = defined(set.cases[0], 'the first view');

async function draft(text: string, cites: (e: Awaited<ReturnType<typeof viewOf>>) => string[], labelled = first) {
  const evidence = await viewOf(labelled);
  const rig = startRig({ replies: [replyOf({ text, cites: cites(evidence) })], settings: { maxCalls: 1 } });
  const outcome = await rig.summarize(evidence.view);
  if (outcome.status !== 'ok') throw new Error(`the draft was not made (${outcome.status})`);
  return { outcome, evidence, sentence: defined(outcome.sentences[0], 'the sentence') };
}

describe('why a sentence is not stored', () => {
  it('marks a sentence not storable with the reason group of each reason, and copies none', async () => {
    const second = defined(first.entities[1], 'the second entity').name;
    const cases: { readonly text: string; readonly cites: (e: Awaited<ReturnType<typeof viewOf>>) => string[]; readonly group: 'number' | 'value' | 'word' }[] = [
      { text: 'The record is listed on monday.', cites: (e) => [e.first], group: 'number' },
      { text: `The record is listed beside ${second}.`, cites: (e) => [e.first], group: 'value' },
      { text: 'The record is flummoxed.', cites: (e) => [e.first], group: 'word' },
      { text: 'The records are linked & open.', cites: (e) => [e.first, e.second], group: 'word' },
    ];
    for (const each of cases) {
      const { outcome, sentence } = await draft(each.text, each.cites).catch((error: unknown) => { throw new Error(`${each.text}: ${String(error)}`); });
      expect(sentence, each.text).toMatchObject({ storable: false, notStorable: each.group });
      const notes = startNotesRig();
      const answer = await notes.copy(outcome.summaryToken);
      expect(answer, each.text).toMatchObject({ copied: 0, notCopied: 1 });
      expect(notes.stored.appended, each.text).toBe(0);
    }
  });

  it('marks a sentence that needs more than the bound of slots as not storable, with no reason group', async () => {
    const entities = Array.from({ length: 51 }, (_, index) => ({ key: `k${index}`, type: first.entities[0]?.type ?? 'item', id: `B-${index}`, name: `B-${index}` }));
    const labelled = { ...first, entities, relationships: [], facts: first.facts.slice(0, 1), claims: first.claims.slice(0, 1), sentences: [], not_retrieved: undefined };
    const evidence = await viewOf({ ...labelled, entities, relationships: [] } as typeof first);
    const cites = evidence.view.nodes.map((_, index) => `n${index + 1}`);
    const text = `The records ${entities.map((entity) => entity.name).join(', ')} are listed.`;
    const rig = startRig({ replies: [replyOf({ text, cites })], settings: { maxCalls: 1, maxElements: 300 } });
    const outcome = await rig.summarize(evidence.view);
    if (outcome.status !== 'ok') throw new Error(`the draft was not made (${outcome.status})`);
    const only = defined(outcome.sentences[0], 'the sentence');
    expect(evidence.view.nodes).toHaveLength(51);
    expect(only.cites.length).toBeGreaterThan(50);
    expect(only.storable).toBe(false);
    expect(only.notStorable).toBeUndefined();
    const notes = startNotesRig();
    expect(await notes.copy(outcome.summaryToken)).toMatchObject({ copied: 0, notCopied: 1 });
    expect(notes.stored.appended).toBe(0);
  });

  it('refuses a token of another word list version', async () => {
    const notes = startNotesRig();
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
    await expect(notes.copy(token)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(notes.stored.appended).toBe(0);
  });

  it('every kept sentence of the labelled set that is not storable is named here, so a change of the word list shows in the set', async () => {
    const named: string[] = [];
    for (const labelled of set.cases) {
      const evidence = await viewOf(labelled);
      for (const sentence of labelled.sentences.filter((each) => each.label === 'keep')) {
        const asked = sentenceInKeys(sentence, evidence.keys);
        const rig = startRig({ replies: [replyOf(asked)], settings: { maxCalls: 1 } });
        const outcome = await rig.summarize(evidence.view);
        const only = outcome.status === 'ok' ? outcome.sentences[0] : undefined;
        if (only === undefined) named.push(`${labelled.id}/${sentence.id}: ${outcome.status}`);
        else if (!only.storable) named.push(`${labelled.id}/${sentence.id}: ${only.notStorable ?? 'bound'}`);
      }
    }
    expect(named).toEqual(NOT_STORED_KEEP_SENTENCES);
  });
});

/** The kept sentences of the labelled set that are not stored, and why: a change to the word list or to the conversion that stores one of them, or stops storing one that is stored, changes this list. */
const NOT_STORED_KEEP_SENTENCES: string[] = [
  'ring-on-one-device/s2: word',
  'merchant-with-many-payments/s1: word',
  'repeated-payments-between-two-accounts/s1: word',
  'claimants-sharing-a-phone/s1: word',
  'claimants-sharing-an-address/s1: word',
  'claims-filed-by-one-claimant/s1: word',
  'same-text-different-addresses/s1: word',
  'same-text-different-addresses/s2: word',
  'aml-fan-in/s1: number',
  'aml-fan-in/s2: word',
  'aml-fan-out/s1: word',
  'aml-fan-out/s2: word',
  'aml-cycle/s1: word',
  'aml-cycle/s2: word',
  'aml-rapid-pass-through/s1: number',
  'aml-rapid-pass-through/s2: word',
  'aml-shared-address/s1: word',
  'aml-shared-address/s2: word',
  'aml-fan-in-count-not-known/s1: number',
  'aml-fan-in-count-not-known/s2: word',
  'gateway-address-with-a-business-title/s1: word',
  'transfers-from-a-business-account/s1: word',
  'transfers-from-a-business-account/s2: word',
];
