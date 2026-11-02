import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../testing/mapping.js';
import { allowlistFromMapping, SourceGateError } from './allowlist.js';

const sourceWith = (overrides: Record<string, unknown>) => firstSource(load(baseSource(overrides)));

describe('the allowlist of a source', () => {
  it('holds the labels, the relationship types, the stable id of each entity type and every property the mapping names', () => {
    const allowlist = allowlistFromMapping(
      sourceWith({
        entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['title'], reference: ['extRef'] }, { type: 'person', label: 'Person', stable_id: 'personId' }],
        relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }],
      }),
    );
    expect([...allowlist.entityLabels]).toEqual([['gadget', 'Gadget'], ['person', 'Person']]);
    expect([...allowlist.relationshipTypes]).toEqual(['MADE_BY']);
    expect([...allowlist.stableIds]).toEqual([['gadget', 'gadgetId'], ['person', 'personId']]);
    expect([...allowlist.properties].sort()).toEqual(['extRef', 'gadgetId', 'linkId', 'madeAt', 'personId', 'recordId', 'title']);
  });

  it.each([
    ['a backtick', 'bad`id'],
    ['a backslash', 'bad\\id'],
    ['a control character', 'bad\u0001id'],
    ['only whitespace', '   '],
  ])('refuses a stable id with %s, because it is written into the Cypher as a quoted name', (_name, stableId) => {
    expect(() => allowlistFromMapping(sourceWith({ entities: [{ type: 'gadget', label: 'Gadget', stable_id: stableId }], relationships: [] }))).toThrow(SourceGateError);
  });
});
