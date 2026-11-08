import type { Position } from '../state/presentation-state.js';
import { gridLayout } from './grid-layout.js';
import { clearOfFixed } from './incremental-layout.js';
import { BOX_WIDTH, RING_BOX_GAP, RING_GAP } from './layout-constants.js';

export interface RadialInput {
  /** Every shown entity, in the loaded order. */
  readonly ids: readonly string[];
  readonly links: readonly (readonly [string, string])[];
  readonly fixed: ReadonlyMap<string, Position>;
  /** The selected shown entities, in selection order. */
  readonly selected: readonly string[];
  /** Where the middle goes when the chosen centre is not pinned. */
  readonly centre: Position;
}

const CHORD = BOX_WIDTH + RING_BOX_GAP;
const RING_STEP = BOX_WIDTH + RING_GAP;

function adjacency(ids: readonly string[], links: RadialInput['links']): Map<string, string[]> {
  const known = new Set(ids);
  const around = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const [from, to] of links) {
    if (from === to || !known.has(from) || !known.has(to)) continue;
    around.get(from)?.add(to);
    around.get(to)?.add(from);
  }
  return new Map([...around].map(([id, set]) => [id, [...set]]));
}

/** The first selected shown entity, else the one with the most neighbors (ties: the lowest key). */
export function centreOf(ids: readonly string[], links: RadialInput['links'], selected: readonly string[]): string | undefined {
  const shown = new Set(ids);
  const chosen = selected.find((id) => shown.has(id));
  if (chosen !== undefined) return chosen;
  const around = adjacency(ids, links);
  let best: string | undefined;
  for (const id of ids) {
    const degree = around.get(id)?.length ?? 0;
    const bestDegree = best === undefined ? -1 : (around.get(best)?.length ?? 0);
    if (degree > bestDegree || (degree === bestDegree && best !== undefined && id < best)) best = id;
  }
  return best;
}

/** The chosen centre in the middle, its neighbors on the first ring, theirs on the second and so on; a ring is as wide as its boxes need, and the entities with no path to the centre make a block outside the last ring. */
export function radialLayout({ ids, links, fixed, selected, centre }: RadialInput): Map<string, Position> {
  const middle = centreOf(ids, links, selected);
  if (middle === undefined) return new Map();
  const around = adjacency(ids, links);
  const hops = new Map<string, number>([[middle, 0]]);
  const queue = [middle];
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at] ?? '';
    for (const other of around.get(id) ?? []) {
      if (hops.has(other)) continue;
      hops.set(other, (hops.get(id) ?? 0) + 1);
      queue.push(other);
    }
  }
  const origin = fixed.get(middle) ?? centre;
  const wanted = new Map<string, Position>([[middle, origin]]);
  const angles = new Map<string, number>();
  const depth = Math.max(0, ...hops.values());
  let previous = 0;
  for (let ring = 1; ring <= depth; ring += 1) {
    const members = ids.filter((id) => hops.get(id) === ring);
    const desired = new Map(members.map((id, order) => {
      const parents = (around.get(id) ?? []).filter((other) => hops.get(other) === ring - 1 && angles.has(other));
      const x = parents.reduce((sum, other) => sum + Math.cos(angles.get(other) ?? 0), 0);
      const y = parents.reduce((sum, other) => sum + Math.sin(angles.get(other) ?? 0), 0);
      return [id, { angle: parents.length === 0 ? 0 : Math.atan2(y, x), order }] as const;
    }));
    members.sort((a, b) => (desired.get(a)?.angle ?? 0) - (desired.get(b)?.angle ?? 0) || (desired.get(a)?.order ?? 0) - (desired.get(b)?.order ?? 0));
    const needed = members.length < 2 ? 0 : (CHORD * 1.001) / (2 * Math.sin(Math.PI / members.length));
    previous = Math.max(previous + RING_STEP, needed);
    const start = ring === 1 ? 0 : (desired.get(members[0] ?? '')?.angle ?? 0);
    members.forEach((id, at) => {
      const angle = start + (2 * Math.PI * at) / members.length;
      angles.set(id, angle);
      wanted.set(id, { x: origin.x + previous * Math.cos(angle), y: origin.y + previous * Math.sin(angle) });
    });
  }
  const alone = ids.filter((id) => !hops.has(id) && !fixed.has(id));
  if (alone.length > 0) {
    const block = gridLayout({ free: alone, fixed: new Map(), centre: { x: 0, y: 0 } });
    const span = [...block.values()];
    const lowX = Math.min(...span.map((point) => point.x));
    const lowY = Math.min(...span.map((point) => point.y));
    const left = origin.x + previous + BOX_WIDTH + RING_GAP;
    const top = origin.y - previous;
    for (const [id, spot] of block) wanted.set(id, { x: left + spot.x - lowX, y: top + spot.y - lowY });
  }
  return clearOfFixed(ids.filter((id) => !fixed.has(id)), wanted, fixed);
}
