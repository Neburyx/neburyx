import { ICON_KEYS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { parseMapping } from './load.js';
import { MAX_REFERENCE_PROPERTIES, MAX_SEARCH_PROPERTIES } from './model.js';
import { baseSource, expectRefused, fileOf, firstSource, issuesOf, load, type Json } from '../testing/mapping.js';

const fullEntity = {
  type: 'node_c',
  label: 'NodeC',
  stable_id: 'id',
  title: 'Item {name}',
  search: ['name', 'code'],
  reference: ['ref'],
  pii: ['name'],
  filterable: ['status'],
  display: { icon: 'document', key_properties: ['status', 'size'], state_property: 'status' },
};

describe('entity and relationship types as written', () => {
  it('holds every key of a full entity and relationship', () => {
    const source = firstSource(
      load(
        baseSource({
          entities: [fullEntity, { type: 'node_d', label: 'NodeD', stable_id: 'key' }],
          relationships: [
            {
              type: 'EVENT',
              from: 'node_c',
              to: 'node_d',
              stable_id: 'entryId',
              observed_at: 'seenAt',
              evidence: ['recordId'],
              filterable: ['kind'],
            },
          ],
        }),
      ),
    );
    expect(source.entities[0]).toMatchObject({
      title: 'Item {name}',
      titleProperties: ['name'],
      titleUsesPii: true,
      search: ['name', 'code'],
      reference: ['ref'],
      pii: ['name'],
      filterable: ['status'],
      display: { icon: 'document', keyProperties: ['status', 'size'], stateProperty: 'status' },
    });
    expect(source.relationships[0]).toMatchObject({
      type: 'EVENT',
      from: 'node_c',
      to: 'node_d',
      stableId: 'entryId',
      aggregate: false,
      observedAt: 'seenAt',
      evidence: ['recordId'],
      filterable: ['kind'],
    });
  });

  it('defaults the title, icon and key properties of an entity that omits them', () => {
    const entity = {
      type: 'node_c',
      label: 'NodeC',
      stable_id: 'id',
      search: ['name', 'code'],
      filterable: ['status'],
      pii: ['name'],
    };
    const [loaded] = firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities;
    expect(loaded).toMatchObject({ title: '{id}', display: { icon: 'generic', keyProperties: ['id', 'code', 'status'] } });
  });

  it('keeps a display name beside the label: the name is what is shown, the label stays the one the nodes of the source carry', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', display: { name: 'Node C' } };
    const [loaded] = firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities;
    expect(loaded).toMatchObject({ label: 'NodeC', display: { name: 'Node C' } });
  });

  it('leaves the display name unset when the mapping gives none, and when it gives no display at all', () => {
    const [bare, withDisplay] = firstSource(load(baseSource({ entities: [{ type: 'a', label: 'A', stable_id: 'id' }, { type: 'b', label: 'B', stable_id: 'id', display: { icon: 'document' } }], relationships: undefined }))).entities;
    expect(bare?.display.name).toBeUndefined();
    expect(withDisplay?.display.name).toBeUndefined();
  });

  it('refuses an empty display name, as it refuses an empty label', () => {
    expectRefused(baseSource({ entities: [{ type: 'a', label: 'A', stable_id: 'id', display: { name: '' } }] }), 'sources[0].entities[0].display.name', 'must not be empty');
    expectRefused(baseSource({ entities: [{ type: 'a', label: '', stable_id: 'id' }] }), 'sources[0].entities[0].label', 'must not be empty');
  });

  it('caps the default key properties at three', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', search: ['a', 'b', 'c', 'd'] };
    const [loaded] = firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities;
    expect(loaded?.display.keyProperties).toEqual(['id', 'a', 'b']);
  });

  it('records a relationship without a stable ID as an aggregate type', () => {
    const [relationship] = firstSource(load(baseSource())).relationships;
    expect(relationship).toMatchObject({ aggregate: true, evidence: [], filterable: [] });
    expect(relationship?.stableId).toBeUndefined();
  });

  it('refuses a search property that an entity type lists twice', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', search: ['name', 'code', 'name'] };
    expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].search[2]', 'lists name more than once');
  });

  it('refuses a source with more search properties than a search can read, and accepts one at the limit', () => {
    const names = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `p${from + index}`);
    const entities = (count: number) => [{ type: 'node_a', label: 'NodeA', stable_id: 'id', search: names(50) }, { type: 'node_b', label: 'NodeB', stable_id: 'id', search: names(count - 50) }];
    expect(() => load(baseSource({ entities: entities(MAX_SEARCH_PROPERTIES), relationships: undefined }))).not.toThrow();
    expectRefused(baseSource({ entities: entities(MAX_SEARCH_PROPERTIES + 1), relationships: undefined }), 'sources[0].entities', 'more than the 100 a search can read');
  });

  it('refuses a reference property that an entity type lists twice', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', reference: ['ref', 'other', 'ref'] };
    expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].reference[2]', 'lists ref more than once');
  });

  it('refuses a source with more reference properties than a related lookup can read, and accepts one at the limit', () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `r${index}`);
    const entities = (count: number) => [{ type: 'node_a', label: 'NodeA', stable_id: 'id', reference: names(50) }, { type: 'node_b', label: 'NodeB', stable_id: 'id', reference: names(count - 50) }];
    expect(() => load(baseSource({ entities: entities(MAX_REFERENCE_PROPERTIES), relationships: undefined }))).not.toThrow();
    expectRefused(baseSource({ entities: entities(MAX_REFERENCE_PROPERTIES + 1), relationships: undefined }), 'sources[0].entities', 'more than the 100 a search can read');
  });

  it('allows a pii property to be searchable', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', search: ['name'], pii: ['name'] };
    expect(() => load(baseSource({ entities: [entity], relationships: undefined }))).not.toThrow();
  });

  it('marks an entity whose default title is not built from a pii property', () => {
    const [loaded] = firstSource(load(baseSource())).entities;
    expect(loaded?.titleUsesPii).toBe(false);
  });
});

