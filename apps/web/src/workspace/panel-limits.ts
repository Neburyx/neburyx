export const PANEL_INITIAL_WIDTH = 320;
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 480;
export const PANEL_GAP = 16;
export const PANEL_RAIL_WIDTH = 40;
export const PANEL_KEY_STEP = 16;
export const PANEL_KEY_STEP_SHIFT = 64;

export interface WidthLimits {
  readonly min: number;
  readonly max: number;
}

/** The maximum wins when the space left is below the minimum, so a narrow window never makes a panel wider than it can be. A width that has not been measured yet puts no limit on the space. */
function limitsIn(space: number | undefined, widest: number = PANEL_MAX_WIDTH): WidthLimits {
  const max = Math.max(0, Math.min(widest, Math.floor(space ?? Infinity)));
  return { min: Math.min(PANEL_MIN_WIDTH, max), max };
}

/** Half of the workspace less the two gaps beside the panel, so at least half of the workspace stays canvas; a panel may name a widest width of its own in place of the usual one. */
export function dockLimits(workspaceWidth: number | undefined, widest?: number): WidthLimits {
  return limitsIn(workspaceWidth === undefined ? undefined : Math.floor(workspaceWidth / 2) - 2 * PANEL_GAP, widest);
}

/** The canvas less the distance from the side the panel hangs from and the gap on its other side; a panel may name a widest width of its own in place of the usual one. */
export function floatingLimits(canvasWidth: number | undefined, inset: number = PANEL_GAP, widest?: number, held: { readonly reserve: number; readonly floor: number } = { reserve: 0, floor: 0 }): WidthLimits {
  if (canvasWidth === undefined) return limitsIn(undefined, widest);
  const room = canvasWidth - inset - PANEL_GAP;
  // `held`: the room other panels need (the left panels, an inspector beside) is taken from how wide the panel may be made, never from below the width it opens at (`floor`), so a window with no room is left as it was
  return limitsIn(Math.max(room - held.reserve, Math.min(room, held.floor)), widest);
}

/** A share of the window's width, rounded down to a whole pixel because a stored width is whole; undefined (the usual widest applies) for a share outside 0 to 1 or a window that is not measured. */
export function windowShareWidth(share: number | undefined, windowWidth: number | undefined): number | undefined {
  if (share === undefined || windowWidth === undefined || !(share > 0 && share <= 1) || !(windowWidth > 0)) return undefined;
  return Math.floor(share * windowWidth);
}

export interface CanvasBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Where a panel that spans `span` across the canvas starts so that it covers none of `obstacles`: its top moves down to a gap below the lowest obstacle it would overlap horizontally, and stays where it is when none is in the way. */
export function topBelowObstacles(top: number, span: { readonly left: number; readonly right: number }, obstacles: readonly CanvasBox[]): number {
  const crossing = obstacles.filter((box) => span.left < box.right && box.left < span.right && top < box.bottom);
  return crossing.reduce((lowest, box) => Math.max(lowest, box.bottom + PANEL_GAP), top);
}

/** Where a floating panel starts and how high it may be: below its top offset and 16 px above the canvas's bottom, the offset yielding so that the collapsed bar still fits inside the canvas. Unmeasured, it puts no limit on the height. */
export function floatingPlacement(top: number, canvasHeight: number | undefined): { readonly top: number; readonly maxHeight: number | undefined } {
  if (canvasHeight === undefined) return { top, maxHeight: undefined };
  const yielded = Math.max(0, Math.min(top, canvasHeight - PANEL_GAP - PANEL_RAIL_WIDTH));
  return { top: yielded, maxHeight: Math.max(0, canvasHeight - yielded - PANEL_GAP) };
}

export function isPanelSize(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

/** The width a panel is drawn at: the stored width, or the initial one when none was stored or the stored one is not a size, held to the limits of the moment. The stored width itself is never rewritten. */
export function drawnWidth(stored: number | undefined, initial: number, limits: WidthLimits): number {
  const wanted = stored !== undefined && isPanelSize(stored) ? stored : initial;
  return Math.min(limits.max, Math.max(limits.min, wanted));
}
