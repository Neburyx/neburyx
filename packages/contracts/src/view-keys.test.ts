import { describe, expect, it } from 'vitest';
import { readViewKeys } from './view-keys.js';

const node = (source: string, type: string, id: string): string => JSON.stringify(['node', source, type, id]);

describe('the keys of the view read back as references', () => {
  it('reads entity keys of the source into references', () => {
    expect(readViewKeys([node('demo', 'widget', 'widget-1'), node('demo', 'gadget', 'gadget-1')], 'demo')).toEqual({
      ok: true,
      refs: { entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'widget-1' }, { sourceId: 'demo', entityType: 'gadget', stableId: 'gadget-1' }], edges: [], aggregates: [], derived: [] },
    });
  });

  it('reads no key as no reference', () => {
    expect(readViewKeys([], 'demo')).toEqual({ ok: true, refs: { entities: [], edges: [], aggregates: [], derived: [] } });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a key of the wrong length', JSON.stringify(['node', 'demo', 'widget'])],
    ['a key of another form', JSON.stringify(['thing', 'demo', 'widget', 'widget-1'])],
    ['a member that is not text', JSON.stringify(['node', 'demo', 'widget', 1])],
    ['an empty member', JSON.stringify(['node', 'demo', '', 'widget-1'])],
    ['an object', '{"node":true}'],
  ])('refuses every key for %s', (_name, key) => {
    expect(readViewKeys([node('demo', 'widget', 'widget-1'), key], 'demo')).toEqual({ ok: false });
  });

  it('refuses a key of another source and the same reference twice', () => {
    expect(readViewKeys([node('elsewhere', 'widget', 'widget-1')], 'demo')).toEqual({ ok: false });
    expect(readViewKeys([node('demo', 'widget', 'widget-1'), node('demo', 'widget', 'widget-1')], 'demo')).toEqual({ ok: false });
  });

  it('takes a Cypher fragment in an id as a value, nothing more', () => {
    const result = readViewKeys([node('demo', 'widget', "widget-1' }) DETACH DELETE n //")], 'demo');
    expect(result).toEqual({ ok: true, refs: { entities: [{ sourceId: 'demo', entityType: 'widget', stableId: "widget-1' }) DETACH DELETE n //" }], edges: [], aggregates: [], derived: [] } });
  });

  const stored = (source: string, id: string): string => JSON.stringify(['edge', source, 'stored', 'link_a', 'widget-1', 'gadget-1', id]);
  const aggregate = (source: string, endSource = source): string => JSON.stringify(['edge', source, 'aggregate', 'link_a', node(source, 'widget', 'widget-1'), node(endSource, 'gadget', 'gadget-1')]);
  const derived = (source: string, endSource = source): string => JSON.stringify(['edge', source, 'derived', 'rule-1', node(endSource, 'widget', 'widget-1'), node(source, 'gadget', 'gadget-1')]);

  it('splits stored, aggregate and derived relationship keys into the lists a read takes', () => {
    const result = readViewKeys([node('demo', 'widget', 'widget-1'), stored('demo', 'link-1'), aggregate('demo'), derived('demo')], 'demo');
    expect(result).toEqual({
      ok: true,
      refs: {
        entities: [{ sourceId: 'demo', entityType: 'widget', stableId: 'widget-1' }],
        edges: [{ sourceId: 'demo', type: 'link_a', from: 'widget-1', to: 'gadget-1', stableId: 'link-1' }],
        aggregates: [{ sourceId: 'demo', aggregate: { type: 'link_a', from: { sourceId: 'demo', entityType: 'widget', stableId: 'widget-1' }, to: { sourceId: 'demo', entityType: 'gadget', stableId: 'gadget-1' } } }],
        derived: [{ sourceId: 'demo', derived: { ruleId: 'rule-1', from: { sourceId: 'demo', entityType: 'widget', stableId: 'widget-1' }, to: { sourceId: 'demo', entityType: 'gadget', stableId: 'gadget-1' } } }],
      },
    });
  });

  it.each([
    ['a stored key of another source', stored('elsewhere', 'link-1')],
    ['an aggregate key of another source', aggregate('elsewhere')],
    ['an aggregate key whose end is of another source', aggregate('demo', 'elsewhere')],
    ['a derived key whose end is of another source', derived('demo', 'elsewhere')],
    ['an aggregate key whose end is not an entity key', JSON.stringify(['edge', 'demo', 'aggregate', 'link_a', 'widget-1', 'gadget-1'])],
    ['a stored key of the wrong length', JSON.stringify(['edge', 'demo', 'stored', 'link_a', 'widget-1', 'gadget-1'])],
    ['an edge key of an unknown form', JSON.stringify(['edge', 'demo', 'other', 'a', 'b', 'c'])],
  ])('refuses every key for %s', (_name, key) => {
    expect(readViewKeys([node('demo', 'widget', 'widget-1'), key], 'demo')).toEqual({ ok: false });
  });

  it('refuses a relationship that is named twice, even when one key is written with other spacing', () => {
    expect(readViewKeys([aggregate('demo'), JSON.stringify(JSON.parse(aggregate('demo')), null, 1)], 'demo')).toEqual({ ok: false });
    expect(readViewKeys([stored('demo', 'link-1'), stored('demo', 'link-1')], 'demo')).toEqual({ ok: false });
  });
});