describe('property names', () => {
  it.each(['external-id', 'full name', 'Größe', '名前'])('accepts the property name %s as a stable ID, in a title and in a link', (property) => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: property, title: `Item {${property}}`, link: `https://records.example.test/items/{${property}}` };
    const [loaded] = firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities;
    expect(loaded).toMatchObject({ titleProperties: [property], link: { placeholder: property } });
  });

  it('builds the default title of a hyphenated stable ID', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'external-id' };
    expect(firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities[0]).toMatchObject({ title: '{external-id}', titleProperties: ['external-id'] });
  });
});

describe('braces in property names', () => {
  it.each([
    ['stable_id', { stable_id: 'a{b' }],
    ['search', { stable_id: 'id', search: ['a}b'] }],
    ['filterable', { stable_id: 'id', filterable: ['{x}'] }],
    ['pii', { stable_id: 'id', pii: ['a{'] }],
    ['reference', { stable_id: 'id', reference: ['}'] }],
    ['display.key_properties', { stable_id: 'id', display: { key_properties: ['a{b'] } }],
    ['display.state_property', { stable_id: 'id', display: { state_property: 'a}b' } }],
  ])('refuses a brace in %s', (_name, extra: Json) => {
    const issues = issuesOf(fileOf(baseSource({ entities: [{ type: 'node_c', label: 'NodeC', ...extra }], relationships: undefined })));
    expect(issues.some((issue) => issue.path.startsWith('sources[0].entities[0]') && issue.reason === 'has an invalid format')).toBe(true);
  });

  it('refuses a brace in the stop-list property of a derived rule', () => {
    const rule = { id: 'r', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1, stop_list_property: 'a{b' };
    expectRefused(baseSource({ derived: [rule] }), 'sources[0].derived[0].stop_list_property', 'invalid format');
  });

  it.each([
    ['stable_id', { stable_id: 'a{b' }, 'sources[0].relationships[0].stable_id'],
    ['filterable', { filterable: ['a}b'] }, 'sources[0].relationships[0].filterable[0]'],
  ])('refuses a brace in the %s of a relationship', (_name, extra: Json, path) => {
    expectRefused(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', ...extra }] }), path, 'invalid format');
  });

  it('refuses a brace in relationship and derived-rule property names', () => {
    expectRefused(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', evidence: ['a{b'] }] }), 'sources[0].relationships[0].evidence[0]', 'invalid format');
    expectRefused(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', observed_at: 'a}' }] }), 'sources[0].relationships[0].observed_at', 'invalid format');
  });
});

describe('icons', () => {
  it.each(ICON_KEYS)('accepts the icon key %s', (icon) => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', display: { icon } };
    expect(firstSource(load(baseSource({ entities: [entity], relationships: undefined }))).entities[0]?.display.icon).toBe(icon);
  });

  it.each([
    [40, '"' + 'k'.repeat(40) + '"'],
    [41, '"' + 'k'.repeat(40) + '…"'],
  ])('quotes an unknown icon of %i characters, cutting it at 40', (length, quoted) => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', display: { icon: 'k'.repeat(length) } };
    const issue = expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].display.icon', 'must be one of');
    expect(issue.reason).toContain(`(got ${quoted})`);
  });

  it('names the entity path and refuses an icon outside the fixed set', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', display: { icon: 'sparkle' } };
    const issue = expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].display.icon', 'must be one of', 'source demo, entity node_c');
    expect(issue.reason).toContain('(got "sparkle")');
  });
});

