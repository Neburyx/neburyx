import type { Position } from '../state/presentation-state.js';
import { BOX_HEIGHT, BOX_WIDTH, FORCE_STEPS, IDEAL_LENGTH, NEIGHBOUR_REACH, REPULSION_REACH, SEARCH_STEP, SEED_OFFSET, SPIRAL_STEP } from './layout-constants.js';

export interface PlacementInput {
  readonly ids: readonly string[];
  readonly links: readonly (readonly [string, string])[];
  readonly positions: ReadonlyMap<string, Position>;
}

const GOLDEN_ANGLE = 2.399963;
const SEARCH_LIMIT = 40_000;

const boundsOf = (points: readonly Position[]): { readonly minY: number; readonly maxX: number } => ({ minY: Math.min(...points.map((point) => point.y)), maxX: Math.max(...points.map((point) => point.x)) });

const centroid = (points: readonly Position[]): Position => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length });
const distance = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.y - b.y);
const overlap = (a: Position, b: Position): boolean => Math.abs(a.x - b.x) < BOX_WIDTH && Math.abs(a.y - b.y) < BOX_HEIGHT;

function neighboursOf(ids: readonly string[], links: PlacementInput['links']): ReadonlyMap<string, readonly string[]> {
  const loaded = new Set(ids);
  const sets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const [from, to] of links) {
    if (from === to || !loaded.has(from) || !loaded.has(to)) continue;
    sets.get(from)?.add(to);
    sets.get(to)?.add(from);
  }
  return new Map([...sets].map(([id, set]) => [id, [...set]]));
}

class BoxGrid {
  private readonly cells = new Map<string, Position[]>();

  private static cell(x: number, y: number): readonly [number, number] {
    return [Math.floor(x / BOX_WIDTH), Math.floor(y / BOX_HEIGHT)];
  }

  add(position: Position): void {
    const [cx, cy] = BoxGrid.cell(position.x, position.y);
    const key = `${cx},${cy}`;
    const held = this.cells.get(key);
    if (held === undefined) this.cells.set(key, [position]);
    else held.push(position);
  }

  near(position: Position, halfWidth: number, halfHeight: number): Position[] {
    const [fromX, fromY] = BoxGrid.cell(position.x - halfWidth, position.y - halfHeight);
    const [toX, toY] = BoxGrid.cell(position.x + halfWidth, position.y + halfHeight);
    const found: Position[] = [];
    for (let cx = fromX; cx <= toX; cx += 1) {
      for (let cy = fromY; cy <= toY; cy += 1) {
        for (const other of this.cells.get(`${cx},${cy}`) ?? []) if (Math.abs(other.x - position.x) <= halfWidth && Math.abs(other.y - position.y) <= halfHeight) found.push(other);
      }
    }
    return found;
  }

  free(position: Position): boolean {
    const [fromX, fromY] = BoxGrid.cell(position.x - BOX_WIDTH, position.y - BOX_HEIGHT);
    const [toX, toY] = BoxGrid.cell(position.x + BOX_WIDTH, position.y + BOX_HEIGHT);
    for (let cx = fromX; cx <= toX; cx += 1) {
      for (let cy = fromY; cy <= toY; cy += 1) {
        if (this.cells.get(`${cx},${cy}`)?.some((other) => overlap(position, other))) return false;
      }
    }
    return true;
  }
}

