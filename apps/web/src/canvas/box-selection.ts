import type { Position } from '../state/presentation-state.js';
import type { Box } from './fit.js';

export interface BoxSelection {
  readonly ids: readonly string[];
  readonly shift: boolean;
}

/** The corners of a drag in any direction, as a box. */
export function boxBetween(from: Position, to: Position): Box {
  return { x1: Math.min(from.x, to.x), y1: Math.min(from.y, to.y), x2: Math.max(from.x, to.x), y2: Math.max(from.y, to.y) };
}

/** The entities whose centre lies in the box, the edge included. */
export function entitiesInBox(centres: ReadonlyMap<string, Position>, box: Box): string[] {
  return [...centres].filter(([, at]) => at.x >= box.x1 && at.x <= box.x2 && at.y >= box.y1 && at.y <= box.y2).map(([id]) => id);
}

/** What a box leads to: with Shift the entities inside are added, without it they replace the selection; undefined when nothing would change. */
export function selectionAfterBox(selection: ReadonlySet<string>, box: BoxSelection): readonly string[] | undefined {
  if (box.shift) {
    const added = box.ids.filter((id) => !selection.has(id));
    return added.length === 0 ? undefined : [...selection, ...added];
  }
  const same = box.ids.length === selection.size && box.ids.every((id) => selection.has(id));
  return same ? undefined : box.ids;
}
