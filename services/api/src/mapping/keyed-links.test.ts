import { describe, expect, it } from 'vitest';
import { entityLinkFor } from './model.js';
import { baseSource, expectRefused, firstSource, load } from '../testing/mapping.js';

const VALUE = 'a/b c?x=1&y#z';
const keyed = (extra: Record<string, unknown> = {}) => ({ type: 'node_c', label: 'NodeC', stable_id: 'id', pii: [{ property: 'id', class: 'text' }, { property: 'name', class: 'name' }], link: 'https://records.example.test/{id}', ...extra });
const entityOf = (raw: Record<string, unknown>) => {
  const entity = firstSource(load(baseSource({ entities: [raw], relationships: undefined }))).entities[0];
  if (entity === undefined) throw new Error('the fixture has an entity');
  return entity;
};

describe('the source link of a keyed entity type', () => {
  it('is refused without the opt-in, and the message says what the opt-in does', () => {
    expectRefused(baseSource({ entities: [keyed()], relationships: undefined }), 'sources[0].entities[0].link', 'set link_carries_value: true');
  });

  it('is accepted with the opt-in and built from the raw value, percent-encoded, only for an unmasked request', () => {
    const entity = entityOf(keyed({ link_carries_value: true }));
    expect(entity.link).toMatchObject({ placeholder: 'id', carriesValue: true });
    expect(entityLinkFor(entity, VALUE, false)).toBe(`https://records.example.test/${encodeURIComponent(VALUE)}`);
    expect(entityLinkFor(entity, VALUE, true)).toBeUndefined();
  });

  it('never builds a link for a masked request that holds any part of the value', () => {
    const entity = entityOf(keyed({ link_carries_value: true }));
    expect(entityLinkFor(entity, 'secret-value', true)).toBeUndefined();
  });

  it('still refuses a placeholder that is another personal-data property', () => {
    expectRefused(baseSource({ entities: [keyed({ link: 'https://records.example.test/{name}', link_carries_value: true })], relationships: undefined }), 'sources[0].entities[0].link', 'not the stable ID property');
  });

  it('refuses the opt-in on a type whose stable ID is not personal data, and on a type with no link', () => {
    expectRefused(baseSource({ entities: [{ type: 'node_c', label: 'NodeC', stable_id: 'id', link: 'https://records.example.test/{id}', link_carries_value: true }], relationships: undefined }), 'sources[0].entities[0].link_carries_value', 'not a personal-data property');
    expectRefused(baseSource({ entities: [keyed({ link: undefined, link_carries_value: true })], relationships: undefined }), 'sources[0].entities[0].link_carries_value', 'no link');
  });

  it('builds the link of a type that is not keyed whether masked or not', () => {
    const entity = entityOf({ type: 'node_c', label: 'NodeC', stable_id: 'id', link: 'https://records.example.test/{id}' });
    expect(entityLinkFor(entity, 'X-1', true)).toBe('https://records.example.test/X-1');
  });
});

describe('names in a mapping', () => {
  it('refuses an entity type with an unpaired surrogate, since two such names would share one encoding', () => {
    expectRefused(baseSource({ entities: [{ type: 'a\ud800', label: 'NodeC', stable_id: 'id' }], relationships: undefined }), 'sources[0].entities[0].type', 'well-formed');
  });
  it('refuses an entity type with a NUL', () => {
    expectRefused(baseSource({ entities: [{ type: 'a\u0000b', label: 'NodeC', stable_id: 'id' }], relationships: undefined }), 'sources[0].entities[0].type', 'no NUL');
  });
});
