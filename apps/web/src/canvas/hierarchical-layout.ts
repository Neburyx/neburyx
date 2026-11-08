import type { Position } from '../state/presentation-state.js';
import type { LayoutDirection } from '../state/layout-choice.js';
import { gridLayout } from './grid-layout.js';
import { clearOfFixed } from './incremental-layout.js';
import { BOX_HEIGHT, BOX_WIDTH, LAYER_GAP, LAYER_SIBLING_GAP } from './layout-constants.js';

export interface HierarchicalInput {
  /** Every shown entity, in the loaded order. */
  readonly ids: readonly string[];
  /** Directed relationships between shown entities, from source to target. */
  readonly links: readonly (readonly [string, string])[];
  readonly fixed: ReadonlyMap<string, Position>;
  readonly direction: LayoutDirection;
  /** Where the middle of the arrangement goes. */
  readonly centre: Position;
}

export interface Layers {
  readonly layerOf: ReadonlyMap<string, number>;
  /** The entities of each layer, in their order along the layer. */
  readonly layers: readonly (readonly string[])[];
}

const SWEEPS = 6;

/** The relationships that run forward once cycles are broken: a depth-first walk in the loaded order drops every edge that closes a cycle, and self-loops. */
function acyclic(ids: readonly string[], links: HierarchicalInput['links']): Map<string, string[]> {
  const known = new Set(ids);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of links) if (from !== to && known.has(from) && known.has(to) && !out.get(from)?.includes(to)) out.get(from)?.push(to);
  const state = new Map<string, 'open' | 'done'>();
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const targets = out.get(top.id) ?? [];
      if (top.next >= targets.length) {
        state.set(top.id, 'done');
        stack.pop();
        continue;
      }
      const target = targets[top.next] ?? '';
      top.next += 1;
      if (state.get(target) === 'open') continue;
      forward.get(top.id)?.push(target);
      if (!state.has(target)) {
        state.set(target, 'open');
        stack.push({ id: target, next: 0 });
      }
    }
  }
  return forward;
}

