import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { caseOf, classesOf, keyMapOf, loadCases, parseCases, readingOf, sentenceInKeys, type LabelledCase, type LabelledSentence } from './cases.js';
import { countRuleBroken, defined, holdsVerdict, keysOfSentText, numbersUnsupported, rankingBroken, sentencesOf } from './checks.js';
import { checkedReplyOf, replyOf, startRig } from './testing/rig.js';
import { scoreLabelled, scoreSummary } from './score.js';

const here = dirname(fileURLToPath(import.meta.url));
const packSchema = z.object({ cases: z.array(z.object({ id: z.string() })) });
const FILE = resolve(here, '../cases/cases.yaml');
const original = readFileSync(FILE, 'utf8');
const set = loadCases();
const TYPOLOGY_SHAPES = ['fan-in', 'fan-out', 'cycle', 'rapid pass-through', 'shared device', 'shared address'];

/** The sent text of a case and the keys its elements received. */
async function assembled(labelled: LabelledCase) {
  const rig = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
  await rig.summarize(readingOf(labelled));
  const sent = defined(rig.requests[0], 'the request').values;
  return { sent, keys: keyMapOf(labelled, sent) };
}

/** The rules a sentence breaks, judged by the suite's own statements of them and not by the product. */
function brokenRules(labelled: LabelledCase, sentence: LabelledSentence, sent: string, keys: ReadonlyMap<string, string>): string[] {
  const asked = sentenceInKeys(sentence, keys);
  const rules: string[] = [];
  if (asked.cites.length === 0 || asked.cites.some((key) => !keysOfSentText(sent).has(key))) rules.push('citation');
  if (numbersUnsupported(asked, sent).length > 0 || countRuleBroken(asked, sent)) rules.push('number');
  if (labelled.invented_names.some((name) => asked.text.toLowerCase().includes(name.toLowerCase()))) rules.push('name');
  if (holdsVerdict(asked, sent)) rules.push('verdict');
  if (rankingBroken(asked, sent, classesOf(labelled))) rules.push('comparison');
  return rules;
}

