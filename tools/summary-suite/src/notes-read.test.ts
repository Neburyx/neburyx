import { EXPORT_HIDDEN_NOTE, type ElementRefs, type ElementsScope, type GraphEdge, type GraphNode, type SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { keepersOf, loadCases, sentenceInKeys, type LabelledCase } from './cases.js';
import { defined } from './checks.js';
import { COUNT_TYPES } from './evidence.js';
import { viewOf, type Evidence } from './rules.js';
import { startNotesRig } from './testing/notes.js';
import { replyOf, startRig } from './testing/rig.js';

const set = loadCases();

/** A draft of the given sentences over the view of a case, copied to the notes of a fresh rig. */
async function copied(labelled: LabelledCase, write?: (evidence: Evidence) => { text: string; cites: string[] }[]) {
  const evidence = await viewOf(labelled);
  const sentences = write === undefined ? keepersOf(labelled).map((sentence) => sentenceInKeys(sentence, evidence.keys)) : write(evidence);
  const rig = startRig({ replies: [replyOf(...sentences)], settings: { maxCalls: 1 } });
  const outcome = await rig.summarize(evidence.view);
  if (outcome.status !== 'ok') throw new Error(`${labelled.id}: the draft was not made (${outcome.status})`);
  const notes = startNotesRig();
  const answer = await notes.copy(outcome.summaryToken);
  return { notes, outcome, evidence, answer };
}

const hide = (view: SummaryReading, stableId: string): SummaryReading => ({
  ...view,
  nodes: view.nodes.filter((entity) => entity.ref.stableId !== stableId),
  edges: view.edges.filter((relationship) => relationship.from.stableId !== stableId && relationship.to.stableId !== stableId),
  omitted: true,
});

const masked = (view: SummaryReading): SummaryReading => ({ ...view, nodes: view.nodes.map((entity): GraphNode => ({ ...entity, display: { ...entity.display, title: `${entity.display.title.slice(0, 1)}•••` } })) });

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** A tally slot is rebuilt with digits where the model wrote a number word, so the two are compared in digits. */
const digitsOf = (text: string): string => text.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/giu, (word) => String(NUMBER_WORDS.indexOf(word.toLowerCase())));
interface StoredEntry {
  readonly sentences: readonly { readonly cites: readonly { readonly ref: unknown }[]; readonly placeholders: readonly { readonly descriptor: unknown }[] }[];
  readonly inputRefs: readonly { readonly ref: unknown }[];
}