function* ring(centre: Position, radius: number): Generator<Position> {
  if (radius === 0) {
    yield centre;
    return;
  }
  const count = Math.max(8, Math.ceil((2 * Math.PI * radius) / SEARCH_STEP));
  for (let index = 0; index < count; index += 1) {
    const angle = (2 * Math.PI * index) / count;
    yield { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
  }
}

function nearestFree(grid: BoxGrid, start: Position, accept: (candidate: Position) => boolean, limit: number): Position | undefined {
  for (let radius = 0; radius <= limit; radius += SEARCH_STEP) {
    for (const candidate of ring(start, radius)) if (accept(candidate) && grid.free(candidate)) return candidate;
  }
  return undefined;
}

type Kind = 'fixed' | 'new' | 'loner';

interface Step {
  readonly id: string;
  readonly kind: Kind;
}

/** Entities next to something that already has a position first, then the ones joined to those, then the seed of each group that touches nothing placed. */
function sequenceOf(free: readonly string[], known: ReadonlyMap<string, Position>, neighbours: ReadonlyMap<string, readonly string[]>): Step[] {
  const isFree = new Set(free);
  const queued = new Set<string>();
  const steps: Step[] = [];
  const queue: string[] = [];
  const enqueue = (id: string, kind: Kind): void => {
    queued.add(id);
    steps.push({ id, kind });
    queue.push(id);
  };
  for (const id of free) if ((neighbours.get(id) ?? []).some((other) => known.has(other))) enqueue(id, 'fixed');
  const spread = (): void => {
    for (let at = 0; at < queue.length; at += 1) {
      for (const other of neighbours.get(queue[at] ?? '') ?? []) if (isFree.has(other) && !queued.has(other)) enqueue(other, 'new');
    }
  };
  spread();
  for (const id of free) {
    if (queued.has(id)) continue;
    enqueue(id, 'loner');
    spread();
  }
  return steps;
}

function seeds(steps: readonly Step[], known: ReadonlyMap<string, Position>, neighbours: ReadonlyMap<string, readonly string[]>, row: (index: number) => Position): Map<string, Position> {
  const current = new Map<string, Position>();
  const positionOf = (id: string): Position | undefined => known.get(id) ?? current.get(id);
  let loners = 0;
  steps.forEach(({ id, kind }, at) => {
    if (kind === 'loner') {
      current.set(id, row(loners));
      loners += 1;
      return;
    }
    const angle = at * GOLDEN_ANGLE;
    const middle = centroid((neighbours.get(id) ?? []).flatMap((other) => positionOf(other) ?? []));
    current.set(id, { x: middle.x + SEED_OFFSET * Math.cos(angle), y: middle.y + SEED_OFFSET * Math.sin(angle) });
  });
  return current;
}

function relax(ids: readonly string[], movable: readonly string[], known: ReadonlyMap<string, Position>, neighbours: ReadonlyMap<string, readonly string[]>, current: Map<string, Position>, pushReach: number): void {
  const index = new Map(ids.map((id, at) => [id, at]));
  const xs = new Float64Array(ids.length);
  const ys = new Float64Array(ids.length);
  ids.forEach((id, at) => {
    const position = current.get(id) ?? known.get(id);
    xs[at] = position?.x ?? 0;
    ys[at] = position?.y ?? 0;
  });
  const moving = movable.flatMap((id) => index.get(id) ?? []);
  const joined = moving.map((at) => (neighbours.get(ids[at] ?? '') ?? []).flatMap((other) => index.get(other) ?? []));
  const squared = IDEAL_LENGTH * IDEAL_LENGTH;
  const dxs = new Float64Array(moving.length);
  const dys = new Float64Array(moving.length);
  for (let step = 0; step < FORCE_STEPS; step += 1) {
    const temperature = (IDEAL_LENGTH / 2) * (1 - step / FORCE_STEPS);
    moving.forEach((at, slot) => {
      const hereX = xs[at] ?? 0;
      const hereY = ys[at] ?? 0;
      let dx = 0;
      let dy = 0;
      for (let other = 0; other < xs.length; other += 1) {
        if (other === at) continue;
        const gapX = hereX - (xs[other] ?? 0);
        const gapY = hereY - (ys[other] ?? 0);
        const apart = gapX * gapX + gapY * gapY;
        if (apart > pushReach * pushReach) continue;
        const push = squared / Math.max(apart, 1);
        dx += gapX * push;
        dy += gapY * push;
      }
      for (const other of joined[slot] ?? []) {
        const gapX = hereX - (xs[other] ?? 0);
        const gapY = hereY - (ys[other] ?? 0);
        const pull = Math.hypot(gapX, gapY) / IDEAL_LENGTH;
        dx -= gapX * pull;
        dy -= gapY * pull;
      }
      dxs[slot] = dx;
      dys[slot] = dy;
    });
    moving.forEach((at, slot) => {
      const dx = dxs[slot] ?? 0;
      const dy = dys[slot] ?? 0;
      const length = Math.hypot(dx, dy);
      if (length === 0) return;
      const travel = Math.min(length, temperature);
      xs[at] = (xs[at] ?? 0) + (dx / length) * travel;
      ys[at] = (ys[at] ?? 0) + (dy / length) * travel;
    });
  }
  for (const at of moving) current.set(ids[at] ?? '', { x: xs[at] ?? 0, y: ys[at] ?? 0 });
}

/** The cells of the block of isolated entities are a box apart and a hair more, so that a sum that comes out a hair short never reads as an overlap. */
const CELL_WIDTH = BOX_WIDTH + 0.01;
const CELL_HEIGHT = BOX_HEIGHT + 0.01;

const isolatedAmong = (ids: readonly string[], neighbours: ReadonlyMap<string, readonly string[]>): Set<string> => new Set(ids.filter((id) => (neighbours.get(id) ?? []).length === 0));

/** A compact block, roughly square in model units, to the right of the connected part and level with its top, one box per cell and in the loaded order, filled column by column; a cell another box holds goes to the nearest free spot to its right. */
function blockRight(grid: BoxGrid, isolated: readonly string[], among: readonly Position[]): Map<string, Position> {
  const placed = new Map<string, Position>();
  if (isolated.length === 0) return placed;
  const rows = Math.ceil(Math.sqrt((isolated.length * BOX_WIDTH) / BOX_HEIGHT));
  const left = among.length === 0 ? 0 : among.reduce((edge, point) => Math.max(edge, point.x), -Infinity) + CELL_WIDTH;
  const top = among.length === 0 ? 0 : among.reduce((edge, point) => Math.min(edge, point.y), Infinity);
  isolated.forEach((id, index) => {
    const wanted = { x: left + Math.floor(index / rows) * CELL_WIDTH, y: top + (index % rows) * CELL_HEIGHT };
    const spot = grid.free(wanted) ? wanted : (nearestFree(grid, wanted, (candidate) => candidate.x >= left, SEARCH_LIMIT) ?? wanted);
    grid.add(spot);
    placed.set(id, spot);
  });
  return placed;
}

const spiral = (index: number): Position => ({ x: SPIRAL_STEP * Math.sqrt(index + 1) * Math.cos(index * GOLDEN_ANGLE), y: SPIRAL_STEP * Math.sqrt(index + 1) * Math.sin(index * GOLDEN_ANGLE) });

const TOUCH = 1e-6;

/** The nearest point to the centre, inside the reach, where a box overlaps no other: the boxes around it forbid open rectangles, so the nearest free point lies on the edge of one of them, level with the centre or at a corner of two, and those are the only points tried. */
function freeWithinReach(grid: BoxGrid, centre: Position): Position | undefined {
  const around = grid.near(centre, NEIGHBOUR_REACH + BOX_WIDTH, NEIGHBOUR_REACH + BOX_HEIGHT);
  const xs = [centre.x, ...around.flatMap((other) => [other.x - BOX_WIDTH, other.x + BOX_WIDTH, other.x - BOX_WIDTH - TOUCH, other.x + BOX_WIDTH + TOUCH])];
  const ys = [centre.y, ...around.flatMap((other) => [other.y - BOX_HEIGHT, other.y + BOX_HEIGHT, other.y - BOX_HEIGHT - TOUCH, other.y + BOX_HEIGHT + TOUCH])];
  let best: Position | undefined;
  let bestDistance = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const gap = Math.hypot(x - centre.x, y - centre.y);
      if (gap > NEIGHBOUR_REACH || gap > bestDistance) continue;
      if (gap === bestDistance && best !== undefined && (x > best.x || (x === best.x && y >= best.y))) continue;
      const candidate = { x, y };
      if (!grid.free(candidate)) continue;
      best = candidate;
      bestDistance = gap;
    }
  }
  return best;
}

