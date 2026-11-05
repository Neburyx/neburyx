import type { Position, Viewport } from '../state/presentation-state.js';

export const READOUT_MARKER = 'neburyx-dev-canvas-readout';
export const MARK_EVENT = 'neburyx-dev-mark';
/** The name of the function a development canvas element gets for reading where each entity is drawn, so a recorded browser run can read a stored position back. */
export const READ_POSITIONS = 'readDrawnPositions';
/** The name of the function a development canvas element gets for reading what the renderer has drawn (each entity's caption shown or not, each relationship's label), so a recorded browser run can see the zoomed-out view. */
export const INSPECT_DRAWING = 'inspectDrawing';

export interface Readout {
  readonly entities: number;
  readonly relationships: number;
  readonly viewport: Viewport;
  /** Where the renderer drew each entity, and which entities are pinned; given with a draw, not with a viewport report. */
  readonly drawn?: { readonly positions: ReadonlyMap<string, Position>; readonly pinned: ReadonlySet<string>; readonly focused?: string | undefined };
}

export interface Moved {
  readonly pinned: number;
  readonly unpinned: number;
  readonly ids: readonly string[];
}

/** How many of the marked entities are drawn elsewhere now, or no longer drawn, the pinned and the unpinned counted apart. */
export function movedSince(mark: ReadonlyMap<string, Position>, positions: ReadonlyMap<string, Position>, pinned: ReadonlySet<string>): Moved {
  let movedPinned = 0;
  let movedUnpinned = 0;
  const ids: string[] = [];
  for (const [id, before] of mark) {
    const now = positions.get(id);
    if (now !== undefined && now.x === before.x && now.y === before.y) continue;
    ids.push(id);
    if (pinned.has(id)) movedPinned += 1;
    else movedUnpinned += 1;
  }
  return { pinned: movedPinned, unpinned: movedUnpinned, ids };
}

interface Held {
  positions: ReadonlyMap<string, Position>;
  pinned: ReadonlySet<string>;
  mark: ReadonlyMap<string, Position> | undefined;
}

const held = new WeakMap<HTMLElement, Held>();

function listen(element: HTMLElement): Held {
  const existing = held.get(element);
  if (existing !== undefined) return existing;
  const created: Held = { positions: new Map(), pinned: new Set(), mark: undefined };
  held.set(element, created);
  Reflect.set(element, READ_POSITIONS, () => Object.fromEntries(created.positions));
  element.addEventListener(MARK_EVENT, () => {
    created.mark = new Map(created.positions);
    reportMoved(element, created);
  });
  return created;
}

function reportMoved(element: HTMLElement, state: Held): void {
  if (state.mark === undefined) return;
  const moved = movedSince(state.mark, state.positions, state.pinned);
  element.dataset['markedEntities'] = String(state.mark.size);
  element.dataset['movedPinned'] = String(moved.pinned);
  element.dataset['movedUnpinned'] = String(moved.unpinned);
  element.dataset['movedIds'] = JSON.stringify(moved.ids);
}

/** Development builds only: puts what the renderer itself drew and where it is looking on the canvas element, so a measurement can tell a drawing from a page that only loaded the records; a mark event keeps where every entity was drawn, and the counts of those drawn elsewhere afterwards stay on the element across later redraws until the next mark. */
export function writeReadout(element: HTMLElement, readout: Readout): void {
  const state = listen(element);
  element.dataset['devReadout'] = READOUT_MARKER;
  element.dataset['drawnEntities'] = String(readout.entities);
  element.dataset['drawnRelationships'] = String(readout.relationships);
  element.dataset['zoom'] = String(readout.viewport.zoom);
  element.dataset['panX'] = String(readout.viewport.x);
  element.dataset['panY'] = String(readout.viewport.y);
  if (readout.drawn === undefined) return;
  if (readout.drawn.focused === undefined) delete element.dataset['focusedElement'];
  else element.dataset['focusedElement'] = readout.drawn.focused;
  state.positions = readout.drawn.positions;
  state.pinned = readout.drawn.pinned;
  reportMoved(element, state);
}
