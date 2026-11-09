import { describe, expect, it } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, ref } from '../state/test-data.js';
import { pickSet, selectionKind } from './compare-set.js';

const nodes = (count: number): string[] => Array.from({ length: count }, (_unused, at) => elementKey(ref('a', 'type-a', `n${at}`)));
const edges = (count: number): string[] => Array.from({ length: count }, (_unused, at) => edgeKey(edgeRef('a', `e${at}`)));

describe('the kind of a selection', () => {
  it('is entities, relationships, mixed or none', () => {
    expect(selectionKind(nodes(2))).toBe('entities');
    expect(selectionKind(edges(2))).toBe('relationships');
    expect(selectionKind([...nodes(1), ...edges(1)])).toBe('mixed');
    expect(selectionKind([])).toBe('none');
  });
});

describe('the set a selection makes', () => {
  it('is undefined for fewer than two or for both kinds', () => {
    expect(pickSet(nodes(1))).toBeUndefined();
    expect(pickSet([...nodes(2), ...edges(1)])).toBeUndefined();
    expect(pickSet([])).toBeUndefined();
  });

  it('takes the first five in selection order and keeps the rest to be named', () => {
    const keys = nodes(7);
    expect(pickSet(keys)).toEqual({ kind: 'entities', compared: keys.slice(0, 5), left: keys.slice(5), selected: 7 });
    expect(pickSet(nodes(5))?.left).toEqual([]);
    expect(pickSet(edges(6))).toMatchObject({ kind: 'relationships', selected: 6 });
  });

  it('takes its limit from its argument, so nothing else holds the number', () => {
    expect(pickSet(nodes(5), 4)?.compared).toHaveLength(4);
    expect(pickSet(nodes(5), 4)?.left).toHaveLength(1);
  });
});