function withinReachOf(grid: BoxGrid, wanted: Position, centre: Position): Position {
  const reach = distance(wanted, centre);
  const start = reach <= NEIGHBOUR_REACH ? wanted : { x: centre.x + ((wanted.x - centre.x) * NEIGHBOUR_REACH) / reach, y: centre.y + ((wanted.y - centre.y) * NEIGHBOUR_REACH) / reach };
  return nearestFree(grid, start, (candidate) => distance(candidate, centre) <= NEIGHBOUR_REACH, 2 * NEIGHBOUR_REACH) ?? freeWithinReach(grid, centre) ?? nearestFree(grid, centre, () => true, SEARCH_LIMIT) ?? wanted;
}

/** The positions of the entities that have none: the others are never read as free, whatever overlaps or stale entries they hold. */
export function placeNewEntities({ ids, links, positions }: PlacementInput): Map<string, Position> {
  const known = new Map(ids.flatMap((id) => {
    const position = positions.get(id);
    return position === undefined ? [] : [[id, position] as const];
  }));
  const free = ids.filter((id) => !known.has(id));
  const placed = new Map<string, Position>();
  if (free.length === 0) return placed;
  const neighbours = neighboursOf(ids, links);
  const anchored = known.size > 0;
  const isolated = anchored ? new Set<string>() : isolatedAmong(free, neighbours);
  const steps = sequenceOf(free.filter((id) => !isolated.has(id)), known, neighbours);
  const bounds = anchored ? boundsOf([...known.values()]) : undefined;
  const rowStart = bounds === undefined ? 0 : bounds.maxX + BOX_WIDTH;
  const row = (index: number): Position => (bounds === undefined ? spiral(index) : { x: rowStart + index * BOX_WIDTH, y: bounds.minY });
  const current = seeds(steps, known, neighbours, row);
  relax(ids.filter((id) => !isolated.has(id)), steps.filter(({ kind }) => kind !== 'loner' || !anchored).map(({ id }) => id), known, neighbours, current, Infinity);
  const grid = new BoxGrid();
  for (const position of known.values()) grid.add(position);
  let rightEdge = bounds?.maxX ?? 0;
  for (const { id, kind } of steps) {
    const wanted = current.get(id) ?? { x: 0, y: 0 };
    const around = (neighbours.get(id) ?? []).flatMap((other) => known.get(other) ?? []);
    const nearbyNew = (neighbours.get(id) ?? []).flatMap((other) => placed.get(other) ?? []);
    let spot: Position;
    if (kind === 'fixed') spot = withinReachOf(grid, wanted, centroid(around));
    else if (kind === 'new' && nearbyNew.length > 0) spot = withinReachOf(grid, wanted, nearbyNew.reduce((nearest, other) => (distance(other, wanted) < distance(nearest, wanted) ? other : nearest)));
    else if (bounds !== undefined) {
      const left = rightEdge + BOX_WIDTH;
      spot = nearestFree(grid, { x: left, y: bounds.minY }, (candidate) => candidate.x >= left, SEARCH_LIMIT) ?? wanted;
    } else spot = nearestFree(grid, wanted, () => true, SEARCH_LIMIT) ?? wanted;
    grid.add(spot);
    placed.set(id, spot);
    rightEdge = Math.max(rightEdge, spot.x);
  }
  for (const [id, spot] of blockRight(grid, free.filter((id) => isolated.has(id)), [...placed.values()])) placed.set(id, spot);
  return new Map(free.map((id) => [id, placed.get(id) ?? { x: 0, y: 0 }]));
}

