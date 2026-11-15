export type SnapshotFailure = 'empty' | 'not-mounted';

export class SnapshotUnavailable extends Error {
  readonly reason: SnapshotFailure;

  constructor(reason: SnapshotFailure) {
    super(`no picture can be made: ${reason}`);
    this.reason = reason;
  }
}

/** The largest picture a caller can take: neither side, and not the number of pixels, may go over. */
export interface SnapshotBounds {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxArea: number;
}

/** Twice the page's own size, so the picture stays sharp when it is zoomed. */
const PICTURE_SCALE = 2;

/** The scale at which a drawing of this size fits the bounds, at most `PICTURE_SCALE`. */
export function snapshotScale(drawing: { readonly width: number; readonly height: number }, bounds: SnapshotBounds): number {
  const width = Math.max(drawing.width, 1);
  const height = Math.max(drawing.height, 1);
  return Math.min(PICTURE_SCALE, bounds.maxWidth / width, bounds.maxHeight / height, Math.sqrt(bounds.maxArea / (width * height)));
}