describe('the labelled set', () => {
  it('holds 17 views: 10 demo views that restate a case of a demo pack and 7 AML views, one or more for each shape of the typology', () => {
    expect(set.cases).toHaveLength(17);
    const demo = set.cases.filter((labelled) => labelled.source_case !== undefined);
    const aml = set.cases.filter((labelled) => labelled.shape !== undefined);
    expect([demo.length, aml.length]).toEqual([10, 7]);
    for (const labelled of demo) {
      const pack = packSchema.parse(parse(readFileSync(resolve(here, '../../../domain-packs', labelled.pack, 'cases.yaml'), 'utf8')));
      expect(pack.cases.map((entry) => entry.id), labelled.id).toContain(labelled.source_case);
    }
    expect(new Set(aml.map((labelled) => labelled.shape))).toEqual(new Set(TYPOLOGY_SHAPES));
    expect(new Set(set.cases.map((labelled) => labelled.id)).size).toBe(17);
  });

  it('is synthetic: every name is from the list, and no value looks like a real e-mail address, phone number or account number', () => {
    const names = new Set(set.syntheticNames);
    for (const labelled of set.cases) {
      for (const entity of labelled.entities) if (entity.name !== entity.id) expect(names.has(entity.name), `${labelled.id}: ${entity.name}`).toBe(true);
      for (const name of labelled.invented_names) expect(names.has(name), `${labelled.id}: ${name}`).toBe(true);
    }
    // the two integers either side of the largest that a double holds exactly are in the set to test a ranking that rounding would get wrong
    const synthetic = original.replaceAll('9007199254740992', '0').replaceAll('9007199254740993', '0');
    expect(synthetic).not.toMatch(/@/u);
    for (const phone of synthetic.match(/\+?\d[\d -]{7,}\d/gu) ?? []) expect(phone, 'a phone-like value').toMatch(/^\+1-555-0\d{5}$|^\d{4}-\d{2}-\d{2}$/u);
    expect(synthetic).not.toMatch(/\d{9,}/u);
  });

  it('names the case when the file is invalid', () => {
    const broken = (from: string, to: string): string => original.replace(from, to);
    expect(() => parseCases(broken('label: "keep"', 'label: "maybe"'))).toThrow(/in the case ring-on-one-device/u);
    expect(() => parseCases('version: 1\nsynthetic_names: [a]\ncases: []')).toThrow(/invalid/u);
    expect(() => parseCases(broken('"r1", "r2", "r3", "r4"]', '"r1", "r99"]'))).toThrow(/in the case ring-on-one-device.*not in the view/u);
    expect(() => parseCases(broken('not_retrieved: { value: 997, quality: "estimated" }', 'not_retrieved: { quality: "exact" }'))).toThrow(/in the case shared-device-on-the-stop-list.*not a valid count/u);
    expect(() => parseCases(broken('not_retrieved: { quality: "unknown" }', 'not_retrieved: { value: 42, quality: "unknown" }'))).toThrow(/in the case aml-fan-in-count-not-known.*not a valid count/u);
    expect(() => parseCases(broken('invented_names: ["Mira Holt"]', 'invented_names: ["AC-2000"]'))).toThrow(/in the case ring-on-one-device.*invented name AC-2000 is in the view/u);
    expect(() => parseCases(broken('about: ["a1", "a2", "a3", "a4", "d1", "r1", "r2", "r3", "r4"] }', 'about: ["zz"] }'))).toThrow(/in the case ring-on-one-device.*claim c1 is about zz/u);
    expect(() => parseCases(broken('rule: "citation", ', ''))).toThrow(/names its rule/u);
    expect(() => parseCases(broken('    source_case: ring-on-one-device\n', ''))).toThrow(/in the case ring-on-one-device.*demo view \(source_case\) or an AML view/u);
  });

  it('gives every suite the same views as readings the summarizer takes, with a key for every element', async () => {
    for (const labelled of set.cases) {
      const { keys } = await assembled(labelled);
      expect(keys.size, labelled.id).toBe(labelled.entities.length + labelled.relationships.length);
    }
  });

  it('has labels that agree with the real checks and with the rule each names: a keep sentence breaks none and survives, a remove sentence breaks exactly its rule and is removed, a known slip is kept', async () => {
    for (const labelled of set.cases) {
      const { sent, keys } = await assembled(labelled);
      for (const sentence of labelled.sentences) {
        const where = `${labelled.id} ${sentence.id} (${sentence.label}${sentence.rule === undefined ? '' : ` ${sentence.rule}`})`;
        expect(brokenRules(labelled, sentence, sent, keys), where).toEqual(sentence.rule === undefined ? [] : [sentence.rule]);
        const rig = startRig({ replies: [JSON.stringify({ sentences: [sentenceInKeys(sentence, keys)] })], settings: { maxCalls: 1 } });
        const kept = sentencesOf(await rig.summarize(readingOf(labelled)));
        const survives = sentence.label === 'keep' || sentence.known_slip === true;
        expect(kept.length === 1, where).toBe(survives);
      }
    }
  });

  it('has keep sentences that state every fact and make no claim and no invented name', async () => {
    for (const labelled of set.cases) {
      const { keys } = await assembled(labelled);
      const keepers = labelled.sentences.filter((sentence) => sentence.label === 'keep').map((sentence) => sentenceInKeys(sentence, keys));
      const score = scoreSummary(labelled, keepers, keys);
      expect(score.factsMissed, labelled.id).toEqual([]);
      expect(score.claimsMade, labelled.id).toEqual([]);
      expect(score.inventedNamesKept, labelled.id).toEqual([]);
    }
  });
});

describe('the phrases of the claims that name a scheme', () => {
  const phrases = set.cases.flatMap((each) => each.claims.flatMap((claim) => claim.phrases)).map((phrase) => phrase.toLowerCase());
  const found = (sentence: string): boolean => phrases.some((phrase) => sentence.toLowerCase().includes(phrase));

  it('find a payment said to be structured, and do not find the word structural', () => {
    expect(found('The payments were structured to stay under the limit.')).toBe(true);
    expect(found('The structural layout of the view is a star.')).toBe(false);
  });
});