export interface LayoutInput extends PlacementInput {
  readonly pinned: ReadonlySet<string>;
}

const shifted = (position: Position, by: Position): Position => ({ x: position.x + by.x, y: position.y + by.y });

/**
 * A new arrangement of every entity that is not pinned, from the keys, the relationships and the pinned entities' positions only, so that the positions the entities had do not matter except through their centroid.
 * With nothing pinned the arrangement ends with its centroid where the old one was; with pinned entities it is moved there first and then cleared off them, which takes priority.
 */
export function layoutEntities({ ids, links, positions, pinned }: LayoutInput): Map<string, Position> {
  const fixed = new Map(ids.flatMap((id) => {
    const position = positions.get(id);
    return pinned.has(id) && position !== undefined ? [[id, position] as const] : [];
  }));
  const free = ids.filter((id) => !fixed.has(id));
  if (free.length === 0) return new Map();
  const neighbours = neighboursOf(ids, links);
  const isolatedAll = isolatedAmong(ids, neighbours);
  const isolated = new Set(free.filter((id) => isolatedAll.has(id)));
  const movers = free.filter((id) => !isolated.has(id));
  const steps = sequenceOf(movers, fixed, neighbours);
  const current = seeds(steps, fixed, neighbours, spiral);
  relax(ids.filter((id) => !isolatedAll.has(id)), movers, fixed, neighbours, current, REPULSION_REACH);
  const connectedFixed = [...fixed].filter(([id]) => !isolatedAll.has(id)).map(([, position]) => position);
  const centreShift = (): Position => {
    const was = centroid(free.flatMap((id) => positions.get(id) ?? []));
    const connected = [...movers.map((id) => current.get(id) ?? { x: 0, y: 0 }), ...connectedFixed];
    const block = blockRight(new BoxGrid(), [...isolated], connected);
    const now = centroid([...movers.map((id) => current.get(id) ?? { x: 0, y: 0 }), ...block.values()]);
    return { x: was.x - now.x, y: was.y - now.y };
  };
  if (fixed.size > 0 && movers.length > 0 && free.some((id) => positions.has(id))) {
    const by = centreShift();
    for (const id of movers) current.set(id, shifted(current.get(id) ?? { x: 0, y: 0 }, by));
  }
  const grid = new BoxGrid();
  for (const position of fixed.values()) grid.add(position);
  const cleared = new Map<string, Position>();
  for (const { id } of steps) {
    const wanted = current.get(id) ?? { x: 0, y: 0 };
    const spot = nearestFree(grid, wanted, () => true, SEARCH_LIMIT) ?? wanted;
    grid.add(spot);
    cleared.set(id, spot);
  }
  const among = [...cleared.values(), ...[...fixed].filter(([id]) => (neighbours.get(id) ?? []).length > 0).map(([, position]) => position)];
  for (const [id, spot] of blockRight(grid, free.filter((id) => isolated.has(id)), among)) cleared.set(id, spot);
  if (fixed.size === 0) {
    const was = free.flatMap((id) => positions.get(id) ?? []);
    const wasCentroid = was.length === 0 ? undefined : centroid(was);
    const now = centroid([...cleared.values()]);
    const by = wasCentroid === undefined ? { x: 0, y: 0 } : { x: wasCentroid.x - now.x, y: wasCentroid.y - now.y };
    for (const [id, position] of cleared) cleared.set(id, shifted(position, by));
  }
  return new Map(free.map((id) => [id, cleared.get(id) ?? { x: 0, y: 0 }]));
}
