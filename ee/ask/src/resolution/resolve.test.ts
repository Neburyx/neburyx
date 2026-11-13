import type { AskEntityLookup, AskEntityMatches, AskEntitySearch, AskResolution, ElementRef } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_CLARIFICATION_CHOICES, MAX_RESOLUTION_READS, resolveMentions, type ResolveInput } from './resolve.js';

const SOURCE = 'src-a';
const ref = (entityType: string, stableId: string, sourceId = SOURCE): ElementRef => ({ sourceId, entityType, stableId });
const exactly = (count: number): AskEntityMatches['count'] => ({ value: count, quality: 'exact', scope: 'test' });
const found = (...refs: ElementRef[]): AskEntityMatches => ({ refs, unreferenced: 0, count: exactly(refs.length) });
const NONE: AskEntityMatches = found();

interface Rig {
  readonly searched: string[];
  readonly lookedUp: ElementRef[];
  readonly input: (message: string, extra?: Partial<ResolveInput>) => ResolveInput;
}

function rig(answers: Readonly<Record<string, AskEntityMatches>>, known: readonly ElementRef[] = []): Rig {
  const searched: string[] = [];
  const lookedUp: ElementRef[] = [];
  const search: AskEntitySearch = async ({ text }) => (searched.push(text), answers[text] ?? NONE);
  const lookup: AskEntityLookup = async (target) => (lookedUp.push(target), known.some((entry) => entry.entityType === target.entityType && entry.stableId === target.stableId));
  return { searched, lookedUp, input: (message, extra = {}) => ({ message, resolutions: [], sourceId: SOURCE, search, lookup, signal: new AbortController().signal, ...extra }) };
}

const A1 = ref('node_a', 'A-1');
const A2 = ref('node_a', 'A-2');
const B1 = ref('node_b', 'K-1');

describe('resolving a typed mention', () => {
  it('replaces a typed stable ID with the placeholder of its entity and keeps the typed ID out of the text', async () => {
    const { input } = rig({ 'A-1': found(A1) });
    const outcome = await resolveMentions(input('Who is linked to A-1?'));
    expect(outcome).toMatchObject({ status: 'resolved', text: 'Who is linked to ‹node_a#1›?', capReached: false });
    if (outcome.status !== 'resolved') return;
    expect(outcome.placeholders.get('‹node_a#1›')).toEqual({ kind: 'entity', ref: A1 });
    expect(outcome.text).not.toContain('A-1');
  });

  it('replaces a typed name found through a search property, taking the span of several words', async () => {
    const { input, searched } = rig({ 'Jordan Lee': found(B1) });
    const outcome = await resolveMentions(input('Show Jordan Lee please'));
    expect(outcome).toMatchObject({ status: 'resolved', text: 'Show ‹node_b#1› please' });
    expect(searched[0]).toBe('Show Jordan Lee');
  });

  it('numbers placeholders by order of appearance for each type, and gives one entity one placeholder', async () => {
    const { input } = rig({ 'A-2': found(A2), 'A-1': found(A1), 'K-1': found(B1) });
    const outcome = await resolveMentions(input('A-2 and A-1 and K-1 and A-2 again', { skipWords: new Set(['and', 'again']) }));
    expect(outcome).toMatchObject({ status: 'resolved', text: '‹node_a#1› and ‹node_a#2› and ‹node_b#1› and ‹node_a#1› again' });
  });

  it('leaves a span that matches nothing as typed', async () => {
    const { input } = rig({});
    expect(await resolveMentions(input('Who is Nobody?'))).toMatchObject({ status: 'resolved', text: 'Who is Nobody?' });
  });

  it('fails with the failure of the search and returns no text', async () => {
    const failing = { ...rig({}).input('Who is A-1?'), search: async () => Promise.reject(new Error('search failed')) };
    await expect(resolveMentions(failing)).rejects.toThrow('search failed');
  });

  it('does not search a span that starts or ends with a word to skip, so none made only of such words', async () => {
    const { input, searched } = rig({});
    await resolveMentions(input('who shares a thing with A-1', { skipWords: new Set(['who', 'shares', 'a', 'thing', 'with']) }));
    expect(searched).toEqual(['A-1']);
  });
});

