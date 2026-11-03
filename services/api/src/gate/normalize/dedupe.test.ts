import { describe, expect, it } from 'vitest';
import { context, plainNode } from '../../testing/normalize-fixtures.js';
import { normalizeRows } from './index.js';

const rows = (...nodes: ReturnType<typeof plainNode>[]) => nodes.map((n) => ({ n }));

describe('the same node seen twice', () => {
  it('is one Node, in the place of its first appearance', () => {
    const result = normalizeRows(context(), rows(plainNode(['Person'], { personId: 'a' }), plainNode(['Person'], { personId: 'b' }), plainNode(['Person'], { personId: 'a' }, 'e9')));
    expect(result.nodes.map((node) => node.ref.stableId)).toEqual(['a', 'b']);
  });

  it('keeps the first value of a key, takes a key only the later one has, and fills a key the first lacks', () => {
    const first = plainNode(['Gadget'], { gadgetId: 'g', title: 'First', kind: 'k1' });
    const later = plainNode(['Gadget'], { gadgetId: 'g', title: 'First', kind: 'k1', madeOn: { $type: 'date', value: '2026-01-02' } }, 'e2');
    const [node] = normalizeRows(context(), rows(first, later)).nodes;
    expect(node?.properties.find((property) => property.key === 'madeOn')).toMatchObject({ value: '2026-01-02', dataClass: 'date' });
    expect(node?.qualityFlags).toEqual([]);
  });

  it('flags a key with two different values and keeps the first', () => {
    const [node] = normalizeRows(context(), rows(plainNode(['Gadget'], { gadgetId: 'g', title: 'First', kind: 'k1', madeOn: '2026' }), plainNode(['Gadget'], { gadgetId: 'g', title: 'Other', kind: 'k1', madeOn: '2026' }, 'e2'))).nodes;
    expect(node?.properties.find((property) => property.key === 'title')?.value).toBe('First');
    expect(node?.qualityFlags).toEqual(['conflicting-duplicate']);
  });

  it('clears the missing-property flag when the later row supplies what the first lacked', () => {
    const [node] = normalizeRows(context(), rows(plainNode(['Gadget'], { gadgetId: 'g', title: 'T' }), plainNode(['Gadget'], { gadgetId: 'g', title: 'T', kind: 'k', madeOn: '2026' }, 'e2'))).nodes;
    expect(node?.qualityFlags).toEqual([]);
    expect(node?.properties.every((property) => property.value !== undefined)).toBe(true);
  });

  it('is one Node per entity type: the same stable ID under two entity types is two Nodes', () => {
    const result = normalizeRows(context(), rows(plainNode(['Person'], { personId: 'x' }), plainNode(['Gadget'], { gadgetId: 'x' }), plainNode(['Gadget'], { gadgetId: 'x' }, 'e3')));
    expect(result.nodes.map((node) => node.ref.entityType)).toEqual(['person', 'gadget']);
  });
});
