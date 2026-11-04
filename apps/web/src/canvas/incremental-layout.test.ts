import { describe, expect, it } from 'vitest';
import { createRandom, pickIndex } from '../dev/random.js';
import type { Position } from '../state/presentation-state.js';
import { BOX_HEIGHT, BOX_WIDTH, NEIGHBOUR_REACH } from './layout-constants.js';
import { layoutEntities, placeNewEntities, type LayoutInput, type PlacementInput } from './incremental-layout.js';

type Link = readonly [string, string];

function graph(entities: number, relationships: number, seed: number, prefix = 'n', offset = 0): { readonly ids: string[]; readonly links: Link[] } {
  const random = createRandom(seed);
  const ids = Array.from({ length: entities }, (_unused, index) => `${prefix}${offset + index}`);
  const links: Link[] = [];
  for (let index = 0; index < relationships; index += 1) {
    const from = ids[pickIndex(random, ids.length)];
    const to = ids[pickIndex(random, ids.length)];
    if (from !== undefined && to !== undefined) links.push([from, to]);
  }
  return { ids, links };
}

const overlaps = (a: Position, b: Position): boolean => Math.abs(a.x - b.x) < BOX_WIDTH && Math.abs(a.y - b.y) < BOX_HEIGHT;
const centroidOf = (points: readonly Position[]): Position => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length });

function movedCount(before: ReadonlyMap<string, Position>, after: ReadonlyMap<string, Position>): number {
  return [...before].filter(([id, position]) => {
    const now = after.get(id);
    return now === undefined || now.x !== position.x || now.y !== position.y;
  }).length;
}

function placedAll(input: PlacementInput): Map<string, Position> {
  return new Map([...input.positions, ...placeNewEntities(input)]);
}

function expectNoOverlap(positions: ReadonlyMap<string, Position>, among: Iterable<string>, others: ReadonlyMap<string, Position> = positions): void {
  for (const id of among) {
    const here = positions.get(id);
    expect(here).toBeDefined();
    for (const [other, there] of others) {
      if (other === id || here === undefined) continue;
      expect(overlaps(here, there), `${id} overlaps ${other}`).toBe(false);
    }
  }
}

