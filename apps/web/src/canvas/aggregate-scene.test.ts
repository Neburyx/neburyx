import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { aggregateKey, aggregateLinkKey, type AggregateNode } from '../workspace/aggregate-nodes.js';
import { buildScene } from './build-scene.js';
import { BOX_HEIGHT, BOX_WIDTH, REMAINDER_RADIUS } from './layout-constants.js';

const first = elementKey(ref('a', 'type-a', 'n1'));
const second = elementKey(ref('a', 'type-a', 'n2'));
const state = createClientState();
state.bindSource('a');
state.putResult(key('a'), result('a', ['n1', 'n2']));
state.setLoaded([key('a')], [ref('a', 'type-a', 'n1'), ref('a', 'type-a', 'n2')], []);
const positions = new Map([[first, { x: 100, y: 100 }], [second, { x: 900, y: 100 }]]);
const aggregate = (nodeKey: string, neighborType: string): AggregateNode => ({ nodeKey, neighborType, iconKey: 'generic', label: `${neighborType} · 1 / 5`, name: neighborType, figures: '1 / 5', detail: 'total 5 · exact', spoken: 'x' });

describe('the aggregate nodes of the scene', () => {
  const scene = buildScene(state.loadedGraph(), positions, undefined, new Set(), 'select', null, 'fit', new Set(), undefined, true, [aggregate(first, 'k1'), aggregate(first, 'k2'), aggregate(first, 'k3'), aggregate(second, 'k1')]);
  const remainders = scene.entities.filter((entity) => entity.remainder === true);

  it('adds one entity for each, flagged, with its caption, and one line joining it to its node', () => {
    expect(remainders.map((entity) => entity.id)).toEqual([aggregateKey(first, 'k1'), aggregateKey(first, 'k2'), aggregateKey(first, 'k3'), aggregateKey(second, 'k1')]);
    expect(remainders[0]?.look).toEqual({ iconKey: 'generic', line1: 'k1', line2: '1 / 5', tip: { title: 'k1 · 1 / 5', detail: 'total 5 · exact' } });
    const links = scene.relationships.filter((relationship) => relationship.remainder === true);
    expect(links.map((link) => [link.id, link.from, link.to])).toEqual(remainders.map((entity) => [aggregateLinkKey(...(JSON.parse(entity.id) as [string, string, string]).slice(1) as [string, string]), JSON.parse(entity.id)[1], entity.id]));
  });

  it('places each on a ring around its node where there is room, never on the node or on one another, and moves no loaded node', () => {
    const own = remainders.filter((entity) => JSON.parse(entity.id)[1] === first);
    for (const entity of own) expect(Math.hypot(entity.position.x - 100, entity.position.y - 100)).toBeCloseTo(REMAINDER_RADIUS);
    for (const [at, one] of remainders.entries()) for (const other of remainders.slice(at + 1)) expect(Math.abs(one.position.x - other.position.x) >= BOX_WIDTH || Math.abs(one.position.y - other.position.y) >= BOX_HEIGHT).toBe(true);
    expect(scene.entities.filter((entity) => entity.remainder !== true).map((entity) => entity.position)).toEqual([{ x: 100, y: 100 }, { x: 900, y: 100 }]);
  });

  it('goes further out, ring by ring, where a loaded entity is already, and never over one', () => {
    const crowded = new Map(positions);
    crowded.set(elementKey(ref('a', 'type-a', 'n2')), { x: 100, y: 100 - REMAINDER_RADIUS });
    const one = buildScene(state.loadedGraph(), crowded, undefined, new Set(), 'select', null, 'fit', new Set(), undefined, true, [aggregate(first, 'k1')]);
    const place = one.entities.find((entity) => entity.remainder === true)?.position;
    expect(place).toBeDefined();
    if (place === undefined) return;
    for (const loaded of crowded.values()) expect(Math.abs(loaded.x - place.x) >= BOX_WIDTH || Math.abs(loaded.y - place.y) >= BOX_HEIGHT).toBe(true);
    expect(Math.hypot(place.x - 100, place.y - 100)).toBeGreaterThanOrEqual(REMAINDER_RADIUS);
  });

  it('never holds one in the selection or the pins, and lets the walk stand on one', () => {
    const id = aggregateKey(first, 'k1');
    const walked = buildScene(state.loadedGraph(), positions, undefined, new Set([id]), 'select', null, 'fit', new Set([id]), id, true, [aggregate(first, 'k1')]);
    expect(walked.focused).toBe(id);
    expect(walked.selection.size).toBe(0);
    expect(walked.pinned.size).toBe(0);
  });

  it('draws none for a node that has no position', () => {
    const none = buildScene(state.loadedGraph(), positions, undefined, new Set(), 'select', null, 'fit', new Set(), undefined, true, [aggregate(elementKey(ref('a', 'type-a', 'ghost')), 'k1')]);
    expect(none.entities.every((entity) => entity.remainder !== true)).toBe(true);
  });
});
