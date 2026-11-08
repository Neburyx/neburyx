import type { Position } from '../state/presentation-state.js';
import { BOX_HEIGHT, BOX_WIDTH, GRID_GAP_X, GRID_GAP_Y } from './layout-constants.js';

export interface GridInput {
  /** The entities to place, in the loaded order. */
  readonly free: readonly string[];
  /** The positions of the entities that stay where they are. */
  readonly fixed: ReadonlyMap<string, Position>;
  /** Where the middle of the grid goes. */
  readonly centre: Position;
}

const CELL_WIDTH = BOX_WIDTH + GRID_GAP_X;
const CELL_HEIGHT = BOX_HEIGHT + GRID_GAP_Y;

const touches = (a: Position, b: Position): boolean => Math.abs(a.x - b.x) < BOX_WIDTH && Math.abs(a.y - b.y) < BOX_HEIGHT;

/** Rows of cells one box and a gap apart, roughly square on the screen, filled row by row in the given order; a cell a fixed entity's box reaches into is left empty. */
export function gridLayout({ free, fixed, centre }: GridInput): Map<string, Position> {
  const placed = new Map<string, Position>();
  if (free.length === 0) return placed;
  const columns = Math.max(1, Math.ceil(Math.sqrt((free.length * CELL_HEIGHT) / CELL_WIDTH)));
  const held = [...fixed.values()];
  const rowsNeeded = Math.ceil(free.length / columns);
  const left = centre.x - ((columns - 1) * CELL_WIDTH) / 2;
  const top = centre.y - ((rowsNeeded - 1) * CELL_HEIGHT) / 2;
  let cell = 0;
  for (const id of free) {
    let spot: Position;
    do {
      spot = { x: left + (cell % columns) * CELL_WIDTH, y: top + Math.floor(cell / columns) * CELL_HEIGHT };
      cell += 1;
    } while (held.some((other) => touches(spot, other)));
    placed.set(id, spot);
  }
  return placed;
}
