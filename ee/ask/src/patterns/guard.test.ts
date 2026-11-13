import type { AiMappingView, AskPatternOffer, AskPatternProjection } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { PatternGuardError, createPatternGuard } from './guard.js';

const VIEW: AiMappingView = {
  types: [
    { name: 'widget', kind: 'entity', properties: [] },
    { name: 'gadget', kind: 'entity', properties: [] },
    { name: 'link_a', kind: 'relationship', properties: [] },
  ],
};
const projection = (over: Record<string, unknown> = {}): AskPatternProjection => ({
  kind: 'definition',
  anchorType: 'widget',
  startingEntity: 'asked',
  steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', kind: 'eq' }], windowed: false }],
  ...over,
}) as AskPatternProjection;
const offer = (over: Partial<AskPatternOffer> = {}): AskPatternOffer => ({ id: '0195a000-0000-7000-8000-000000000001', version: 2, name: 'SECRET-NAME', projection: projection(), ...over });
const failureOf = (run: () => void): PatternGuardError | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof PatternGuardError ? error : undefined;
  }
  return undefined;
};
const guarded = (...offers: AskPatternOffer[]) => offers.map((offer) => ({ offer, blocked: [] as string[], offered: false }));
const EXPECTED = 'pat_1: a structure\n\n';
const parameters = (over: Record<string, string> = {}) => ({ catalog: 'T1', vocabulary: 'V1', patterns: EXPECTED, question: 'who is ‹widget#1›?', ...over });

describe('the projections the guard lets through', () => {
  it('lets through types of the mapping, fixed words and numbers, for a definition and a preset run', () => {
    expect(failureOf(() => createPatternGuard(guarded(offer()), VIEW, EXPECTED))).toBeUndefined();
    const preset = projection({ kind: 'preset-run', steps: undefined, template: 'linked-entities', otherType: 'gadget', relationshipTypes: ['link_a'], direction: 'in', maxHops: 2, windowed: true });
    expect(failureOf(() => createPatternGuard(guarded(offer({ projection: preset })), VIEW, EXPECTED))).toBeUndefined();
  });

  it.each([
    ['a name placed in the anchor type', { anchorType: 'SECRET-NAME' }],
    ['a name placed in a relationship type', { steps: [{ relationshipTypes: ['SECRET-NAME'], direction: 'out', arrivesAt: 'gadget', conditions: [], windowed: false }] }],
    ['a name placed in the arrival type', { steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'SECRET-NAME', conditions: [], windowed: false }] }],
    ['a direction that is not one of the three', { steps: [{ relationshipTypes: ['link_a'], direction: 'SECRET-NAME', arrivesAt: 'gadget', conditions: [], windowed: false }] }],
    ['a condition kind that is not fixed', { steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', kind: 'SECRET-NAME' }], windowed: false }] }],
    ['a window that is not a flag', { steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'gadget', conditions: [], windowed: 'SECRET-NAME' }] }],
    ['a starting entity that is neither word', { startingEntity: 'SECRET-NAME' }],
  ])('stops %s, by the position of the pattern only', (_name, over) => {
    const failure = failureOf(() => createPatternGuard(guarded(offer(), offer({ projection: projection(over) })), VIEW, EXPECTED));
    expect(failure).toMatchObject({ kind: 'projection', position: 1 });
    expect(JSON.stringify([failure?.message, failure?.kind, failure?.position])).not.toContain('SECRET-NAME');
  });

  it('stops a type that is not in the mapping when the mapping is not known', () => {
    expect(failureOf(() => createPatternGuard(guarded(offer()), undefined, EXPECTED))).toMatchObject({ kind: 'projection' });
  });
});

describe('the request the guard checks', () => {
  const guard = createPatternGuard(guarded(offer(), offer({ id: '0195a000-0000-7000-8000-000000000002', name: 'high' })), VIEW, EXPECTED);

  it('lets through a request whose pattern section is the expected one and whose other parts hold no pattern text', () => {
    expect(failureOf(() => guard.check(parameters()))).toBeUndefined();
  });

  it('stops a pattern section that is not byte for byte the expected one, whatever it adds', () => {
    expect(failureOf(() => guard.check(parameters({ patterns: `${EXPECTED}SECRET-NAME` })))).toMatchObject({ kind: 'catalog' });
    expect(failureOf(() => guard.check(parameters({ patterns: '' })))).toMatchObject({ kind: 'catalog' });
  });

  it('stops a name or an id found as a whole word in any part but the question and the pattern section, and says only the position', () => {
    for (const [part, value] of [['reply', 'the earlier answer named SECRET-NAME here'], ['problems', 'params: 0195a000-0000-7000-8000-000000000001']] as const) {
      const failure = failureOf(() => guard.check(parameters({ [part]: value })));
      expect(failure, part).toMatchObject({ kind: 'text' });
      expect(JSON.stringify([failure?.message, failure?.position])).not.toMatch(/SECRET|0195a000/);
    }
  });

  it('does not stop a name that is a word of the question, and does not take part of a longer word for the name', () => {
    expect(failureOf(() => guard.check(parameters({ question: 'which SECRET-NAME is it?', reply: 'SECRET-NAMES are many' })))).toBeUndefined();
  });

  it('does not stop a name that is also a word of the catalog or the vocabulary, because it cannot be told from them', () => {
    expect(failureOf(() => guard.check(parameters({ catalog: 'T1 a high bound', problems: 'a high bound' })))).toBeUndefined();
    expect(failureOf(() => guard.check(parameters({ problems: 'a high bound' })))).toMatchObject({ kind: 'text', position: 1 });
  });

  it('stops a name, a blocked token or an identifier that is in the pattern section itself, even when that is the text it was told to expect', () => {
    const leaked = (text: string) => createPatternGuard([{ offer: offer(), blocked: ['Zqxv'], offered: false }], VIEW, text);
    for (const section of [`pat_1: ${'SECRET-NAME'} starts`, 'pat_1: named Zqxv', 'pat_1: 0195a000-0000-7000-8000-000000000001']) {
      expect(failureOf(() => leaked(section).check(parameters({ patterns: section }))), section).toMatchObject({ kind: 'text', position: 0 });
    }
  });

  it('does not take a fixed word of the pattern section for a leak, even when a name blocked as a token is that word', () => {
    const section = 'pat_1: starts at an entity of type widget that the question gives; step 1: out over link_a to gadget, no conditions';
    const guardWith = createPatternGuard([{ offer: offer({ name: 'starts' }), blocked: ['starts', 'step', 'entity'], offered: false }], VIEW, section);
    expect(failureOf(() => guardWith.check(parameters({ patterns: section })))).toBeUndefined();
  });
});