/** The stable ids of the entities that a stored sentence cites or names. */
const entityIdsOf = (sentence: StoredEntry['sentences'][number]): string[] => [...JSON.stringify([sentence.cites, sentence.placeholders]).matchAll(/"entityType":"[^"]*","stableId":"([^"]+)"/gu)].map((match) => defined(match[1], 'an id'));

const PLACEHOLDER = /[‹›]/u;
const withCopies = set.cases.filter((labelled) => labelled.sentences.some((sentence) => sentence.label === 'keep'));

describe('the stored notes read by a viewer, for every labelled view', () => {
  it('rebuilds the stored sentences of every labelled view for a viewer who sees all, with no placeholder left and the sentences as drafted', async () => {
    let rebuilt = 0;
    for (const labelled of withCopies) {
      const { notes, outcome, evidence, answer } = await copied(labelled);
      if (answer.copied === 0) continue;
      const read = await notes.read(evidence.view);
      const [entry] = read.entries;
      expect(read.entries, labelled.id).toHaveLength(1);
      expect(entry?.sentences, labelled.id).toHaveLength(answer.copied);
      const drafted = outcome.sentences.filter((sentence) => sentence.storable).map((sentence) => sentence.text);
      expect(entry?.sentences.map((sentence) => digitsOf(sentence.text)), labelled.id).toEqual(drafted.map(digitsOf));
      for (const sentence of entry?.sentences ?? []) {
        expect(PLACEHOLDER.test(sentence.text), `${labelled.id}: ${sentence.text}`).toBe(false);
        expect(sentence.citations.length, labelled.id).toBeGreaterThan(0);
      }
      rebuilt += entry?.sentences.length ?? 0;
    }
    expect(rebuilt, 'sentences were rebuilt').toBeGreaterThan(0);
  });

  it('shows only masked titles to a viewer who asks for masking', async () => {
    let checked = 0;
    for (const labelled of withCopies) {
      const { notes, evidence, answer } = await copied(labelled);
      if (answer.copied === 0) continue;
      const scopes: ElementsScope[] = [];
      await notes.read(evidence.view, { scopes });
      const read = await notes.read(masked(evidence.view), { mask: true, scopes });
      expect(scopes.map((scope) => scope.mask), labelled.id).toEqual([false, true]);
      const titles = evidence.view.nodes.map((entity) => entity.display.title);
      for (const sentence of read.entries[0]?.sentences ?? []) {
        checked += 1;
        for (const title of titles) expect(sentence.text, `${labelled.id}: ${title}`).not.toContain(title);
        for (const citation of sentence.citations) if (citation.kind === 'entity') expect(citation.title, labelled.id).toMatch(/•/u);
      }
    }
    expect(checked, 'sentences were read masked').toBeGreaterThan(0);
  });

  it('omits silently the sentences that cite a hidden element and builds the own coverage line of the viewer', async () => {
    let dropped = 0;
    for (const labelled of withCopies) {
      const { notes, evidence, outcome, answer } = await copied(labelled);
      if (answer.copied === 0) continue;
      const stored = defined(notes.stored.entries[0], 'the entry') as unknown as StoredEntry;
      const counts = new Map<string, number>();
      for (const sentence of stored.sentences) for (const id of new Set(entityIdsOf(sentence))) counts.set(id, (counts.get(id) ?? 0) + 1);
      const target = [...counts.entries()].filter(([id]) => evidence.view.nodes.some((entity) => entity.ref.stableId === id)).sort((a, b) => b[1] - a[1])[0]?.[0];
      const cut = hide(evidence.view, defined(target, `${labelled.id}: an element that a stored sentence cites`));
      const surviving = stored.sentences.map((sentence, index) => ({ sentence, index })).filter(({ sentence }) => !entityIdsOf(sentence).includes(target ?? ''));
      const read = await notes.read(cut);
      const entry = defined(read.entries[0], 'the entry');
      const drafted = outcome.sentences.filter((sentence) => sentence.storable).map((sentence) => sentence.text);
      expect(entry.sentences.map((sentence) => digitsOf(sentence.text)), labelled.id).toEqual(surviving.map(({ index }) => digitsOf(defined(drafted[index], 'a drafted sentence'))));
      dropped += stored.sentences.length - surviving.length;
      const title = defined(evidence.view.nodes.find((entity) => entity.ref.stableId === target), 'the hidden element').display.title;
      for (const sentence of entry.sentences) {
        expect(sentence.text, labelled.id).not.toContain(title);
        expect(sentence.citations.some((citation) => JSON.stringify(citation.ref).includes(`"stableId":"${target}"`)), labelled.id).toBe(false);
      }
      const present = new Set([...cut.nodes.map((node) => JSON.stringify(node.ref)), ...cut.edges.map((edge) => JSON.stringify(edge.ref))]);
      const shown = stored.inputRefs.filter((input) => present.has(JSON.stringify(input.ref))).length;
      expect(entry.coverage, labelled.id).toBe(`${shown} of ${stored.inputRefs.length} elements this summary was made from are shown to you · ${EXPORT_HIDDEN_NOTE}`);
      expect(JSON.stringify(entry.sentences), labelled.id).not.toMatch(/omitted|hidden|removed|not shown/u);
    }
    expect(dropped, 'at least one sentence was dropped for a hidden element').toBeGreaterThan(0);
  });

  it('labels, then drops, a count that the reading of the viewer cannot state exactly', async () => {
    const labelled = defined(withCopies[0], 'a view');
    const { notes, evidence, answer } = await copied(labelled, (e) => [{ text: 'The relationship shows ~40 (estimated) items.', cites: [e.estimated] }]);
    expect(answer.copied).toBe(1);
    const relabelled = (quality: 'exact' | 'unknown', value?: number): SummaryReading => ({
      ...evidence.view,
      edges: evidence.view.edges.map((relationship): GraphEdge => (relationship.type === COUNT_TYPES.estimated ? { ...relationship, memberCount: { ...(value === undefined ? {} : { value }), quality, scope: 'coverage' } } : relationship)),
    });
    expect((await notes.read(evidence.view)).entries[0]?.sentences.map((sentence) => sentence.text)).toEqual(['The relationship shows ~40 (estimated) items.']);
    expect((await notes.read(relabelled('exact', 41))).entries[0]?.sentences.map((sentence) => sentence.text)).toEqual(['The relationship shows 41 (exact) items.']);
    expect((await notes.read(relabelled('unknown'))).entries[0]?.sentences).toEqual([]);
  });

  it('two viewers differ only by their own access', async () => {
    let compared = 0;
    for (const labelled of withCopies) {
      const { notes, evidence, answer } = await copied(labelled);
      if (answer.copied === 0) continue;
      const stored = defined(notes.stored.entries[0], 'the entry') as unknown as StoredEntry;
      const target = defined(stored.sentences.flatMap(entityIdsOf).find((id) => evidence.view.nodes.some((entity) => entity.ref.stableId === id)), `${labelled.id}: a cited element`);
      const full = await notes.read(evidence.view);
      const cut = await notes.read(hide(evidence.view, target));
      const fullTexts = new Set(full.entries[0]?.sentences.map((sentence) => sentence.text));
      const cutSentences = cut.entries[0]?.sentences ?? [];
      for (const sentence of cutSentences) expect(fullTexts.has(sentence.text), `${labelled.id}: ${sentence.text}`).toBe(true);
      expect(cutSentences.length, labelled.id).toBeLessThan(full.entries[0]?.sentences.length ?? 0);
      compared += 1;
    }
    expect(compared, 'the views compared').toBeGreaterThan(0);
  });

  it('reads the references of all entries in one batch', async () => {
    const labelled = defined(withCopies[0], 'a view');
    const evidence = await viewOf(labelled);
    const notes = startNotesRig();
    for (const text of ['The relationship shows ~40 (estimated) items.', 'The relationship shows ≥ 500 (lower bound) items.']) {
      const rig = startRig({ replies: [replyOf({ text, cites: [text.includes('estimated') ? evidence.estimated : evidence.lowerBound] })], settings: { maxCalls: 1 } });
      const outcome = await rig.summarize(evidence.view);
      if (outcome.status !== 'ok') throw new Error('no draft');
      await notes.copy(outcome.summaryToken);
    }
    const asked: ElementRefs[] = [];
    const read = await notes.read(evidence.view, { asked });
    expect(read.entries).toHaveLength(2);
    expect(asked).toHaveLength(1);
    const aggregates = JSON.stringify(asked[0]?.aggregates ?? []);
    for (const type of [COUNT_TYPES.estimated, COUNT_TYPES.lowerBound]) expect(aggregates).toContain(type);
  });
});