describe('the scorer', () => {
  const labelled = caseOf(set, 0);
  const sentences = (label: 'keep' | 'remove') => labelled.sentences.filter((sentence) => sentence.label === label && sentence.known_slip !== true);
  const firstFact = defined(labelled.facts[0], 'a fact');

  it('canary: a summary that says nothing misses every fact, and one that holds a claim phrase and an invented name is caught', async () => {
    const { keys } = await assembled(labelled);
    expect(scoreSummary(labelled, [], keys).factsMissed).toEqual(labelled.facts.map((fact) => fact.id));
    const name = defined(labelled.invented_names[0], 'an invented name');
    const score = scoreSummary(labelled, [{ text: `This is a fraud ring and ${name} runs it.`, cites: ['n1'] }], keys);
    expect(score.claimsMade).toContain('c1');
    expect(score.inventedNamesKept).toEqual([name]);
  });

  it('canary: a fact is found only when the sentence cites a key it rests on', async () => {
    const { keys } = await assembled(labelled);
    const phrase = defined(firstFact.phrases[0], 'a phrase');
    expect(scoreSummary(labelled, [{ text: `There are ${phrase}.`, cites: [] }], keys).factsFound).toEqual([]);
    expect(scoreSummary(labelled, [{ text: `There are ${phrase}.`, cites: [defined(keys.get('a1'), 'a1')] }], keys).factsFound).toContain('f1');
  });

  it('counts a good sentence that was removed, a sentence a check should have removed that was kept, and nothing for a reply that held neither', async () => {
    const { keys } = await assembled(labelled);
    const asked = [...sentences('keep'), ...sentences('remove')].map((sentence) => sentenceInKeys(sentence, keys));
    const keeps = sentences('keep').map((sentence) => sentenceInKeys(sentence, keys));
    expect(scoreLabelled(labelled, asked, asked, keys)).toEqual({ wronglyRemoved: [], slipped: sentences('remove').map((sentence) => sentence.id) });
    expect(scoreLabelled(labelled, asked, [], keys)).toEqual({ wronglyRemoved: sentences('keep').map((sentence) => sentence.id), slipped: [] });
    expect(scoreLabelled(labelled, asked, keeps, keys)).toEqual({ wronglyRemoved: [], slipped: [] });
    expect(scoreLabelled(labelled, [], [], keys)).toEqual({ wronglyRemoved: [], slipped: [] });
  });

  it('does not count as wrongly removed a sentence that holds a supported fact and forbidden wording, which the set labels remove', async () => {
    const { keys } = await assembled(labelled);
    const mixed = defined(labelled.sentences.find((sentence) => sentence.label === 'remove' && sentence.text.includes(defined(labelled.sentences[0], 'a sentence').text)), 'the mixed sentence');
    const asked = [sentenceInKeys(mixed, keys)];
    expect(scoreSummary(labelled, asked, keys).factsFound).toContain('f1');
    expect(scoreLabelled(labelled, asked, [], keys)).toEqual({ wronglyRemoved: [], slipped: [] });
  });

  it('counts a good sentence as kept when the checks took a key out of its text, with the real checked output', async () => {
    const { keys } = await assembled(labelled);
    const good = defined(sentences('keep')[0], 'a keep sentence');
    const asked = sentenceInKeys(good, keys);
    const keyed = { text: `${asked.text.replace(/\.$/u, '')} (${defined(asked.cites[0], 'a key')}).`, cites: asked.cites };
    const rig = startRig({ replies: [JSON.stringify({ sentences: [keyed] })], settings: { maxCalls: 1 } });
    const outcome = await rig.summarize(readingOf(labelled));
    const kept = sentencesOf(outcome);
    expect(kept[0]?.text).toBe(asked.text);
    expect(scoreLabelled(labelled, checkedReplyOf(rig.replies), kept, keys)).toEqual({ wronglyRemoved: [], slipped: [] });
  });

  it('scores only the reply that was checked: a labelled sentence of a reply that a further call replaced is not counted, through a real regeneration', async () => {
    const { keys } = await assembled(labelled);
    const [first, second] = sentences('keep').map((sentence) => sentenceInKeys(sentence, keys));
    const verdict = sentenceInKeys(defined(labelled.sentences.find((sentence) => sentence.rule === 'verdict'), 'a verdict sentence'), keys);
    const rig = startRig({ replies: [replyOf(defined(first, 'first'), verdict), replyOf(defined(second, 'second'))], settings: { maxCalls: 2 } });
    const kept = sentencesOf(await rig.summarize(readingOf(labelled)));
    expect(rig.requests).toHaveLength(2);
    expect(kept).toEqual([second]);
    expect(scoreLabelled(labelled, checkedReplyOf(rig.replies), kept, keys)).toEqual({ wronglyRemoved: [], slipped: [] });
    expect(scoreLabelled(labelled, [defined(first, 'first'), verdict], kept, keys).wronglyRemoved).toEqual([defined(sentences('keep')[0], 'a keep sentence').id]);
  });

  it('measures the accepted slips: a name in lower case passes the name check and is counted as slipped on a real checked reply', async () => {
    const slips = set.cases.flatMap((each) => each.sentences.filter((sentence) => sentence.known_slip === true).map((sentence) => ({ each, sentence })));
    expect(slips).toHaveLength(set.cases.length);
    for (const { each, sentence } of slips) {
      const { keys } = await assembled(each);
      const asked = sentenceInKeys(sentence, keys);
      const rig = startRig({ replies: [replyOf(asked)], settings: { maxCalls: 1 } });
      const kept = sentencesOf(await rig.summarize(readingOf(each)));
      expect(scoreLabelled(each, checkedReplyOf(rig.replies), kept, keys), each.id).toEqual({ wronglyRemoved: [], slipped: [sentence.id] });
    }
  });
});