describe('placing the entities that have no position', () => {
  it('places nothing for an empty graph, and nothing when every entity already has a position', () => {
    expect(placeNewEntities({ ids: [], links: [], positions: new Map() }).size).toBe(0);
    expect(placeNewEntities({ ids: ['a'], links: [], positions: new Map([['a', { x: 1, y: 2 }]]) }).size).toBe(0);
  });

  it('places a single entity with a finite position', () => {
    const placed = placeNewEntities({ ids: ['a'], links: [], positions: new Map() });
    const position = placed.get('a');
    expect(position !== undefined && Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
  });

  it('ignores a stored position of an entity that is not loaded, and a relationship to one, without failing', () => {
    const placed = placeNewEntities({ ids: ['a', 'b'], links: [['a', 'b'], ['a', 'gone'], ['a', 'a']], positions: new Map([['a', { x: 0, y: 0 }], ['gone', { x: 5, y: 5 }]]) });
    expect([...placed.keys()]).toEqual(['b']);
  });

  it('never changes the maps it is given', () => {
    const positions = new Map([['a', { x: 0, y: 0 }]]);
    const links: Link[] = [['a', 'b']];
    placeNewEntities({ ids: ['a', 'b'], links, positions });
    expect([...positions]).toEqual([['a', { x: 0, y: 0 }]]);
    expect(links).toEqual([['a', 'b']]);
  });

  it('gives every entity of a graph without positions a position, and no two entity boxes overlap', () => {
    const { ids, links } = graph(120, 180, 1);
    const placed = placeNewEntities({ ids, links, positions: new Map() });
    expect([...placed.keys()]).toEqual(ids);
    expectNoOverlap(placed, ids);
  });

  it('keeps every position of the 120 entities when 25 more arrive, and reports that 0 moved', () => {
    const first = graph(120, 180, 1);
    const before = placedAll({ ids: first.ids, links: first.links, positions: new Map() });
    const added = graph(25, 0, 2, 'm');
    const random = createRandom(3);
    const links: Link[] = [...first.links];
    for (const id of added.ids) {
      for (let count = 0; count < 1 + pickIndex(random, 3); count += 1) {
        const target = first.ids[pickIndex(random, first.ids.length)];
        if (target !== undefined) links.push([id, target]);
      }
    }
    const ids = [...first.ids, ...added.ids];
    const placed = placeNewEntities({ ids, links, positions: before });
    const after = new Map([...before, ...placed]);
    expect([...placed.keys()]).toEqual(added.ids);
    const moved = movedCount(before, after);
    expect(moved, `${moved} of ${before.size} entities moved`).toBe(0);
    expectNoOverlap(after, added.ids);
  });

  it('places a new entity within 400 model units of the centroid of its neighbours that already had a position', () => {
    const first = graph(120, 180, 1);
    const before = placedAll({ ids: first.ids, links: first.links, positions: new Map() });
    const ids = [...first.ids, ...Array.from({ length: 25 }, (_unused, index) => `m${index}`)];
    const random = createRandom(4);
    const links: Link[] = [...first.links];
    const anchors = new Map<string, string[]>();
    for (const id of ids.slice(120)) {
      const targets = [first.ids[pickIndex(random, first.ids.length)], first.ids[pickIndex(random, first.ids.length)]].flatMap((target) => target ?? []);
      anchors.set(id, targets);
      for (const target of targets) links.push([id, target]);
    }
    const placed = placeNewEntities({ ids, links, positions: before });
    for (const [id, targets] of anchors) {
      const middle = centroidOf(targets.flatMap((target) => before.get(target) ?? []));
      const position = placed.get(id);
      expect(position).toBeDefined();
      if (position !== undefined) expect(Math.hypot(position.x - middle.x, position.y - middle.y), id).toBeLessThanOrEqual(NEIGHBOUR_REACH);
    }
  });

  it('gives the same positions for the same input', () => {
    const { ids, links } = graph(60, 90, 5);
    const positions = new Map<string, Position>(ids.slice(0, 20).map((id, index) => [id, { x: index * 200, y: 0 }]));
    expect([...placeNewEntities({ ids, links, positions })]).toEqual([...placeNewEntities({ ids, links, positions })]);
  });
});

describe('placing entities that have no room beside a neighbour, or none to be beside', () => {
  const spread = (count: number): Map<string, Position> => new Map(Array.from({ length: count }, (_unused, index) => [`k${index}`, { x: (index % 5) * 300, y: Math.floor(index / 5) * 200 }] as const));
  const dense = (columns: number, rows: number): Map<string, Position> => new Map(Array.from({ length: columns * rows }, (_unused, index) => [`k${index}`, { x: (index % columns) * BOX_WIDTH, y: Math.floor(index / columns) * BOX_HEIGHT }] as const));

  it('places an entity joined only to other new entities within 400 of the one it is joined to, and none on top of another', () => {
    const known = spread(10);
    const input: PlacementInput = { ids: [...known.keys(), 'a', 'b', 'c'], links: [['k0', 'a'], ['a', 'b'], ['b', 'c']], positions: known };
    const after = placedAll(input);
    for (const [id, anchor] of [['b', 'a'], ['c', 'b']] as const) {
      const here = after.get(id);
      const there = after.get(anchor);
      expect(here !== undefined && there !== undefined && Math.hypot(here.x - there.x, here.y - there.y)).toBeLessThanOrEqual(NEIGHBOUR_REACH);
    }
    expectNoOverlap(after, ['a', 'b', 'c']);
  });

  it('places a group of new entities that touches nothing placed, as a row to the right of the others, its members beside its first', () => {
    const known = spread(10);
    const input: PlacementInput = { ids: [...known.keys(), 'a', 'b'], links: [['a', 'b']], positions: known };
    const after = placedAll(input);
    const maxX = Math.max(...[...known.values()].map((position) => position.x));
    const first = after.get('a');
    expect(first !== undefined && first.x > maxX).toBe(true);
    const second = after.get('b');
    expect(first !== undefined && second !== undefined && Math.hypot(first.x - second.x, first.y - second.y)).toBeLessThanOrEqual(NEIGHBOUR_REACH);
    expectNoOverlap(after, ['a', 'b']);
  });

  it('puts entities joined to nothing outside the bounding box of the others, to the right of it, in a row', () => {
    const known = spread(10);
    const lone = ['p', 'q', 'r', 's'];
    const placed = placeNewEntities({ ids: [...known.keys(), ...lone], links: [], positions: known });
    const maxX = Math.max(...[...known.values()].map((position) => position.x));
    const minY = Math.min(...[...known.values()].map((position) => position.y));
    for (const id of lone) {
      const position = placed.get(id);
      expect(position !== undefined && position.x > maxX && position.y === minY, id).toBe(true);
    }
    expectNoOverlap(new Map([...known, ...placed]), lone);
  });

  it('puts the entity at the nearest free spot beyond 400 when its neighbours are so crowded that none is free within it, and moves no existing entity', () => {
    const known = dense(15, 15);
    const centre = known.get('k112');
    const placed = placeNewEntities({ ids: [...known.keys(), 'new'], links: [['k112', 'new']], positions: known });
    const position = placed.get('new');
    expect(centre !== undefined && position !== undefined && Math.hypot(position.x - centre.x, position.y - centre.y)).toBeGreaterThan(NEIGHBOUR_REACH);
    expectNoOverlap(new Map([...known, ...placed]), ['new']);
    expect(movedCount(known, new Map([...known, ...placed]))).toBe(0);
  });

  it('finds the one free spot within 400 of the centroid when it is a pocket two units wide that sampling misses', () => {
    const cells = new Map<string, Position>();
    for (let column = -6; column <= 6; column += 1) {
      for (let row = -9; row <= 9; row += 1) {
        if (column === 0 && row === 0) continue;
        cells.set(`k${column}:${row}`, { x: column * BOX_WIDTH + (column > 0 ? 2 : 0), y: row * BOX_HEIGHT + (row > 0 ? 2 : 0) });
      }
    }
    const hub = 'k1:1';
    const centre = cells.get(hub);
    const placed = placeNewEntities({ ids: [...cells.keys(), 'new'], links: [[hub, 'new']], positions: cells });
    const position = placed.get('new');
    expect(position !== undefined && position.x >= 0 && position.x <= 2 && position.y >= 0 && position.y <= 2, JSON.stringify(position)).toBe(true);
    expect(centre !== undefined && position !== undefined && Math.hypot(position.x - centre.x, position.y - centre.y)).toBeLessThanOrEqual(NEIGHBOUR_REACH);
    expectNoOverlap(new Map([...cells, ...placed]), ['new']);
  });

  it('finds the one free spot when it is an exact fit between its neighbours, at coordinates that are not whole multiples of a box', () => {
    const cells = new Map<string, Position>();
    for (let column = -6; column <= 6; column += 1) {
      for (let row = -9; row <= 9; row += 1) {
        if (column !== 0 || row !== 0) cells.set(`k${column}:${row}`, { x: 51 + column * BOX_WIDTH, y: 31 + row * BOX_HEIGHT });
      }
    }
    const placed = placeNewEntities({ ids: [...cells.keys(), 'new'], links: [['k1:1', 'new']], positions: cells });
    expect(placed.get('new')).toEqual({ x: 51, y: 31 });
  });

  it('puts an isolated entity right of every other entity in the same addition, the connected ones included', () => {
    const known = spread(10);
    const maxKnown = Math.max(...[...known.values()].map((position) => position.x));
    const fresh = ['a', 'b', 'c', 'lone', 'lone2'];
    const links: Link[] = [['k0', 'a'], ['a', 'b'], ['b', 'c']];
    const placed = placeNewEntities({ ids: [...known.keys(), ...fresh], links, positions: known });
    const connectedRight = Math.max(...['a', 'b', 'c'].map((id) => placed.get(id)?.x ?? -Infinity));
    for (const id of ['lone', 'lone2']) {
      const position = placed.get(id);
      expect(position !== undefined && position.x > Math.max(maxKnown, connectedRight), id).toBe(true);
    }
    expectNoOverlap(new Map([...known, ...placed]), fresh);
  });

  it('leaves existing positions as they are when their boxes already overlap, and overlaps none of them with a new one', () => {
    const known = new Map<string, Position>([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 5 }], ['c', { x: 0, y: 0 }]]);
    const placed = placeNewEntities({ ids: ['a', 'b', 'c', 'x', 'y'], links: [['a', 'x'], ['b', 'y']], positions: known });
    expect(movedCount(known, new Map([...known, ...placed]))).toBe(0);
    expectNoOverlap(new Map([...known, ...placed]), ['x', 'y']);
  });

  it('places 25 new entities that are all joined to one existing entity, none on another and every one placed', () => {
    const known = spread(10);
    const fresh = Array.from({ length: 25 }, (_unused, index) => `m${index}`);
    const placed = placeNewEntities({ ids: [...known.keys(), ...fresh], links: fresh.map((id) => ['k3', id] as const), positions: known });
    expect([...placed.keys()]).toEqual(fresh);
    expectNoOverlap(new Map([...known, ...placed]), fresh);
  });

  it('places 24 new entities that are all joined to one new entity, none on another', () => {
    const known = spread(10);
    const fresh = Array.from({ length: 25 }, (_unused, index) => `m${index}`);
    const placed = placeNewEntities({ ids: [...known.keys(), ...fresh], links: fresh.slice(1).map((id) => ['m0', id] as const), positions: known });
    expect(placed.size).toBe(25);
    expectNoOverlap(new Map([...known, ...placed]), fresh);
  });

  it('gives the same positions when run twice on a crowded graph with loners and groups', () => {
    const known = dense(6, 6);
    const input: PlacementInput = { ids: [...known.keys(), 'a', 'b', 'c', 'd'], links: [['k0', 'a'], ['b', 'c']], positions: known };
    expect([...placeNewEntities(input)]).toEqual([...placeNewEntities(input)]);
  });
});