describe('duplicates and references', () => {
  const entities = [
    { type: 'node_a', label: 'NodeA', stable_id: 'id' },
    { type: 'node_a', label: 'NodeAgain', stable_id: 'id' },
  ];

  it('refuses an entity type that appears twice in one source', () => {
    expectRefused(baseSource({ entities, relationships: undefined }), 'sources[0].entities[1].type', 'repeats entity type node_a');
  });

  it('does not mistake different relationships for duplicates when their names join to the same text', () => {
    const named = [
      { type: 'node_a', label: 'A', stable_id: 'id' },
      { type: 'b', label: 'B', stable_id: 'id' },
      { type: 'a from b', label: 'C', stable_id: 'id' },
      { type: 'c', label: 'D', stable_id: 'id' },
    ];
    const relationships = [
      { type: 'X', from: 'a from b', to: 'c' },
      { type: 'X from node_a', from: 'b', to: 'c' },
    ];
    expect(firstSource(load(baseSource({ entities: named, relationships }))).relationships).toHaveLength(2);
  });

  it('refuses a relationship that repeats its type and endpoints', () => {
    const relationships = [
      { type: 'LINKS', from: 'node_a', to: 'node_b' },
      { type: 'LINKS', from: 'node_a', to: 'node_b' },
    ];
    expectRefused(baseSource({ relationships }), 'sources[0].relationships[1].type', 'repeats relationship');
  });

  it('accepts one relationship type between different endpoints', () => {
    const relationships = [
      { type: 'LINKS', from: 'node_a', to: 'node_b' },
      { type: 'LINKS', from: 'node_b', to: 'node_a' },
    ];
    expect(firstSource(load(baseSource({ relationships }))).relationships).toHaveLength(2);
  });

  it('accepts the same entity type and relationship type in two sources', () => {
    const text = fileOf(baseSource({ id: 'one' }), baseSource({ id: 'two' }));
    expect(parseMapping(text, 'neburyx.yaml').sources).toHaveLength(2);
  });

  it('refuses a relationship endpoint that its own source does not map', () => {
    expectRefused(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'missing' }] }), 'sources[0].relationships[0].to', 'names missing', 'source demo, relationship LINKS');
  });

  it('refuses an endpoint that only another source maps', () => {
    const other = baseSource({ id: 'other', entities: [{ type: 'only_here', label: 'Only', stable_id: 'id' }], relationships: undefined });
    const first = baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'only_here' }] });
    const issues = issuesOf(fileOf(first, other));
    expect(issues.some((issue) => issue.path === 'sources[0].relationships[0].to')).toBe(true);
  });
});

