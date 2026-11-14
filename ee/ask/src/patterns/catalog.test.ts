import type { AskPatternOffer, AskPatternProjection } from '@neburyx/contracts';
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
