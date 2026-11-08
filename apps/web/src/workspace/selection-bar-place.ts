export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Placement {
  /** The bar's left edge and top edge in the region, in pixels; undefined for the left edge when the bar is centred. */
  readonly left: number | undefined;
  readonly top: number;
  /** A width the bar must not exceed, so that its actions wrap: set only when no place is clear at its own width. */
  readonly maxWidth?: number;
  /** Whether the place is clear of every obstacle at the bar's own width; false only for the last resort. */
  readonly clear: boolean;
}

const GAP = 8;
const EDGE = 16;

const crosses = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where the selection bar stands so that it covers none of `obstacles` (the scope lines, the tool strip, the canvas notice, open panels), in this order: centred at its usual height; at its usual height right of the scope lines; below them, centred, then at the left edge, then at the right edge; then along the bottom edge, above the controls there. When none is clear, below the scope lines and right of whatever stands in the way there, with its width capped so that its actions wrap and grow downward.
 * Obstacles with no area are not obstacles.
 */
export function placeSelectionBar(region: { readonly width: number; readonly height: number }, bar: { readonly width: number; readonly height: number }, usualTop: number, scope: Box | undefined, obstacles: readonly Box[]): Placement {
  const real = obstacles.filter((box) => box.right > box.left && box.bottom > box.top);
  const at = (left: number, top: number): Box => ({ left, top, right: left + bar.width, bottom: top + bar.height });
  const clear = (box: Box): boolean => real.every((obstacle) => !crosses(box, obstacle));
  const centred = (region.width - bar.width) / 2;
  if (clear(at(centred, usualTop))) return { left: undefined, top: usualTop, clear: true };
  if (scope !== undefined && scope.right > scope.left) {
    const beside = scope.right + GAP;
    if (beside + bar.width <= region.width - EDGE && clear(at(beside, usualTop))) return { left: beside, top: usualTop, clear: true };
  }
  const below = Math.max(usualTop, (scope?.bottom ?? 0) + GAP);
  for (const left of [centred, EDGE, region.width - EDGE - bar.width]) {
    if (left >= 0 && clear(at(left, below))) return { left: left === centred ? undefined : left, top: below, clear: true };
  }
  const floorLine = real.filter((obstacle) => obstacle.top > region.height / 2).reduce((line, obstacle) => Math.min(line, obstacle.top - GAP), region.height - EDGE);
  const bottom = floorLine - bar.height;
  if (bottom > below) {
    for (const left of [centred, EDGE, region.width - EDGE - bar.width]) {
      if (left >= 0 && clear(at(left, bottom))) return { left: left === centred ? undefined : left, top: bottom, clear: true };
    }
  }
  const band: Box = { left: 0, top: below, right: region.width, bottom: below + bar.height };
  const left = real.filter((obstacle) => crosses(band, obstacle) && obstacle.right < region.width / 2).reduce((edge, obstacle) => Math.max(edge, obstacle.right + GAP), EDGE);
  return { left, top: below, maxWidth: Math.max(0, region.width - left - EDGE), clear: false };
}
