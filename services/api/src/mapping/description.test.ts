import { describe, expect, it } from 'vitest';
import { buildSourceProfile, typeDescriptionsOf } from '../registry/profile.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { parseMapping } from './load.js';

const entities = (description?: unknown) => [
  { type: 'node_a', label: 'NodeA', stable_id: 'id', ...(description === undefined ? {} : { description }) },
  { type: 'node_b', label: 'NodeB', stable_id: 'key' },
];
const relationships = (description?: unknown) => [{ type: 'LINKS', from: 'node_a', to: 'node_b', ...(description === undefined ? {} : { description }) }];
const load = (entity?: unknown, relationship?: unknown) => parseMapping(fileOf(baseSource({ entities: entities(entity), relationships: relationships(relationship) })), 'neburyx.yaml');
const profileOf = (model: ReturnType<typeof load>) => {
  const source = model.sources[0];
  if (source === undefined) throw new Error('no source');
  return buildSourceProfile(source);
};
const refusal = (entity?: unknown, relationship?: unknown): string => {
  try {
    load(entity, relationship);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'loaded';
};

describe('the description of a type', () => {
  it('is carried to the profile for an entity type and a relationship type', () => {
    const profile = profileOf(load('A thing that holds items.', 'Joins a thing to another.'));
    expect(profile.entityTypes.map((type) => type.description)).toEqual(['A thing that holds items.', undefined]);
    expect(profile.relationshipTypes.map((type) => type.description)).toEqual(['Joins a thing to another.']);
  });

  it('is absent from the profile and the model when the mapping gives none', () => {
    const model = load();
    expect(model.sources.flatMap((source) => [...source.entities, ...source.relationships]).some((type) => 'description' in type)).toBe(false);
    const profile = profileOf(model);
    expect([...profile.entityTypes, ...profile.relationshipTypes].some((type) => 'description' in type)).toBe(false);
  });

  it('accepts 300 characters and refuses 301', () => {
    expect(refusal('a'.repeat(300))).toBe('loaded');
    expect(refusal('a'.repeat(301), undefined)).not.toBe('loaded');
    expect(refusal(undefined, 'a'.repeat(301))).not.toBe('loaded');
  });

  it.each([
    ['empty', ''],
    ['a control character', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['not text', 5],
    ['a list', ['x']],
  ])('refuses %s', (_name, value) => {
    expect(refusal(value)).not.toBe('loaded');
    expect(refusal(undefined, value)).not.toBe('loaded');
  });

  it('is listed for the assistant for every type, with the description of the ones that have one and the display name, and for no unknown source', () => {
    const model = load('A thing that holds items.', 'Joins a thing to another.');
    expect(typeDescriptionsOf(model.sources[0])).toEqual({
      entityTypes: [{ type: 'node_a', label: 'NodeA', displayName: 'NodeA', description: 'A thing that holds items.' }, { type: 'node_b', label: 'NodeB', displayName: 'NodeB' }],
      relationshipTypes: [{ type: 'LINKS', description: 'Joins a thing to another.' }],
    });
    expect(typeDescriptionsOf(undefined)).toEqual({ entityTypes: [], relationshipTypes: [] });
    expect(typeDescriptionsOf(load().sources[0])).toEqual({ entityTypes: [{ type: 'node_a', label: 'NodeA', displayName: 'NodeA' }, { type: 'node_b', label: 'NodeB', displayName: 'NodeB' }], relationshipTypes: [{ type: 'LINKS' }] });
  });
});
