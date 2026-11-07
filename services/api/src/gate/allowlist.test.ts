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

  it('keeps the label, not the display name, as the label the reads of the source name, and does not take the display name for a property', () => {
    const allowlist = allowlistFromMapping(sourceWith({ entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', display: { name: 'Fancy gadget `x`' } }], relationships: [] }));
    expect([...allowlist.entityLabels]).toEqual([['gadget', 'Gadget']]);
    expect([...allowlist.properties]).toEqual(['gadgetId']);
  });

  it.each([
    ['a backtick', 'bad`id'],
    ['a backslash', 'bad\\id'],
    ['a control character', 'bad\u0001id'],
    ['only whitespace', '   '],
  ])('refuses a stable id with %s, because it is written into the Cypher as a quoted name', (_name, stableId) => {
    expect(() => allowlistFromMapping(sourceWith({ entities: [{ type: 'gadget', label: 'Gadget', stable_id: stableId }], relationships: [] }))).toThrow(SourceGateError);
  });

  it('holds the evidence properties of each relationship mapping row that has any, with a stable ID or without one, in the mapping order', () => {
    const allowlist = allowlistFromMapping(
      sourceWith({
        entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }, { type: 'person', label: 'Person', stable_id: 'personId' }],
        relationships: [
          { type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
          { type: 'MADE_BY', from: 'person', to: 'gadget', evidence: ['otherId'] },
          { type: 'KNOWS', from: 'person', to: 'person', stable_id: 'linkId' },
        ],
      }),
    );
    expect(allowlist.evidenceRows).toEqual([
      { type: 'MADE_BY', from: 'gadget', to: 'person', properties: ['recordId', 'docId'] },
      { type: 'MADE_BY', from: 'person', to: 'gadget', properties: ['otherId'] },
    ]);
  });

  it.each([
    ['a backtick', 'bad`rec'],
    ['a backslash', 'bad\\rec'],
    ['a control character', 'bad\u0001rec'],
    ['only whitespace', '   '],
  ])('refuses an evidence property with %s, because it is written into the Cypher as a quoted name', (_name, property) => {
    const entities = [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }, { type: 'person', label: 'Person', stable_id: 'personId' }];
    expect(() => allowlistFromMapping(sourceWith({ entities, relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', evidence: [property] }] }))).toThrow(SourceGateError);
  });

  it('holds the reference properties of each entity type, by type', () => {
    const allowlist = allowlistFromMapping(
      sourceWith({ entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['title'], reference: ['extRef', 'otherRef'] }, { type: 'person', label: 'Person', stable_id: 'personId' }], relationships: [] }),
    );
    expect([...allowlist.referenceProperties]).toEqual([['gadget', ['extRef', 'otherRef']], ['person', []]]);
  });

  it.each([
    ['a backtick', 'bad`ref'],
    ['a backslash', 'bad\\ref'],
    ['a control character', 'bad\u0001ref'],
    ['only whitespace', '   '],
  ])('refuses a reference property with %s, because it is written into the Cypher as a quoted name', (_name, property) => {
    expect(() => allowlistFromMapping(sourceWith({ entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', reference: [property] }], relationships: [] }))).toThrow(SourceGateError);
  });
});
