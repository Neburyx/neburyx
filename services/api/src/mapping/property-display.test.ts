import { describe, expect, it } from 'vitest';
import { parseMapping } from './load.js';
import { baseSource, expectRefused, fileOf, firstSource, load, type Json } from '../testing/mapping.js';
import { buildSourceProfile } from '../registry/profile.js';

const entity = (extra: Json = {}): Json => ({ type: 'node_c', label: 'NodeC', stable_id: 'id', search: ['name'], filterable: ['score', 'note'], ...extra });
const relationship = (extra: Json = {}): Json => ({ type: 'LINKS', from: 'node_c', to: 'node_c', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['rec'], filterable: ['weight'], ...extra });
const sourceOf = (e: Json = {}, r: Json = {}): Json => baseSource({ entities: [entity(e)], relationships: [relationship(r)] });

describe('the label and unit a mapping gives a property', () => {
  it('holds them for an entity type and a relationship row, and no key when none is given', () => {
    const shown = firstSource(load(sourceOf({ property_display: { score: { label: 'size', unit: 'USD' }, name: { label: 'full name' } } }, { property_display: { weight: { unit: 'kg' } } })));
    expect(shown.entities[0]?.propertyDisplay).toEqual({ score: { label: 'size', unit: 'USD' }, name: { label: 'full name' } });
    expect(shown.relationships[0]?.propertyDisplay).toEqual({ weight: { unit: 'kg' } });
    const plain = firstSource(load(sourceOf()));
    expect('propertyDisplay' in (plain.entities[0] ?? {})).toBe(false);
    expect('propertyDisplay' in (plain.relationships[0] ?? {})).toBe(false);
  });

  it('keeps the configuration hash of a mapping that gives none, and changes it when one is given', () => {
    const plain = firstSource(load(sourceOf())).configHash;
    expect(firstSource(load(sourceOf({ property_display: {} }))).configHash).toBe(plain);
    expect(firstSource(load(sourceOf({ property_display: { score: { label: 'size' } } }))).configHash).not.toBe(plain);
  });

  it('is carried by the profile for the properties that have one', () => {
    const profile = buildSourceProfile(firstSource(load(sourceOf({ property_display: { score: { label: 'size', unit: 'USD' } } }, { property_display: { weight: { label: 'load' } } }))));
    expect(profile.entityTypes[0]?.propertyDisplay).toEqual({ score: { label: 'size', unit: 'USD' } });
    expect(profile.relationshipTypes[0]?.propertyDisplay).toEqual({ weight: { label: 'load' } });
    expect(buildSourceProfile(firstSource(load(sourceOf()))).entityTypes[0]?.propertyDisplay).toBeUndefined();
  });

  it('refuses a property the type does not name, and an entry that gives neither a label nor a unit', () => {
    expectRefused(sourceOf({ property_display: { other: { label: 'x' } } }), 'sources[0].entities[0].property_display.other', 'not a property of this type');
    expectRefused(sourceOf({}, { property_display: { other: { label: 'x' } } }), 'sources[0].relationships[0].property_display.other', 'not a property of this type');
    expectRefused(sourceOf({ property_display: { score: {} } }), 'sources[0].entities[0].property_display.score', 'neither a label nor a unit');
  });

  it('refuses a label over 80 characters, a unit over 20, an empty text, a key it does not know and a document that is not a map', () => {
    for (const hostile of [{ score: { label: 'x'.repeat(81) } }, { score: { unit: 'x'.repeat(21) } }, { score: { label: '' } }, { score: { label: '  ' } }, { score: { colour: 'red' } }, ['score'], 'score', 7, { '': { label: 'x' } }]) {
      expect(() => parseMapping(fileOf(sourceOf({ property_display: hostile })), 'neburyx.yaml')).toThrow();
    }
  });
});