/** Crossings between relationships that join adjacent layers, given the order along each layer. */
export function countCrossings(layers: readonly (readonly string[])[], forward: ReadonlyMap<string, readonly string[]>): number {
  const at = new Map<string, number>();
  const layerOf = new Map<string, number>();
  layers.forEach((layer, index) => layer.forEach((id, order) => {
    at.set(id, order);
    layerOf.set(id, index);
  }));
  let crossings = 0;
  for (let index = 0; index + 1 < layers.length; index += 1) {
    const pairs: [number, number][] = [];
    for (const id of layers[index] ?? []) for (const target of forward.get(id) ?? []) if (layerOf.get(target) === index + 1) pairs.push([at.get(id) ?? 0, at.get(target) ?? 0]);
    for (let a = 0; a < pairs.length; a += 1) {
      for (let b = a + 1; b < pairs.length; b += 1) {
        const first = pairs[a] ?? [0, 0];
        const second = pairs[b] ?? [0, 0];
        if ((first[0] - second[0]) * (first[1] - second[1]) < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

/** Longest-path layers of the connected entities, ordered along each layer by sweeping the mean position of the neighbors in the next layer inward and outward, and kept only if it crosses no more than the loaded order. */
export function layersOf(ids: readonly string[], links: HierarchicalInput['links']): Layers & { readonly forward: ReadonlyMap<string, readonly string[]> } {
  const forward = acyclic(ids, links);
  const joined = new Set<string>();
  for (const [from, targets] of forward) {
    for (const target of targets) {
      joined.add(from);
      joined.add(target);
    }
  }
  const members = ids.filter((id) => joined.has(id));
  const backward = new Map<string, string[]>(members.map((id) => [id, []]));
  for (const [from, targets] of forward) for (const target of targets) backward.get(target)?.push(from);
  const layerOf = new Map<string, number>();
  const level = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    const value = Math.max(-1, ...(backward.get(id) ?? []).map(level)) + 1;
    layerOf.set(id, value);
    return value;
  };
  for (const id of members) level(id);
  const count = Math.max(-1, ...layerOf.values()) + 1;
  const loaded: string[][] = Array.from({ length: count }, () => []);
  for (const id of members) loaded[layerOf.get(id) ?? 0]?.push(id);
  let best = loaded.map((layer) => [...layer]);
  let bestCrossings = countCrossings(best, forward);
  let current = loaded.map((layer) => [...layer]);
  const index = (): Map<string, number> => new Map(current.flatMap((layer) => layer.map((id, order) => [id, order] as const)));
  const sweep = (layer: number, neighbours: (id: string) => readonly string[]): void => {
    const where = index();
    const keyed = (current[layer] ?? []).map((id, order) => {
      const around = neighbours(id).filter((other) => layerOf.get(other) !== layer);
      const mean = around.length === 0 ? order : around.reduce((sum, other) => sum + (where.get(other) ?? 0), 0) / around.length;
      return { id, mean, order };
    });
    keyed.sort((a, b) => a.mean - b.mean || a.order - b.order);
    current[layer] = keyed.map(({ id }) => id);
  };
  for (let round = 0; round < SWEEPS; round += 1) {
    for (let layer = 1; layer < count; layer += 1) sweep(layer, (id) => backward.get(id) ?? []);
    for (let layer = count - 2; layer >= 0; layer -= 1) sweep(layer, (id) => forward.get(id) ?? []);
    const crossings = countCrossings(current, forward);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = current.map((layer) => [...layer]);
    }
    if (crossings === 0) break;
  }
  return { layerOf, layers: best, forward };
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Every entity joined to another sits in a layer, relationships pointing down (or right); the others make a block beside the layers. Entities in `fixed` keep their positions and the others are cleared off them. */
export function hierarchicalLayout({ ids, links, fixed, direction, centre }: HierarchicalInput): Map<string, Position> {
  const { layers } = layersOf(ids, links);
  const down = direction === 'down';
  const wide = down ? BOX_WIDTH + LAYER_SIBLING_GAP : BOX_HEIGHT + LAYER_SIBLING_GAP;
  const deep = down ? BOX_HEIGHT + LAYER_GAP : BOX_WIDTH + LAYER_GAP;
  const wanted = new Map<string, Position>();
  layers.forEach((layer, depth) => layer.forEach((id, order) => {
    const along = (order - (layer.length - 1) / 2) * wide;
    wanted.set(id, down ? { x: along, y: depth * deep } : { x: depth * deep, y: along });
  }));
  const layered = new Set(wanted.keys());
  const alone = ids.filter((id) => !layered.has(id));
  const points = [...wanted.values()];
  if (alone.length > 0) {
    const block = gridLayout({ free: alone.filter((id) => !fixed.has(id)), fixed: new Map(), centre: { x: 0, y: 0 } });
    const span = [...block.values()];
    const edgeX = points.length === 0 ? 0 : Math.max(...points.map((point) => point.x)) + BOX_WIDTH + LAYER_SIBLING_GAP;
    const edgeY = points.length === 0 ? 0 : Math.max(...points.map((point) => point.y)) + BOX_HEIGHT + LAYER_SIBLING_GAP;
    const lowX = span.length === 0 ? 0 : Math.min(...span.map((point) => point.x));
    const lowY = span.length === 0 ? 0 : Math.min(...span.map((point) => point.y));
    const topY = points.length === 0 ? 0 : Math.min(...points.map((point) => point.y));
    const leftX = points.length === 0 ? 0 : Math.min(...points.map((point) => point.x));
    for (const [id, spot] of block) wanted.set(id, down ? { x: edgeX + spot.x - lowX, y: topY + spot.y - lowY } : { x: leftX + spot.x - lowX, y: edgeY + spot.y - lowY });
  }
  const all = [...wanted.values()];
  const by = all.length === 0 ? { x: 0, y: 0 } : { x: centre.x - mean(all.map((point) => point.x)), y: centre.y - mean(all.map((point) => point.y)) };
  const moved = new Map([...wanted].map(([id, spot]) => [id, { x: spot.x + by.x, y: spot.y + by.y }] as const));
  const free = ids.filter((id) => !fixed.has(id));
  return clearOfFixed(free, moved, fixed);
}
