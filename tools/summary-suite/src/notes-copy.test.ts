import type { SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { keepersOf, loadCases, sentenceInKeys, type LabelledCase } from './cases.js';
import { defined } from './checks.js';
import { viewOf } from './rules.js';
import { INVESTIGATION, replyOf, startRig } from './testing/rig.js';
import { startNotesRig } from './testing/notes.js';

const set = loadCases();
const one = { maxCalls: 1 };

/** A draft of the kept sentences of a labelled view, as the model would write them. */
async function draftOf(labelled: LabelledCase) {
  const evidence = await viewOf(labelled);
  const keep = keepersOf(labelled).map((sentence) => sentenceInKeys(sentence, evidence.keys));
  const rig = startRig({ replies: [replyOf(...keep)], settings: one });
  const outcome = await rig.summarize(evidence.view);
  if (outcome.status !== 'ok') throw new Error(`${labelled.id}: the draft was not made (${outcome.status})`);
  return { outcome, evidence };
}

/** The text of a sentence outside its placeholders: what is left once every ‹kind#n› is taken out. */
const plainOf = (text: string): string => text.replace(/‹[^›]*›/gu, ' ');

const sentencesOf = (entry: unknown): { readonly text: string; readonly cites: readonly unknown[] }[] => {
  const sentences = (entry as { sentences?: unknown }).sentences;
  if (!Array.isArray(sentences)) throw new Error('the stored entry holds no sentences');
  return sentences.map((sentence: { text?: unknown; cites?: unknown }) => ({ text: String(sentence.text), cites: Array.isArray(sentence.cites) ? sentence.cites : [] }));
};

/** Keys under which a stored entry holds references to elements, where a stable id belongs. */
const REFERENCE_KEYS = new Set(['ref', 'of', 'relationship', 'inputRefs', 'cites']);

function leavesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, item]) => (REFERENCE_KEYS.has(key) ? [] : leavesOf(item)));
  return [];
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const holdsToken = (haystack: string, token: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(token.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(haystack.toLowerCase());

/** What a stored entry holds of the elements sent that it must not: in the sentences outside placeholders any title, id, property value or digit; in every field that is not a reference any title or property value. */
function leaksOf(entry: unknown, sent: SummaryReading): string[] {
  const plain = sentencesOf(entry)
    .map((sentence) => plainOf(sentence.text))
    .join('\n');
  const elements = [...sent.nodes, ...sent.edges];
  const titles = sent.nodes.map((node) => node.display.title);
  const ids = elements.map((element) => ('stableId' in element.ref ? element.ref.stableId : undefined)).filter((id): id is string => id !== undefined);
  const values = elements.flatMap((element) => element.properties.map((property) => String(property.value))).filter((value) => value.length > 1);
  const found: string[] = [];
  for (const title of titles) if (holdsToken(plain, title)) found.push(`title ${title}`);
  for (const id of ids) if (holdsToken(plain, id)) found.push(`id ${id}`);
  for (const value of values) if (holdsToken(plain, value)) found.push(`value ${value}`);
  if (/\d/u.test(plain)) found.push('a digit');
  const fields = leavesOf(entry);
  for (const title of titles) if (fields.some((field) => holdsToken(field, title))) found.push(`title ${title} in a field`);
  for (const value of values) if (fields.some((field) => holdsToken(field, value))) found.push(`value ${value} in a field`);
  return [...new Set(found)];
}

describe('the copy of a draft to the notes, for every labelled view', () => {
  it('copies exactly the sentences marked storable, for every labelled view', async () => {
    expect(set.cases).toHaveLength(17);
    let viewsThatCopy = 0;
    for (const labelled of set.cases) {
      const { outcome } = await draftOf(labelled);
      const notes = startNotesRig();
      const answer = await notes.copy(outcome.summaryToken);
      const storable = outcome.sentences.filter((sentence) => sentence.storable);
      expect(answer.copied, labelled.id).toBe(storable.length);
      expect(answer.copied + answer.notCopied, labelled.id).toBe(outcome.sentences.length);
      if (storable.length === 0) {
        expect(notes.stored.appended, labelled.id).toBe(0);
        continue;
      }
      viewsThatCopy += 1;
      const stored = sentencesOf(defined(notes.stored.entries[0], 'the entry'));
      expect(stored, labelled.id).toHaveLength(storable.length);
      storable.forEach((sentence, index) => expect(stored[index]?.cites.length, `${labelled.id} sentence ${index}`).toBe(new Set(sentence.cites).size));
    }
    expect(viewsThatCopy, 'the views that copy a sentence').toBeGreaterThanOrEqual(4);
  });

  it('stores placeholders and references only: no title, id, property value or number of the view, for every labelled view', async () => {
    let scanned = 0;
    for (const labelled of set.cases) {
      const { outcome, evidence } = await draftOf(labelled);
      const notes = startNotesRig();
      await notes.copy(outcome.summaryToken);
      for (const entry of notes.stored.entries) {
        scanned += 1;
        expect(leaksOf(entry, evidence.view), labelled.id).toEqual([]);
      }
    }
    expect(scanned, 'the entries scanned').toBeGreaterThanOrEqual(4);
  });

  it('the leak scan finds a planted title, id, value and number, in a sentence and in a field', async () => {
    const labelled = defined(set.cases.find((each) => each.entities.some((entity) => Object.keys(entity.props ?? {}).length > 0)), 'a view with a property');
    const { evidence } = await draftOf(labelled);
    const entity = defined(labelled.entities.find((each) => Object.keys(each.props ?? {}).length > 0), 'an entity with a property');
    const value = defined(Object.values(entity.props ?? {})[0], 'a value');
    const planted = (text: string, field = '') => ({ sentences: [{ text, placeholders: [{ name: '‹a#1›', descriptor: { kind: 'entity', label: field } }], cites: [] }] });
    expect(leaksOf(planted(`Look at ${entity.name} here.`), evidence.view)).toContain(`title ${entity.name}`);
    expect(leaksOf(planted(`Look at ${entity.id} here.`), evidence.view)).toContain(`id ${entity.id}`);
    expect(leaksOf(planted(`The value is ${value}.`), evidence.view)).toContain(`value ${value}`);
    expect(leaksOf(planted('There are 7 of them.'), evidence.view)).toContain('a digit');
    expect(leaksOf(planted('The ‹account#1› is linked.', `named ${entity.name}`), evidence.view)).toContain(`title ${entity.name} in a field`);
    expect(leaksOf(planted('The ‹account#1› is linked.', `holds ${value}`), evidence.view)).toContain(`value ${value} in a field`);
    expect(leaksOf(planted('The ‹account#1› is linked to the ‹account#2›.'), evidence.view)).toEqual([]);
  });

  it('records the copy in an audit event that holds no sentence, title, id or value of the view, for every labelled view', async () => {
    let recorded = 0;
    for (const labelled of set.cases) {
      const { outcome, evidence } = await draftOf(labelled);
      const notes = startNotesRig();
      const answer = await notes.copy(outcome.summaryToken);
      if (answer.copied === 0) continue;
      expect(notes.events.map((event) => event.action), labelled.id).toEqual(['ai.case-summary.copied']);
      const text = JSON.stringify(notes.events).toLowerCase();
      for (const sentence of outcome.sentences) expect(text, labelled.id).not.toContain(sentence.text.toLowerCase());
      for (const node of evidence.view.nodes) {
        expect(text, labelled.id).not.toContain(node.display.title.toLowerCase());
        for (const property of node.properties) if (String(property.value).length > 1) expect(text, labelled.id).not.toContain(String(property.value).toLowerCase());
      }
      recorded += 1;
    }
    expect(recorded).toBeGreaterThanOrEqual(4);
  });

  it('a second copy is alreadyCopied and stores nothing more', async () => {
    let checked = 0;
    for (const labelled of set.cases) {
      const { outcome } = await draftOf(labelled);
      const notes = startNotesRig();
      const first = await notes.copy(outcome.summaryToken);
      if (first.copied === 0) continue;
      expect(first.alreadyCopied, labelled.id).toBe(false);
      const second = await notes.copy(outcome.summaryToken);
      expect(second.alreadyCopied, labelled.id).toBe(true);
      expect(notes.stored.appended, labelled.id).toBe(1);
      checked += 1;
    }
    expect(checked, 'the views that copy a sentence').toBeGreaterThanOrEqual(4);
  });

  it('refuses a token for another investigation, another person, an expired one and one made under another policy version, and stores nothing', async () => {
    const { outcome } = await draftOf(defined(set.cases[0], 'the first view'));
    const notes = startNotesRig();
    const refused = { code: 'ACCESS_DENIED' };
    await expect(notes.copy(outcome.summaryToken, { investigation: { id: INVESTIGATION.replace(/2$/u, '3'), sourceId: 'demo' } })).rejects.toMatchObject(refused);
    await expect(notes.copy(outcome.summaryToken, { principalId: 'someone-else' })).rejects.toMatchObject(refused);
    await expect(notes.copy(outcome.summaryToken, { policyVersion: () => 'policy-2' })).rejects.toMatchObject(refused);
    expect(notes.stored.appended).toBe(0);
    const late = Date.now() + 31 * 60 * 1000;
    const real = Date.now;
    Date.now = () => late;
    try {
      await expect(notes.copy(outcome.summaryToken)).rejects.toMatchObject(refused);
    } finally {
      Date.now = real;
    }
    expect(notes.stored.appended).toBe(0);
  });

  it('converts the same view the same way twice', async () => {
    for (const labelled of set.cases) {
      const first = startNotesRig();
      const second = startNotesRig();
      await first.copy((await draftOf(labelled)).outcome.summaryToken);
      await second.copy((await draftOf(labelled)).outcome.summaryToken);
      expect(first.stored.entries.map(sentencesOf), labelled.id).toEqual(second.stored.entries.map(sentencesOf));
    }
  });
});
