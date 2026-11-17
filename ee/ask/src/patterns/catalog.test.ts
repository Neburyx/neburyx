import { PATTERN_LIMITS, type AskPatternOffer, type AskPatternProjection } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildPatternCatalog } from './catalog.js';
import { PATTERN_CATALOG_CUT_SENTENCE } from './catalog-text.js';

const projection = (over: Partial<Extract<AskPatternProjection, { kind: 'definition' }>> = {}): AskPatternProjection => ({
  kind: 'definition',
  anchorType: 'widget',
  startingEntity: 'asked',
  steps: [{ relationshipTypes: ['link_a', 'link_b'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', kind: 'eq' }, { on: 'relationship', kind: 'between' }], windowed: true }],
  ...over,
});
const offer = (id: string, over: Partial<AskPatternOffer> = {}): AskPatternOffer => ({ id, version: 3, name: 'SECRET-NAME', projection: projection(), ...over });

describe('the pattern catalog', () => {
  it('is bounded by what feeds it: 30 offers of the largest structure the limits allow and names of the longest length stay under 66,000 characters', () => {
    const step = { relationshipTypes: Array.from({ length: PATTERN_LIMITS.relationshipTypesPerStep }, (_, index) => `${index}`.padEnd(40, 'r')), direction: 'both' as const, arrivesAt: 'g'.repeat(60), conditions: Array.from({ length: PATTERN_LIMITS.conditionsPerElement }, () => ({ on: 'neighbor' as const, kind: 'between' as const })), windowed: true };
    const offers = Array.from({ length: 30 }, (_, index) => offer(`id-${index}`, { name: `${index}`.padEnd(PATTERN_LIMITS.nameLength, 'n'), projection: projection({ anchorType: 'a'.repeat(60), steps: Array.from({ length: PATTERN_LIMITS.steps }, () => step) }) }));
    const text = buildPatternCatalog({ offers, cut: true })?.catalog.text ?? '';
    expect(text.length).toBeGreaterThan(60_000);
    expect(text.length).toBeLessThan(66_000);
  });

  it('stays bounded when every step also carries the three structural fields: the largest catalog is under 80,000 characters (the 66,000 of a pattern without them is unchanged)', () => {
    const step = { relationshipTypes: Array.from({ length: PATTERN_LIMITS.relationshipTypesPerStep }, (_, index) => `${index}`.padEnd(40, 'r')), direction: 'both' as const, arrivesAt: 'g'.repeat(60), conditions: Array.from({ length: PATTERN_LIMITS.conditionsPerElement }, () => ({ on: 'neighbor' as const, kind: 'between' as const })), windowed: true, orderedAfterPrevious: true as const, fanAtLeast: 9_999_999, closesAtAnchor: true as const };
    const offers = Array.from({ length: 30 }, (_, index) => offer(`id-${index}`, { name: `${index}`.padEnd(PATTERN_LIMITS.nameLength, 'n'), projection: projection({ anchorType: 'a'.repeat(60), steps: Array.from({ length: PATTERN_LIMITS.steps }, () => step) }) }));
    const text = buildPatternCatalog({ offers, cut: true })?.catalog.text ?? '';
    expect(text).toContain('after the previous step in time');
    expect(text).toContain('from an entity with at least 9999999 neighbours');
    expect(text).toContain('arriving back at the starting entity');
    expect(text.length).toBeGreaterThan(66_000);
    expect(text.length).toBeLessThan(80_000);
  });

  it('describes a step by its three structural fields in fixed words, and a step without them as before', () => {
    const built = buildPatternCatalog({ offers: [offer('a', { projection: projection({ steps: [{ relationshipTypes: ['link'], direction: 'out', arrivesAt: 'widget', conditions: [], windowed: false, fanAtLeast: 3 }, { relationshipTypes: ['link'], direction: 'out', arrivesAt: 'widget', conditions: [], windowed: false, orderedAfterPrevious: true, closesAtAnchor: true }] }) })], cut: false });
    expect(built?.catalog.text).toContain('step 1: out over link to widget, no conditions, from an entity with at least 3 neighbours; step 2: out over link to widget, no conditions, after the previous step in time, arriving back at the starting entity');
  });

  it('says the delay of an ordered step as a length and a unit, and two patterns that differ only by it are described differently', () => {
    const step = { relationshipTypes: ['link'], direction: 'out' as const, arrivesAt: 'widget', conditions: [], windowed: false };
    const described = (within?: { unit: 'minutes' | 'hours' | 'days'; amount: number }) => buildPatternCatalog({ offers: [offer('a', { projection: projection({ steps: [step, { ...step, orderedAfterPrevious: true, ...(within === undefined ? {} : { within }) }] }) })], cut: false })?.catalog.text;
    expect(described({ unit: 'hours', amount: 24 })).toContain('after the previous step in time, no later than 24 hours after it');
    expect(described({ unit: 'minutes', amount: 90 })).toContain('no later than 90 minutes after it');
    expect(described({ unit: 'hours', amount: 24 })).not.toBe(described({ unit: 'days', amount: 1 }));
    expect(described()).not.toContain('no later than');
  });

  it('is absent when no pattern is offered', () => {
    expect(buildPatternCatalog({ offers: [], cut: false })).toBeUndefined();
  });

  it('describes a pattern by its structure under the key pat_1 with the name of the pattern as its label, and holds nothing else of the pattern', () => {
    const built = buildPatternCatalog({ offers: [offer('0195a000-0000-7000-8000-000000000001')], cut: false });
    expect(built?.catalog.text).toBe(`pat_1, named "SECRET-NAME": starts at an entity of type widget that the question gives; step 1: out over link_a or link_b to gadget, 2 conditions (neighbor eq, relationship between), with a time window\n\n`);
    expect(built?.catalog.entries.get('pat_1')).toEqual({ anchorType: 'widget', startingEntity: 'asked' });
    expect(built?.targets.get('pat_1')).toEqual({ id: '0195a000-0000-7000-8000-000000000001', version: 3 });
    expect(JSON.stringify([...(built?.catalog.entries ?? [])])).not.toContain('0195a000');
    expect(built?.catalog.text).not.toMatch(/0195a000/);
  });

  it('says a held starting entity is held, with its type, and asks for no placeholder for it', () => {
    const built = buildPatternCatalog({ offers: [offer('a', { projection: projection({ startingEntity: 'held' }) })], cut: false });
    expect(built?.catalog.text).toContain('pat_1, named "SECRET-NAME": starts at a held entity of type widget;');
    expect(built?.catalog.entries.get('pat_1')?.startingEntity).toBe('held');
  });

  it('gives keys in the order of the descriptions and then of the names and offers, whatever the ids and versions', () => {
    const first = buildPatternCatalog({ offers: [offer('zzz', { name: 'Zqxv-bee', version: 9, projection: projection({ anchorType: 'gadget' }) }), offer('aaa', { name: 'Zqxv-ay', projection: projection() })], cut: false });
    const second = buildPatternCatalog({ offers: [offer('aaa', { name: 'Zqxv-zed', version: 1, projection: projection() }), offer('zzz', { name: 'Zqxv-why', projection: projection({ anchorType: 'gadget' }) })], cut: false });
    expect(first?.targets.get('pat_1')?.id).toBe('zzz');
    expect(second?.targets.get('pat_1')?.id).toBe('zzz');
    const same = buildPatternCatalog({ offers: [offer('one'), offer('two')], cut: false });
    expect([same?.targets.get('pat_1')?.id, same?.targets.get('pat_2')?.id]).toEqual(['one', 'two']);
  });

  it('says in a fixed sentence that more patterns exist when the listing is cut, and sets the flag', () => {
    const cut = buildPatternCatalog({ offers: [offer('a')], cut: true });
    expect(cut?.catalog.cut).toBe(true);
    expect(cut?.catalog.text).toContain(`\n${PATTERN_CATALOG_CUT_SENTENCE}\n\n`);
    expect(buildPatternCatalog({ offers: [offer('a')], cut: false })?.catalog.text).not.toContain(PATTERN_CATALOG_CUT_SENTENCE);
  });

  it('describes a pattern with no condition and no window plainly', () => {
    const built = buildPatternCatalog({ offers: [offer('a', { projection: projection({ steps: [{ relationshipTypes: ['link_a'], direction: 'both', arrivesAt: 'gadget', conditions: [], windowed: false }] }) })], cut: false });
    expect(built?.catalog.text).toContain('step 1: both over link_a to gadget, no conditions\n');
  });

  it('describes a saved run of a preset by its template, types and numbers, for each of the two templates', () => {
    const shared = buildPatternCatalog({ offers: [offer('a', { projection: { kind: 'preset-run', template: 'shared-attribute', anchorType: 'widget', startingEntity: 'asked', otherType: 'tool', relationshipTypes: ['uses'], minShared: 3, windowed: true } })], cut: false });
    expect(shared?.catalog.text).toContain('pat_1, named "SECRET-NAME": starts at an entity of type widget that the question gives; finds entities that share a tool through uses, at least 3 shared, with a time window\n');
    const linked = buildPatternCatalog({ offers: [offer('b', { projection: { kind: 'preset-run', template: 'linked-entities', anchorType: 'widget', startingEntity: 'held', otherType: 'widget', relationshipTypes: ['links'], direction: 'in', maxHops: 2, windowed: false } })], cut: false });
    expect(linked?.catalog.text).toContain('pat_1, named "SECRET-NAME": starts at a held entity of type widget; follows in links to widget, up to 2 steps\n');
    const bare = buildPatternCatalog({ offers: [offer('c', { projection: { kind: 'preset-run', template: 'linked-entities', anchorType: 'widget', startingEntity: 'asked', otherType: 'gadget', relationshipTypes: ['links'], windowed: false } })], cut: false });
    expect(bare?.catalog.text).toContain('follows links to gadget, up to 1 steps\n');
  });
});