describe('laying the unpinned entities out again', () => {
  const sample = (entities = 40, relationships = 60, seed = 7) => {
    const { ids, links } = graph(entities, relationships, seed);
    const scattered = new Map<string, Position>(ids.map((id, index) => [id, { x: (index % 8) * 150 + (index % 3) * 17, y: Math.floor(index / 8) * 90 + (index % 5) * 11 }]));
    return { ids, links, scattered };
  };
  const run = (input: LayoutInput): Map<string, Position> => new Map([...input.positions, ...layoutEntities(input)]);
  const centroidOfIds = (positions: ReadonlyMap<string, Position>, ids: readonly string[]): Position => centroidOf(ids.flatMap((id) => positions.get(id) ?? []));
  const near = (a: Position, b: Position, tolerance: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

  it('returns nothing for an empty graph and when every entity is pinned, and places one entity where it was', () => {
    expect(layoutEntities({ ids: [], links: [], positions: new Map(), pinned: new Set() }).size).toBe(0);
    const pinned = new Set(['a', 'b']);
    expect(layoutEntities({ ids: ['a', 'b'], links: [['a', 'b']], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 5, y: 5 }]]), pinned }).size).toBe(0);
    const only = layoutEntities({ ids: ['a'], links: [], positions: new Map([['a', { x: 42, y: -7 }]]), pinned: new Set() });
    expect(only.get('a')).toEqual({ x: 42, y: -7 });
  });

  it('gives every unpinned entity a position, none on top of another, and keeps the centroid where it was, to within 0.01, when nothing is pinned', () => {
    const { ids, links, scattered } = sample();
    const laid = run({ ids, links, positions: scattered, pinned: new Set() });
    expect([...layoutEntities({ ids, links, positions: scattered, pinned: new Set() }).keys()]).toEqual(ids);
    expectNoOverlap(laid, ids);
    expect(near(centroidOfIds(laid, ids), centroidOfIds(scattered, ids), 0.01)).toBe(true);
  });

  it('keeps every pinned entity exactly where it was, also when pinned boxes overlap one another, and puts no unpinned box on any other', () => {
    const { ids, links, scattered } = sample();
    const pinned = new Set([ids[0] ?? '', ids[1] ?? '', ids[2] ?? '']);
    const positions = new Map(scattered).set(ids[1] ?? '', { x: (scattered.get(ids[0] ?? '')?.x ?? 0) + 10, y: scattered.get(ids[0] ?? '')?.y ?? 0 });
    const result = layoutEntities({ ids, links, positions, pinned });
    for (const id of pinned) expect(result.has(id)).toBe(false);
    const after = new Map([...positions, ...result]);
    expect(movedCount(new Map([...pinned].map((id) => [id, positions.get(id) ?? { x: 0, y: 0 }])), after), 'pinned entities that moved').toBe(0);
    expectNoOverlap(after, ids.filter((id) => !pinned.has(id)));
    expect(overlaps(after.get(ids[0] ?? '') ?? { x: 0, y: 0 }, after.get(ids[1] ?? '') ?? { x: 1e9, y: 1e9 })).toBe(true);
  });

  it('is the same arrangement whatever the unpinned entities started as, up to the shift of the centroid, when nothing is pinned', () => {
    const { ids, links, scattered } = sample();
    const rotated = new Map<string, Position>(ids.map((id, index) => [id, scattered.get(ids[(index * 7) % ids.length] ?? '') ?? { x: 0, y: 0 }]));
    const first = run({ ids, links, positions: scattered, pinned: new Set() });
    const second = run({ ids, links, positions: rotated, pinned: new Set() });
    const by = { x: centroidOfIds(second, ids).x - centroidOfIds(first, ids).x, y: centroidOfIds(second, ids).y - centroidOfIds(first, ids).y };
    for (const id of ids) {
      const a = first.get(id);
      const b = second.get(id);
      expect(a !== undefined && b !== undefined && near({ x: a.x + by.x, y: a.y + by.y }, b, 1e-6), id).toBe(true);
    }
  });

  it('is the same arrangement from starts with the same centroid when entities are pinned', () => {
    const { ids, links, scattered } = sample();
    const pinned = new Set([ids[3] ?? '', ids[4] ?? '']);
    const unpinned = ids.filter((id) => !pinned.has(id));
    const swapped = new Map(scattered);
    const [x, y] = [unpinned[0] ?? '', unpinned[1] ?? ''];
    swapped.set(x, scattered.get(y) ?? { x: 0, y: 0 }).set(y, scattered.get(x) ?? { x: 0, y: 0 });
    expect([...layoutEntities({ ids, links, positions: scattered, pinned })]).toEqual([...layoutEntities({ ids, links, positions: swapped, pinned })]);
  });

  it('moves an entity dragged far away to the position the layout gives it, not to where it was dragged', () => {
    const { ids, links, scattered } = sample();
    const draggedId = ids[10] ?? '';
    const dragged = new Map(scattered).set(draggedId, { x: 90_000, y: 90_000 });
    const result = layoutEntities({ ids, links, positions: dragged, pinned: new Set() });
    const position = result.get(draggedId);
    expect(position !== undefined && Math.hypot(position.x, position.y) < 5_000).toBe(true);
  });

  it('runs again on its own output without moving a pinned entity or overlapping a box, also when pins shifted the centroid, and without moving anything when nothing is pinned', () => {
    const { ids, links, scattered } = sample(30, 40, 3);
    const none = run({ ids, links, positions: scattered, pinned: new Set() });
    const again = run({ ids, links, positions: none, pinned: new Set() });
    for (const id of ids) {
      const a = none.get(id);
      const b = again.get(id);
      expect(a !== undefined && b !== undefined && near(a, b, 0.01), id).toBe(true);
    }
    const pinned = new Set(ids.slice(0, 12));
    const firstPinned = run({ ids, links, positions: scattered, pinned });
    const centroidShift = Math.hypot(centroidOfIds(firstPinned, ids).x - centroidOfIds(scattered, ids).x, centroidOfIds(firstPinned, ids).y - centroidOfIds(scattered, ids).y);
    expect(Number.isFinite(centroidShift), `the centroid moved by ${centroidShift.toFixed(1)} units`).toBe(true);
    const secondPinned = run({ ids, links, positions: firstPinned, pinned });
    for (const id of pinned) expect(secondPinned.get(id)).toEqual(scattered.get(id));
    expectNoOverlap(secondPinned, ids.filter((id) => !pinned.has(id)));
  });

  it('lays out the 120 entities of the fixture without a box on another', () => {
    const { ids, links } = graph(120, 180, 1);
    const start = placedAll({ ids, links, positions: new Map() });
    const laid = run({ ids, links, positions: start, pinned: new Set(ids.slice(0, 10)) });
    expectNoOverlap(laid, ids.slice(10));
  });
});
