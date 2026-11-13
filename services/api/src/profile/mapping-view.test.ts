import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { baseSource } from '../testing/mapping.js';
import { aiMappingViewOf } from './mapping-view.js';

const viewOf = (...sources: Record<string, unknown>[]) => aiMappingViewOf(parseMapping(stringify({ sources }), 'neburyx.yaml'));
const typeOf = (view: ReturnType<typeof viewOf>, name: string, kind: 'entity' | 'relationship') => view.types.find((type) => type.name === name && type.kind === kind);
const namesOf = (type: ReturnType<typeof typeOf>) => type?.properties.map((property) => property.name).sort();

const FIRST = baseSource({
  id: 'first',
  entities: [
    { type: 'person', label: 'Person', stable_id: 'id', search: ['name'], pii: [{ property: 'ssn', class: 'text' }], filterable: ['status'], sortable: ['rank'], display: { key_properties: ['locale'], state_property: 'state' } },
    { type: 'company', label: 'Company', stable_id: 'id' },
    { type: 'link', label: 'Link', stable_id: 'id' },
  ],
  relationships: [
    { type: 'KNOWS', from: 'person', to: 'person', stable_id: 'rel_id', observed_at: 'since', evidence: ['note'] },
    { type: 'KNOWS', from: 'person', to: 'company', filterable: ['weight'], sortable: ['rank'] },
    { type: 'link', from: 'person', to: 'company' },
  ],
});

const SECOND = baseSource({
  id: 'second',
  entities: [{ type: 'person', label: 'Person', stable_id: 'id', search: ['alias'], filterable: ['ssn'] }],
  relationships: [],
});

describe('the mapping view of the AI settings', () => {
  it('holds the properties the gate projects a record to, and not the sortable ones', () => {
    const view = viewOf(FIRST);
    expect(namesOf(typeOf(view, 'person', 'entity'))).toEqual(['id', 'locale', 'name', 'ssn', 'state', 'status']);
    expect(namesOf(typeOf(view, 'company', 'entity'))).toEqual(['id']);
  });

  it('marks the pii properties of an entity and none of a relationship', () => {
    const view = viewOf(FIRST);
    expect(typeOf(view, 'person', 'entity')?.properties.filter((property) => property.pii).map((property) => property.name)).toEqual(['ssn']);
    expect(typeOf(view, 'KNOWS', 'relationship')?.properties.some((property) => property.pii)).toBe(false);
  });

  it('holds a relationship type once, with the union of its rows', () => {
    const view = viewOf(FIRST);
    expect(view.types.filter((type) => type.name === 'KNOWS')).toHaveLength(1);
    expect(namesOf(typeOf(view, 'KNOWS', 'relationship'))).toEqual(['note', 'rel_id', 'since', 'weight']);
  });

  it('joins an entity type across sources, and marks a property pii when one source does', () => {
    const view = viewOf(FIRST, SECOND);
    expect(view.types.filter((type) => type.name === 'person' && type.kind === 'entity')).toHaveLength(1);
    expect(namesOf(typeOf(view, 'person', 'entity'))).toEqual(['alias', 'id', 'locale', 'name', 'ssn', 'state', 'status']);
    expect(typeOf(view, 'person', 'entity')?.properties.find((property) => property.name === 'ssn')?.pii).toBe(true);
  });

  it('keeps the kind, so a name that is both an entity type and a relationship type appears twice', () => {
    const view = viewOf(FIRST);
    expect(view.types.filter((type) => type.name === 'link').map((type) => type.kind).sort()).toEqual(['entity', 'relationship']);
  });

  it('is empty for a mapping with no source', () => {
    expect(viewOf()).toEqual({ types: [] });
  });

  it('gives each relationship type every pair of end types its rows give, and says for each pair whether it carries a time', () => {
    const view = viewOf(FIRST);
    expect(typeOf(view, 'KNOWS', 'relationship')?.ends).toEqual([
      { from: 'person', to: 'person', timed: true },
      { from: 'person', to: 'company', timed: false },
    ]);
    expect(typeOf(view, 'person', 'entity')?.ends).toBeUndefined();
  });

  it('marks a pair as timed when any row of it has a time, across sources', () => {
    const other = baseSource({ id: 'third', entities: [{ type: 'person', label: 'Person', stable_id: 'id' }, { type: 'company', label: 'Company', stable_id: 'id' }], relationships: [{ type: 'KNOWS', from: 'person', to: 'company', observed_at: 'at' }] });
    expect(typeOf(viewOf(FIRST, other), 'KNOWS', 'relationship')?.ends).toContainEqual({ from: 'person', to: 'company', timed: true });
  });

  it('holds the derived rules by ID and end types, and none when the mapping has none', () => {
    const withRule = baseSource({ id: 'ruled', entities: [{ type: 'node_a', label: 'NodeA', stable_id: 'id' }, { type: 'node_b', label: 'NodeB', stable_id: 'key' }], relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b' }], derived: [{ id: 'shared', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1 }] });
    expect(viewOf(withRule).derivedRules).toEqual([{ id: 'shared', from: 'node_a', to: 'node_a' }]);
    expect(viewOf(FIRST).derivedRules).toBeUndefined();
  });

  it('holds names of types and rules only: no property name of a relationship appears among the ends or the rules', () => {
    const text = JSON.stringify({ ends: typeOf(viewOf(FIRST), 'KNOWS', 'relationship')?.ends });
    for (const property of ['since', 'note', 'weight', 'rel_id']) expect(text).not.toContain(property);
  });
});
