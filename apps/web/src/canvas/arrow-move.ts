import type { ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import type { Position } from '../state/presentation-state.js';

export const MOVE_STEP = 10;
export const MOVE_STEP_FAR = 50;

export type Schedule = (callback: () => void) => void;

export interface Direction {
  readonly x: -1 | 0 | 1;
  readonly y: -1 | 0 | 1;
}

/** The direction of an arrow key; up is −y, as the canvas's own coordinates are. */
export function directionOf(key: string): Direction | undefined {
  switch (key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 };
    case 'ArrowRight':
      return { x: 1, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -1 };
    case 'ArrowDown':
      return { x: 0, y: 1 };
    default:
      return undefined;
  }
}

const counted = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`;

/** The entities an arrow key would move: the selected ones that are still loaded (one that went between a press and its frame is not one), and the pinned ones among them, which stay. */
function selectedEntities(state: ClientState): { readonly movable: readonly string[]; readonly pinned: number } {
  const { selection, pins, positions } = state.presentation.view.getState();
  const loaded = new Set(state.visibleGraph().nodes.map((node) => elementKey(node.ref)));
  const held = [...selection].filter((key) => loaded.has(key));
  return { movable: held.filter((key) => !pins.has(key) && positions.has(key)), pinned: held.filter((key) => pins.has(key)).length };
}

const pending = new WeakMap<ClientState, { x: number; y: number; scheduled: boolean; fresh: boolean }>();

function flush(state: ClientState): void {
  const sum = pending.get(state);
  if (sum === undefined) return;
  const { x, y, fresh } = sum;
  sum.x = 0;
  sum.y = 0;
  sum.fresh = false;
  sum.scheduled = false;
  const { movable, pinned } = selectedEntities(state);
  const { positions } = state.presentation.view.getState();
  const moved = new Map<string, Position>();
  for (const key of movable) {
    const at = positions.get(key);
    if (at !== undefined) moved.set(key, { x: at.x + x, y: at.y + y });
  }
  const text = `${counted(moved.size, 'entity', 'entities')} moved${pinned === 0 ? '' : `, ${pinned} pinned stayed`}`;
  // a key held down says the same thing once, not at every repeat
  const announcement = fresh || state.presentation.view.getState().moveNote?.text !== text ? text : undefined;
  if (moved.size > 0) state.presentation.setPositions(moved, announcement);
  else if (announcement !== undefined) state.presentation.announceMove(announcement);
}

/** Moves the selected entities by a step in a direction; the presses of one frame are added up and stored once, as one update that also carries what is announced. Returns false, and does nothing, when the key is not for it: the Pan tool, or no selected entity. */
export function moveSelected(state: ClientState, direction: Direction, step: number, schedule: Schedule, repeat: boolean): boolean {
  if (state.presentation.view.getState().tool === 'pan') return false;
  const { movable, pinned } = selectedEntities(state);
  if (movable.length === 0 && pinned === 0) return false;
  const sum = pending.get(state) ?? { x: 0, y: 0, scheduled: false, fresh: false };
  pending.set(state, sum);
  sum.x += direction.x * step;
  sum.y += direction.y * step;
  sum.fresh = sum.fresh || !repeat;
  if (!sum.scheduled) {
    sum.scheduled = true;
    schedule(() => flush(state));
  }
  return true;
}