describe('bounding the mention search', () => {
  it('makes at most the budget of searches, leaves the rest as typed and says the cap was reached', async () => {
    const { input, searched } = rig({});
    const words = Array.from({ length: 20 }, (_, index) => `word${index}`).join(' ');
    const outcome = await resolveMentions(input(words));
    expect(searched).toHaveLength(MAX_RESOLUTION_READS);
    expect(outcome).toMatchObject({ status: 'resolved', text: words, capReached: true });
  });

  it('searches spans of 1 to 3 words, longest first and left to right, and skips spans shorter than 2 characters and spans that overlap a match', async () => {
    const { input, searched } = rig({ 'aa bb cc': found(A1) });
    const outcome = await resolveMentions(input('aa bb cc d'));
    expect(searched).toEqual(['aa bb cc']);
    expect(outcome).toMatchObject({ text: '‹node_a#1› d' });
    const second = rig({});
    await resolveMentions(second.input('aa bb cc d'));
    expect(second.searched).toEqual(['aa bb cc', 'bb cc d', 'aa bb', 'bb cc', 'cc d', 'aa', 'bb', 'cc']);
  });

  it('stops without a further search when the signal fires', async () => {
    const controller = new AbortController();
    const searched: string[] = [];
    const search: AskEntitySearch = async ({ text }) => (searched.push(text), controller.abort(), NONE);
    const { input } = rig({});
    await expect(resolveMentions({ ...input('aa bb cc'), search, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(searched).toHaveLength(1);
  });

  it('fails, and makes no placeholder, when a match names another source', async () => {
    const { input } = rig({ 'A-1': found(ref('node_a', 'A-1', 'src-b')) });
    await expect(resolveMentions(input('A-1'))).rejects.toThrow('another source');
  });
});

describe('a mention that fits several entities', () => {
  it('asks which one for the leftmost such mention, with the choices and the count, and builds no text', async () => {
    const { input } = rig({ Lee: found(A1, A2), Kim: found(B1, A1) });
    const outcome = await resolveMentions(input('Kim and Lee'));
    expect(outcome).toEqual({ status: 'clarification', clarification: { start: 0, end: 3, choices: [B1, A1], count: exactly(2), unreferenced: 0 } });
  });

  it('never resolves one referenced hit that comes with a hit that has no reference', async () => {
    const { input } = rig({ 'A-1': { refs: [A1], unreferenced: 2, count: exactly(3) } });
    const outcome = await resolveMentions(input('A-1'));
    expect(outcome).toMatchObject({ status: 'clarification', clarification: { choices: [A1], unreferenced: 2 } });
  });

  it('offers at most the ten first choices with the count the search gave, lower bound included', async () => {
    const many = Array.from({ length: 14 }, (_, index) => ref('node_a', `A-${index}`));
    const { input } = rig({ Lee: { refs: many, unreferenced: 0, count: { value: 14, quality: 'lowerBound', scope: 'test' } } });
    const outcome = await resolveMentions(input('Lee'));
    expect(outcome).toMatchObject({ status: 'clarification', clarification: { count: { value: 14, quality: 'lowerBound' } } });
    if (outcome.status !== 'clarification') return;
    expect(outcome.clarification.choices).toEqual(many.slice(0, MAX_CLARIFICATION_CHOICES));
  });

  it('resolves it with a pick among the choices and resolves the other mentions as usual', async () => {
    const pick: AskResolution = { start: 8, end: 11, ref: A2 };
    const { input, lookedUp } = rig({ Lee: found(A1, A2), 'K-1': found(B1) }, [A2]);
    const outcome = await resolveMentions(input('K-1 and Lee', { resolutions: [pick] }));
    expect(outcome).toMatchObject({ status: 'resolved', text: '‹node_b#1› and ‹node_a#1›' });
    expect(lookedUp).toEqual([A2]);
  });

  it('resolves a pick for a span the search did not find, once the lookup confirms the entity', async () => {
    const { input } = rig({}, [B1]);
    expect(await resolveMentions(input('Show jordan', { resolutions: [{ start: 5, end: 11, ref: B1 }] }))).toMatchObject({ status: 'resolved', text: 'Show ‹node_b#1›' });
  });

  it.each<[string, AskResolution[], string]>([
    ['a reference the lookup does not confirm', [{ start: 0, end: 3, ref: A1 }], 'unconfirmed-reference'],
    ['a reference of another source', [{ start: 0, end: 3, ref: ref('node_a', 'A-1', 'src-b') }], 'other-source'],
    ['a span outside the message', [{ start: 0, end: 99, ref: A1 }], 'out-of-range'],
    ['an empty span', [{ start: 4, end: 4, ref: A1 }], 'out-of-range'],
    ['a span that starts inside a word', [{ start: 1, end: 3, ref: A1 }], 'out-of-range'],
    ['a span that ends inside a word', [{ start: 0, end: 2, ref: A1 }], 'out-of-range'],
    ['two spans that overlap', [{ start: 0, end: 7, ref: A1 }, { start: 4, end: 11, ref: A2 }], 'overlap'],
    ['more than ten picks', Array.from({ length: 11 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, ref: A1 })), 'too-many'],
  ])('refuses %s and builds no text', async (_name, resolutions, reason) => {
    const { input } = rig({}, []);
    expect(await resolveMentions(input('abc def ghi jkl a b c d e f g h i j k l', { resolutions }))).toEqual({ status: 'refused', reason });
  });

  it.each([['a picked span that splits a pair of surrogate code units', '𝒳𝒴 next', [{ start: 1, end: 4, ref: A1 }]]])('refuses %s', async (_name, message, resolutions) => {
    const { input } = rig({}, [A1]);
    expect(await resolveMentions(input(message, { resolutions }))).toEqual({ status: 'refused', reason: 'out-of-range' });
  });

  it('counts the lookups of the picks within the budget of reads', async () => {
    const picks: AskResolution[] = Array.from({ length: 10 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, ref: ref('node_a', `A-${index}`) }));
    const known = picks.flatMap((pick) => ('ref' in pick ? [pick.ref] : []));
    const { input, searched, lookedUp } = rig({}, known);
    await resolveMentions(input('a b c d e f g h i j kk ll mm nn', { resolutions: picks }));
    expect(lookedUp).toHaveLength(10);
    expect(searched.length + lookedUp.length).toBeLessThanOrEqual(MAX_RESOLUTION_READS);
  });
});

describe('a typed value marked as a value to search for', () => {
  it('becomes a value placeholder whose text stays in the map, and makes no entity reference', async () => {
    const { input, searched } = rig({});
    const outcome = await resolveMentions(input('Which have reference PAY-77?', { resolutions: [{ start: 21, end: 27, value: true }] }));
    expect(outcome).toMatchObject({ status: 'resolved', text: 'Which have reference ‹value#1›?' });
    if (outcome.status !== 'resolved') return;
    expect(outcome.placeholders.get('‹value#1›')).toEqual({ kind: 'value', text: 'PAY-77' });
    expect(searched).not.toContain('PAY-77');
  });

  it('makes no value placeholder for a value nobody marked', async () => {
    const { input } = rig({});
    expect(await resolveMentions(input('Which have reference PAY-77?'))).toMatchObject({ text: 'Which have reference PAY-77?' });
  });

  it('gives the same value one placeholder and numbers different values in order of appearance', async () => {
    const { input } = rig({});
    const outcome = await resolveMentions(input('XX-1 YY-2 XX-1', { resolutions: [{ start: 0, end: 4, value: true }, { start: 5, end: 9, value: true }, { start: 10, end: 14, value: true }] }));
    expect(outcome).toMatchObject({ text: '‹value#1› ‹value#2› ‹value#1›' });
  });

  it('refuses a value longer than the search text limit', async () => {
    const { input } = rig({});
    const long = 'x'.repeat(201);
    expect(await resolveMentions(input(long, { resolutions: [{ start: 0, end: long.length, value: true }] }))).toEqual({ status: 'refused', reason: 'value-too-long' });
  });

  it('refuses a value that overlaps a pick', async () => {
    const { input } = rig({}, [A1]);
    expect(await resolveMentions(input('ab cd ef gh', { resolutions: [{ start: 0, end: 5, value: true }, { start: 3, end: 8, ref: A1 }] }))).toEqual({ status: 'refused', reason: 'overlap' });
  });

  it('keeps entity and value entries apart in the map', async () => {
    const { input } = rig({ 'A-1': found(A1) });
    const outcome = await resolveMentions(input('A-1 PAY-77', { resolutions: [{ start: 4, end: 10, value: true }] }));
    if (outcome.status !== 'resolved') throw new Error('not resolved');
    expect([...outcome.placeholders.values()].map((entry) => entry.kind)).toEqual(['entity', 'value']);
  });
});

describe('the resolved text', () => {
  it('names where each placeholder is in it, in code units of the resolved text', async () => {
    const { input } = rig({ 'A-1': found(A1), 'K-1': found(B1) });
    const outcome = await resolveMentions(input('A-1 then K-1 then A-1'));
    if (outcome.status !== 'resolved') throw new Error('not resolved');
    expect(outcome.text).toBe('‹node_a#1› then ‹node_b#1› then ‹node_a#1›');
    expect(outcome.spans).toEqual([
      { start: 0, end: 10, placeholder: '‹node_a#1›' },
      { start: 16, end: 26, placeholder: '‹node_b#1›' },
      { start: 32, end: 42, placeholder: '‹node_a#1›' },
    ]);
    for (const span of outcome.spans) expect(outcome.text.slice(span.start, span.end)).toBe(span.placeholder);
  });

  it.each(['Who is ‹node_a#1›?', 'Who is A-1 ›'])('refuses a message that holds a placeholder bracket, before any read: %s', async (message) => {
    const { input, searched, lookedUp } = rig({ 'A-1': found(A1) });
    expect(await resolveMentions(input(message))).toEqual({ status: 'refused', reason: 'typed-placeholder' });
    expect([searched, lookedUp]).toEqual([[], []]);
  });

  it.each([['a type with a space', 'node a'], ['a type with a bracket and a hash', 'node‹#1›'], ['a type named value', 'value']])('names a placeholder with a neutral kind for %s, so it cannot be taken for another placeholder', async (_name, entityType) => {
    const { input } = rig({ 'X-1': found(ref(entityType, 'X-1')) });
    const outcome = await resolveMentions(input('X-1'));
    expect(outcome).toMatchObject({ status: 'resolved', text: '‹entity#1›' });
  });
});