describe('pii and projection rules', () => {
  it('refuses a stable ID that is also pii, naming the entity and property', () => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', pii: ['id'] };
    expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].pii', 'lists id, which is the stable ID of node_c', 'source demo, entity node_c');
  });

  it.each([
    ['an empty placeholder', 'Item {}'],
    ['an unbalanced placeholder', 'Item {name'],
    ['a stray brace', 'Item name}'],
    ['a nested placeholder', 'Item {{name}}'],
  ])('refuses a title with %s', (_name, title) => {
    const entity = { type: 'node_c', label: 'NodeC', stable_id: 'id', title };
    expectRefused(baseSource({ entities: [entity], relationships: undefined }), 'sources[0].entities[0].title', 'placeholder');
  });

  it.each([
    ['observed_at', { observed_at: 4 }, 'sources[0].relationships[0].observed_at', 'must be string'],
    ['evidence entries', { evidence: [4] }, 'sources[0].relationships[0].evidence[0]', 'must be string'],
    ['an empty evidence entry', { evidence: [''] }, 'sources[0].relationships[0].evidence[0]', 'must not be empty'],
  ])('refuses %s of the wrong shape', (_name, extra: Json, path, reason) => {
    expectRefused(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', ...extra }] }), path, reason);
  });
});

describe('pii entries with a class', () => {
  const entity = (pii: unknown[]) => ({ type: 'node_c', label: 'NodeC', stable_id: 'id', pii });
  const loaded = (pii: unknown[]) => firstSource(load(baseSource({ entities: [entity(pii)], relationships: undefined }))).entities[0];

  it('loads the object form beside the bare form: pii lists the names, and only the classed ones have a class', () => {
    const found = loaded(['plain', { property: 'phone', class: 'phone' }, { property: 'holder', class: 'name' }, { property: 'born', class: 'date' }, { property: 'note', class: 'text' }, { property: 'mail', class: 'email' }]);
    expect(found?.pii).toEqual(['plain', 'phone', 'holder', 'born', 'note', 'mail']);
    expect(found?.piiClasses).toEqual({ phone: 'phone', holder: 'name', born: 'date', note: 'text', mail: 'email' });
  });

  it('has no classes at all for a mapping that writes bare names only, so that such a mapping keeps its hash', () => {
    const found = loaded(['plain', 'other']);
    expect(found?.pii).toEqual(['plain', 'other']);
    expect(found && 'piiClasses' in found).toBe(false);
  });

  it.each([
    ['a class outside the five', { property: 'x', class: 'region' }, 'sources[0].entities[0].pii[0]', 'has a class that is not name, email, phone, date, text'],
    ['a key that is neither property nor class', { property: 'x', class: 'name', note: 'y' }, 'sources[0].entities[0].pii[0]', 'has the key note, which is not property or class'],
    ['an entry without a property', { class: 'name' }, 'sources[0].entities[0].pii[0]', 'has no property name'],
    ['a property with a brace', { property: 'a{', class: 'name' }, 'sources[0].entities[0].pii[0]', 'has no property name'],
    ['an entry that is a number', 4, 'sources[0].entities[0].pii[0]', 'must be a property name or { property, class }'],
    ['an entry that is a list', ['x'], 'sources[0].entities[0].pii[0]', 'must be a property name or { property, class }'],
    ['a class that is not text', { property: 'x', class: 4 }, 'sources[0].entities[0].pii[0]', 'has a class that is not'],
  ])('refuses %s, naming the place', (_name, entry, path, reason) => {
    expectRefused(baseSource({ entities: [entity([entry])], relationships: undefined }), path, reason);
  });

  it.each([
    ['a bare name twice', ['x', 'x'], 1],
    ['a bare name and a classed one', ['x', { property: 'x', class: 'name' }], 1],
    ['a property classed twice', [{ property: 'x', class: 'name' }, { property: 'x', class: 'email' }], 1],
  ])('refuses %s, naming the second entry', (_name, pii, index) => {
    expectRefused(baseSource({ entities: [entity(pii)], relationships: undefined }), `sources[0].entities[0].pii[${index}]`, 'lists x more than once');
  });

  it('still refuses a stable ID that is pii when it is written with a class, and a link placeholder that is pii', () => {
    expectRefused(baseSource({ entities: [{ ...entity([{ property: 'id', class: 'name' }]) }], relationships: undefined }), 'sources[0].entities[0].pii', 'lists id, which is the stable ID of node_c');
    const linked = { type: 'node_c', label: 'NodeC', stable_id: 'id', pii: [{ property: 'id', class: 'text' }], link: 'https://records.example.test/{id}' };
    expectRefused(baseSource({ entities: [linked], relationships: undefined }), 'sources[0].entities[0].link', 'which is marked pii');
  });
});
