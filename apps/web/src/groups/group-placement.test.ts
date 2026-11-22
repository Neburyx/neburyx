import { describe, expect, it } from 'vitest';
import { placementPositions } from './group-placement.js';

describe('placementPositions', () => {
  const positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 40 }], ['c', { x: 500, y: 500 }]]);

  it('puts the members of a collapsed group at their centre and leaves the rest', () => {
    const result = placementPositions(positions, [{ id: 'g', by: 'entityType', members: ['a', 'b'], collapsed: true }]);
    expect(result.get('a')).toEqual({ x: 50, y: 20 });
    expect(result.get('b')).toEqual({ x: 50, y: 20 });
    expect(result.get('c')).toEqual({ x: 500, y: 500 });
  });

  it('keeps the stored places of an expanded group, and never writes to the input', () => {
    const result = placementPositions(positions, [{ id: 'g', by: 'entityType', members: ['a', 'b'], collapsed: false }]);
    expect(result).toBe(positions);
    placementPositions(positions, [{ id: 'g', by: 'entityType', members: ['a'], collapsed: true }]);
    expect(positions.get('b')).toEqual({ x: 100, y: 40 });
  });
});
