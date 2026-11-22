import type { Position } from '../state/presentation-state.js';
import type { Group } from './group-model.js';

/** The places new neighbors are laid out around: a member of a collapsed group counts at its card, the centre of the members that have a place. */
export function placementPositions(positions: ReadonlyMap<string, Position>, groups: readonly Group[]): ReadonlyMap<string, Position> {
  const collapsed = groups.filter((group) => group.collapsed);
  if (collapsed.length === 0) return positions;
  const result = new Map(positions);
  for (const group of collapsed) {
    const held = group.members.flatMap((member) => positions.get(member) ?? []);
    if (held.length === 0) continue;
    const centre = { x: held.reduce((sum, place) => sum + place.x, 0) / held.length, y: held.reduce((sum, place) => sum + place.y, 0) / held.length };
    for (const member of group.members) if (positions.has(member)) result.set(member, centre);
  }
  return result;
}
