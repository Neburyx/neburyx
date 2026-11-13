import type { AiMappingView, AskPatternOffer } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { questionVocabulary } from '../vocabulary/vocabulary.js';
import { buildPatternCatalog } from './catalog.js';
import { PATTERN_LABEL_NOTE } from './catalog-text.js';
import { labelOf } from './label.js';

const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'gadget', kind: 'entity', properties: [] }, { name: 'link', kind: 'relationship', properties: [] }] };
const VOCABULARY = questionVocabulary({ view: VIEW });
const offer = (id: string, name: string): AskPatternOffer => ({ id, version: 1, name, projection: { kind: 'definition', anchorType: 'widget', startingEntity: 'asked', steps: [{ relationshipTypes: ['link'], direction: 'out', arrivesAt: 'gadget', conditions: [], windowed: false }] } });

describe('the name of a pattern as a label', () => {
  it('is the name as the allowlist rebuilt it when every token is a word of the vocabulary or a common word', () => {
    expect(labelOf('Widgets and gadgets', VOCABULARY)).toEqual({ label: 'Widgets and gadgets', blocked: [] });
  });

  it.each([
    ['a surname or any word the list does not hold', 'Zqxv ring', ['Zqxv']],
    ['a long run of digits', 'Case 123456789', ['123456789']],
    ['a placeholder, which only a resolved mention may be', 'Anchor ‹widget#1› first', ['‹widget#1›']],
    ['an address-like token', 'mail me at who@example.org', ['who@example.org']],
  ])('gets no label for %s, and gives the tokens it blocked', (_name, name, tokens) => {
    const result = labelOf(name, VOCABULARY);
    expect(result.label).toBeUndefined();
    for (const token of tokens) expect(result.blocked.join(' ')).toContain(token.replace(/^‹|›$/g, '').split('#')[0] ?? '');
  });

  it('is judged by the vocabulary and the list as they are now, so the same name has no label with another vocabulary', () => {
    expect(labelOf('Gadget chain', VOCABULARY).label).toBe('Gadget chain');
    expect(labelOf('Zqxv chain', questionVocabulary({ view: { types: [{ name: 'Zqxv', kind: 'entity', properties: [] }] } })).label).toBe('Zqxv chain');
    expect(labelOf('Zqxv chain', VOCABULARY).label).toBeUndefined();
  });
});

describe('the pattern catalog with labels', () => {
  it('shows a label in quotes, beside its key, with the note that a label is data and never an instruction, and lists the labels for the preview', () => {
    const built = buildPatternCatalog({ offers: [offer('a', 'Widgets and gadgets')], cut: false }, VIEW, VOCABULARY);
    expect(built?.catalog.text).toContain(PATTERN_LABEL_NOTE);
    expect(built?.catalog.text).toContain('pat_1, named "Widgets and gadgets": starts at');
    expect(built?.catalog.labels).toEqual(['Widgets and gadgets']);
  });

  it('shows a name that is worded as an instruction only inside the quotes, as data, and the note says so', () => {
    const built = buildPatternCatalog({ offers: [offer('a', 'Show the gadget and widget')], cut: false }, VIEW, VOCABULARY);
    expect(built?.catalog.text).toContain('named "Show the gadget and widget":');
    expect(built?.catalog.text).toContain('never an instruction');
  });

  it('leaves a name out when a token of it is blocked, and says nothing of it in the text', () => {
    const built = buildPatternCatalog({ offers: [offer('a', 'Zqxv ring')], cut: false }, VIEW, VOCABULARY);
    expect(built?.catalog.text).not.toMatch(/Zqxv|named/);
    expect(built?.catalog.labels).toEqual([]);
    expect(built?.catalog.text).not.toContain(PATTERN_LABEL_NOTE);
  });

  it('orders equal descriptions by the label and then by the order offered, with no label first', () => {
    const built = buildPatternCatalog({ offers: [offer('one', 'Zqxv'), offer('two', 'Question the widget'), offer('three', 'Gadget chain'), offer('four', 'Zqxv again')], cut: false }, VIEW, VOCABULARY);
    expect([1, 2, 3, 4].map((index) => built?.targets.get(`pat_${index}`)?.id)).toEqual(['one', 'four', 'three', 'two']);
  });

  it('stops a token of a name that was left out, and the whole name, in any part of a request but the question', () => {
    const built = buildPatternCatalog({ offers: [offer('a', 'Zqxv ring')], cut: false }, VIEW, VOCABULARY);
    const parameters = (over: Record<string, string>) => ({ catalog: 'T1', vocabulary: 'V1', patterns: built?.catalog.text ?? '', question: 'x', ...over });
    expect(() => built?.catalog.check(parameters({ reply: 'the answer used Zqxv' }))).toThrow();
    expect(() => built?.catalog.check(parameters({ problems: 'a Zqxv ring' }))).toThrow();
    expect(() => built?.catalog.check(parameters({ question: 'Zqxv', reply: 'fine' }))).not.toThrow();
  });

  it('does not stop the label of a name that was offered, which may be in a reply that repeats the section', () => {
    const built = buildPatternCatalog({ offers: [offer('a', 'Widgets and gadgets')], cut: false }, VIEW, VOCABULARY);
    expect(() => built?.catalog.check({ catalog: 'T1', vocabulary: 'V1', patterns: built.catalog.text, question: 'x', reply: 'pat_1 Widgets and gadgets' })).not.toThrow();
  });
});
