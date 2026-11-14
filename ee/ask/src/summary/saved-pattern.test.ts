import { askSummarySchema, type AskRunResult, type ElementRef, type GraphNode, type PatternRunOk, type TemplateRunOk } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildSummary, citedKeysExist, listedElements } from './index.js';

const ref = (stableId: string, entityType = 'node_a'): ElementRef => ({ sourceId: 'demo', entityType, stableId });
const node = (stableId: string, title = stableId): GraphNode => ({
  ref: ref(stableId),
  display: { title, type: 'node_a' },
  properties: [{ key: 'private', value: 'PROPERTY-MARKER', dataClass: 'text', masked: false }],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const count = (quality: 'exact' | 'estimated' | 'lowerBound' | 'unknown', value?: number) => (value === undefined ? { quality, scope: 's' } : { quality, value, scope: 's' });
const hop = (from: string | null, to: string | null) => ({ relationshipType: 'LINKS', from: from === null ? null : ref(from), to: to === null ? null : ref(to) });
const match = (id: string, hops = 1, through: (string | null)[] = []) => ({ match: ref(id), hops, through: through.map((value) => (value === null ? null : ref(value))), relationships: Array.from({ length: hops }, (_, index) => hop(index === 0 ? 'a-1' : null, null)) });
const run = (over: Partial<PatternRunOk> = {}): PatternRunOk => ({ status: 'ok', templateVersion: '1', count: count('exact', 0), matches: [], nodes: [], edges: [], notices: [], warnings: ['WARNING-MARKER'], ...over });
const saved = (result: AskRunResult extends infer R ? (R extends { templateId: 'saved-pattern'; result: infer T } ? T : never) : never): AskRunResult => ({ templateId: 'saved-pattern', result }) as AskRunResult;

function checked(result: AskRunResult, anchor?: ElementRef) {
  const summary = buildSummary(result, { anchor });
  const listed = listedElements(result);
  if (summary === undefined || listed === undefined) throw new Error('no summary');
  expect(askSummarySchema.safeParse(summary).success).toBe(true);
  expect(citedKeysExist(summary, listed)).toBe(true);
  return summary;
}
const words = (result: AskRunResult, anchor?: ElementRef): string => checked(result, anchor).sentences.map((sentence) => sentence.text).join(' ');

const start = node('a-1', 'Alice');
const bob = node('b-1', 'Bob');
const cy = node('c-1', 'Cy');
const mid1 = node('m-1', 'Mid One');
const mid2 = node('m-2', 'Mid Two');

describe('no summary where there is nothing to cite', () => {
  it('gives none for a run that stopped as heavy, which lists nothing', () => {
    const heavy = saved({ status: 'heavy', templateVersion: '1', estimate: count('lowerBound', 1000), threshold: 1000, continueLimit: 25, notices: [], warnings: [] });
    expect(listedElements(heavy)).toBeUndefined();
    expect(buildSummary(heavy, {})).toBeUndefined();
  });

  it('gives none for an exact zero with no start to cite, and one sentence citing the start of the plan when there is one', () => {
    expect(buildSummary(saved(run()), {})).toBeUndefined();
    const result = saved(run({ nodes: [start] }));
    expect(words(result, start.ref)).toBe('No match was found for the saved pattern from Alice.');
  });

  it('repeats no notice in the zero path either: the sentence stands alone and there is no omissions line', () => {
    const result = saved(run({ nodes: [start], notices: [{ code: 'undatedExcluded' }] }));
    const summary = checked(result, start.ref);
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['No match was found for the saved pattern from Alice.']);
    expect(summary.omissions).toBeUndefined();
  });

  it('gives none when the result lists nothing a sentence could cite', () => {
    expect(buildSummary(saved(run({ count: count('exact', 3), matches: [match('b-1')] })), {})).toBeUndefined();
  });
});

describe('the summary of a pattern run', () => {
  it('names the matches in one sentence and the ones reached through listed entities in one more, citing listed elements only, with no count and no line for each match', () => {
    const result = saved(run({ count: count('exact', 2), matches: [match('b-1'), match('c-1', 2, ['m-1'])], nodes: [start, bob, cy, mid1] }));
    const summary = checked(result, start.ref);
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Bob and Cy match the saved pattern from Alice.', 'Cy is reached through Mid One.']);
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'Bob', 'Cy', 'Mid One']);
    expect(summary.omissions).toBe('2 shown.');
  });

  it('says one match in the singular and adds no sentence of steps when every shown match is one step away', () => {
    const one = saved(run({ count: count('exact', 1), matches: [match('b-1')], nodes: [start, bob] }));
    expect(checked(one, start.ref).sentences.map((sentence) => sentence.text)).toEqual(['Bob matches the saved pattern from Alice.']);
    const two = saved(run({ count: count('exact', 2), matches: [match('b-1'), match('c-1')], nodes: [start, bob, cy] }));
    const summary = checked(two, start.ref);
    expect(summary.sentences).toHaveLength(1);
    expect(summary.sentences[0]?.cites).toHaveLength(3);
  });

  it('reads as including when the count is not exact, even for few listed matches', () => {
    const cut = saved(run({ count: count('lowerBound', 2), matches: [match('b-1'), match('c-1')], nodes: [start, bob, cy] }));
    expect(words(cut, start.ref)).toBe('The matches of the saved pattern from Alice include Bob and Cy.');
  });

  it('names the start from the first hop of the first match when the plan has none, and never guesses one that is not listed', () => {
    const held = saved(run({ count: count('exact', 1), matches: [match('b-1')], nodes: [start, bob] }));
    expect(words(held)).toContain('from Alice');
    const unlisted = saved(run({ count: count('exact', 1), matches: [match('b-1')], nodes: [bob] }));
    expect(words(unlisted)).toBe('Bob matches the saved pattern.');
  });

  it('names the listed middle entities in order, skipping a null and an unlisted one, and no sentence for a match the result does not list', () => {
    const result = saved(run({ count: count('exact', 2), matches: [match('b-1', 4, ['m-1', null, 'm-9', 'm-2']), match('x-9')], nodes: [start, bob, mid1, mid2] }));
    const text = words(result, start.ref);
    expect(text).toContain('Bob is reached through Mid One and Mid Two.');
    expect(text).not.toContain('x-9');
  });

  it('says how many are not yet retrieved for one page of an exact or estimated count, and that more may exist for a lower bound', () => {
    const page = (quality: 'exact' | 'estimated' | 'lowerBound', value: number) => checked(saved(run({ count: count(quality, value), matches: [match('b-1')], nodes: [start, bob] })), start.ref).omissions;
    expect(page('exact', 38)).toBe('1 shown; 37 · exact not yet retrieved.');
    expect(page('estimated', 38)).toBe('1 shown; ~ 37 (estimated) not yet retrieved.');
    expect(page('lowerBound', 1)).toBe('1 shown; more may exist (lower bound).');
    expect(checked(saved(run({ count: count('unknown'), matches: [match('b-1')], nodes: [start, bob] })), start.ref).omissions).toBe('1 shown; how many are not yet retrieved is not known.');
  });

  it('reads as including when an exact count is larger than the matches listed', () => {
    const result = saved(run({ count: count('exact', 38), matches: [match('b-1')], nodes: [start, bob] }));
    expect(words(result, start.ref)).toBe('The matches of the saved pattern from Alice include Bob.');
  });

  it('names the first match with its first middle entity when it alone names more than the limit allows', () => {
    const many = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'].map((id) => node(id, `${'z'.repeat(80)}${id}`));
    const result = saved(run({ count: count('exact', 1), matches: [match('b-1', 7, many.map((entry) => entry.ref.stableId))], nodes: [start, bob, ...many] }));
    const sentence = checked(result, start.ref).sentences.find((entry) => entry.text.includes('is reached through'));
    expect(sentence?.text).toBe(`Bob is reached through ${many[0]?.display.title}.`);
  });

  it('names at most five matches and says no more than the count', () => {
    const many = Array.from({ length: 7 }, (_, index) => node(`n-${index}`, `Name ${index}`));
    const result = saved(run({ count: count('exact', 7), matches: many.map((entry) => match(entry.ref.stableId)), nodes: [start, ...many] }));
    const text = words(result, start.ref);
    expect(text).toContain('Name 4');
    expect(text).not.toContain('Name 5');
  });

  it('repeats no notice, so the supernodes a notice names are not cited', () => {
    const result = saved(run({ count: count('lowerBound', 1), matches: [match('b-1')], nodes: [start, bob, mid1], notices: [{ code: 'noStopList' }, { code: 'supernodesSkipped', entities: [mid1.ref] }] }));
    const summary = checked(result, start.ref);
    expect(JSON.stringify(summary)).not.toMatch(/stop list|supernode/);
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'Bob']);
  });

  it('holds no property value, no warning text and nothing of the result but node titles', () => {
    const result = saved(run({ count: count('exact', 1), matches: [match('b-1')], nodes: [start, bob], notices: [{ code: 'noStopList' }] }));
    const everything = JSON.stringify(checked(result, start.ref));
    for (const marker of ['PROPERTY-MARKER', 'WARNING-MARKER']) expect(everything).not.toContain(marker);
    for (const citation of checked(result, start.ref).citations) expect(citation.element.sourceId).toBe('demo');
  });
});

describe('the summary of a saved preset run', () => {
  it('is the summary of a run of its template, sentence for sentence', () => {
    const template: TemplateRunOk = { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: count('exact', 1), matchIds: [bob.ref], nodes: [start, bob], edges: [], notices: [], warnings: [] };
    const asTemplate = buildSummary({ templateId: 'shared-attribute', result: template } as AskRunResult, { anchor: start.ref });
    const asSaved = buildSummary(saved(template), { anchor: start.ref });
    expect(asSaved).toEqual(asTemplate);
    expect(asSaved).toBeDefined();
  });

  it('gives none for a preset run that stopped as heavy', () => {
    expect(buildSummary(saved({ status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: count('lowerBound', 1000), threshold: 1000, continueLimit: 25, notices: [] } as never), {})).toBeUndefined();
  });
});
