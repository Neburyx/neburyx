import type { AiMappingView, AskPatternOffer, AskPatternProjection } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildPatternCatalog } from './catalog.js';
import { PATTERN_CATALOG_CUT_SENTENCE, PATTERN_CATALOG_INTRO } from './catalog-text.js';

const VIEW: AiMappingView = {
  types: [
    ...['widget', 'gadget', 'tool'].map((name) => ({ name, kind: 'entity' as const, properties: [] })),
    ...['link_a', 'link_b', 'uses', 'links'].map((name) => ({ name, kind: 'relationship' as const, properties: [] })),
  ],
};
const projection = (over: Partial<Extract<AskPatternProjection, { kind: 'definition' }>> = {}): AskPatternProjection => ({
  kind: 'definition',
  anchorType: 'widget',
  startingEntity: 'asked',
  steps: [{ relationshipTypes: ['link_a', 'link_b'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', kind: 'eq' }, { on: 'relationship', kind: 'between' }], windowed: true }],
  ...over,
});
const offer = (id: string, over: Partial<AskPatternOffer> = {}): AskPatternOffer => ({ id, version: 3, name: 'SECRET-NAME', projection: projection(), ...over });

describe('the pattern catalog', () => {
  it('is absent when no pattern is offered', () => {
    expect(buildPatternCatalog({ offers: [], cut: false }, VIEW)).toBeUndefined();
  });

  it('describes a pattern by its structure under the key pat_1 and says how to name it, and holds nothing the projection does not', () => {
    const built = buildPatternCatalog({ offers: [offer('0195a000-0000-7000-8000-000000000001')], cut: false }, VIEW);
    expect(built?.catalog.text).toBe(`${PATTERN_CATALOG_INTRO}\npat_1: starts at an entity of type widget that the question gives; step 1: out over link_a or link_b to gadget, 2 conditions (neighbor eq, relationship between), with a time window\n\n`);
    expect(built?.catalog.entries.get('pat_1')).toEqual({ anchorType: 'widget', startingEntity: 'asked' });
    expect(built?.targets.get('pat_1')).toEqual({ id: '0195a000-0000-7000-8000-000000000001', version: 3 });
    expect(JSON.stringify([...(built?.catalog.entries ?? [])])).not.toContain('0195a000');
    expect(built?.catalog.text).not.toMatch(/SECRET-NAME|0195a000/);
  });

  it('says a held starting entity is held, with its type, and asks for no placeholder for it', () => {
    const built = buildPatternCatalog({ offers: [offer('a', { projection: projection({ startingEntity: 'held' }) })], cut: false }, VIEW);
    expect(built?.catalog.text).toContain('pat_1: starts at a held entity of type widget;');
    expect(built?.catalog.entries.get('pat_1')?.startingEntity).toBe('held');
  });

  it('gives keys in the order of the descriptions and then of the offers, whatever the ids, names and versions, so a key says nothing of them', () => {
    const first = buildPatternCatalog({ offers: [offer('zzz', { name: 'Zqxv-bee', version: 9, projection: projection({ anchorType: 'gadget' }) }), offer('aaa', { name: 'Zqxv-ay', projection: projection() })], cut: false }, VIEW);
    const second = buildPatternCatalog({ offers: [offer('aaa', { name: 'Zqxv-zed', version: 1, projection: projection() }), offer('zzz', { name: 'Zqxv-why', projection: projection({ anchorType: 'gadget' }) })], cut: false }, VIEW);
    expect(first?.catalog.text).toBe(second?.catalog.text);
    expect(first?.targets.get('pat_1')?.id).toBe('zzz');
    expect(second?.targets.get('pat_1')?.id).toBe('zzz');
    const same = buildPatternCatalog({ offers: [offer('one'), offer('two')], cut: false }, VIEW);
    expect([same?.targets.get('pat_1')?.id, same?.targets.get('pat_2')?.id]).toEqual(['one', 'two']);
  });

  it('says in a fixed sentence that more patterns exist when the listing is cut, and sets the flag', () => {
    const cut = buildPatternCatalog({ offers: [offer('a')], cut: true }, VIEW);
    expect(cut?.catalog.cut).toBe(true);
    expect(cut?.catalog.text).toContain(`\n${PATTERN_CATALOG_CUT_SENTENCE}\n\n`);
    expect(buildPatternCatalog({ offers: [offer('a')], cut: false }, VIEW)?.catalog.text).not.toContain(PATTERN_CATALOG_CUT_SENTENCE);
  });

  it('describes a pattern with no condition and no window plainly', () => {
    const built = buildPatternCatalog({ offers: [offer('a', { projection: projection({ steps: [{ relationshipTypes: ['link_a'], direction: 'both', arrivesAt: 'gadget', conditions: [], windowed: false }] }) })], cut: false }, VIEW);
    expect(built?.catalog.text).toContain('step 1: both over link_a to gadget, no conditions\n');
  });

  it('describes a saved run of a preset by its template, types and numbers, for each of the two templates', () => {
    const shared = buildPatternCatalog({ offers: [offer('a', { projection: { kind: 'preset-run', template: 'shared-attribute', anchorType: 'widget', startingEntity: 'asked', otherType: 'tool', relationshipTypes: ['uses'], minShared: 3, windowed: true } })], cut: false }, VIEW);
    expect(shared?.catalog.text).toContain('pat_1: starts at an entity of type widget that the question gives; finds entities that share a tool through uses, at least 3 shared, with a time window\n');
    const linked = buildPatternCatalog({ offers: [offer('b', { projection: { kind: 'preset-run', template: 'linked-entities', anchorType: 'widget', startingEntity: 'held', otherType: 'widget', relationshipTypes: ['links'], direction: 'in', maxHops: 2, windowed: false } })], cut: false }, VIEW);
    expect(linked?.catalog.text).toContain('pat_1: starts at a held entity of type widget; follows in links to widget, up to 2 steps\n');
    const bare = buildPatternCatalog({ offers: [offer('c', { projection: { kind: 'preset-run', template: 'linked-entities', anchorType: 'widget', startingEntity: 'asked', otherType: 'gadget', relationshipTypes: ['links'], windowed: false } })], cut: false }, VIEW);
    expect(bare?.catalog.text).toContain('follows links to gadget, up to 1 steps\n');
  });
});
