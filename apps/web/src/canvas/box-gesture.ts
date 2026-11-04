import type { Position } from '../state/presentation-state.js';
import { boxBetween, entitiesInBox, type BoxSelection } from './box-selection.js';
import type { Box } from './fit.js';

/** What the gesture draws while it runs; the DOM implementation is in `box-overlay.ts`. */
export interface BoxOverlay {
  show(box: Box): void;
  hide(): void;
}

export interface BoxGesture {
  /** Starts a box at a point of the canvas, in screen coordinates of the canvas element. */
  start(at: Position, shift: boolean): void;
  move(at: Position): void;
  /** Ends the box; it selects when it has an area. A press and release in one place is a click and selects nothing here. */
  end(at: Position): void;
  /** Drops the box with no effect. */
  cancel(): void;
  readonly active: boolean;
}

export interface BoxGestureOptions {
  readonly overlay: BoxOverlay;
  /** The centres of the drawn entities in the same coordinates as the points. */
  readonly centres: () => ReadonlyMap<string, Position>;
  readonly select: (box: BoxSelection) => void;
}

export function createBoxGesture(options: BoxGestureOptions): BoxGesture {
  let origin: Position | undefined;
  let shift = false;
  const finish = (): void => {
    origin = undefined;
    options.overlay.hide();
  };
  return {
    get active() {
      return origin !== undefined;
    },
    start(at, withShift) {
      origin = at;
      shift = withShift;
    },
    move(at) {
      if (origin !== undefined) options.overlay.show(boxBetween(origin, at));
    },
    end(at) {
      if (origin === undefined) return;
      const started = origin;
      finish();
      if (at.x === started.x && at.y === started.y) return;
      options.select({ ids: entitiesInBox(options.centres(), boxBetween(started, at)), shift });
    },
    cancel() {
      finish();
    },
  };
}
