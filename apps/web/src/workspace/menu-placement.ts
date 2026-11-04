export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
}

/** The menu opens this far right of and below the pointer, and is kept this far inside the viewport. */
export const POINTER_OFFSET = 8;
export const VIEWPORT_MARGIN = 8;

function along(pointer: number, length: number, available: number): number {
  const after = pointer + POINTER_OFFSET;
  const start = after + length > available - VIEWPORT_MARGIN ? pointer - POINTER_OFFSET - length : after;
  return Math.max(VIEWPORT_MARGIN, Math.min(start, available - VIEWPORT_MARGIN - length));
}

const inside = (length: number, available: number): number => Math.min(length, Math.max(0, available - 2 * VIEWPORT_MARGIN));

/** Opens after the pointer, flips to before it when the menu would leave the viewport on that axis, then holds it inside; a menu larger than the viewport less its margins is placed as if it were that size (the stylesheet limits it to that, and it scrolls). */
export function placeMenu(pointer: Point, size: Size, viewport: Size): Placement {
  return { left: along(pointer.x, inside(size.width, viewport.width), viewport.width), top: along(pointer.y, inside(size.height, viewport.height), viewport.height) };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A submenu opens this far right of its row. */
export const SUBMENU_GAP = 6;

/** Beside the row, to the right, or to the left when that would leave the viewport; held at the margin when neither side fits; level with the row and moved up until its bottom is inside the margin; sized like a menu. */
export function placeSubmenu(row: Rect, size: Size, viewport: Size): Placement {
  const width = inside(size.width, viewport.width);
  const height = inside(size.height, viewport.height);
  const after = row.right + SUBMENU_GAP;
  const start = after + width > viewport.width - VIEWPORT_MARGIN ? row.left - SUBMENU_GAP - width : after;
  return { left: Math.max(VIEWPORT_MARGIN, Math.min(start, viewport.width - VIEWPORT_MARGIN - width)), top: Math.max(VIEWPORT_MARGIN, Math.min(row.top, viewport.height - VIEWPORT_MARGIN - height)) };
}

export const ANCHOR_GAP = 6;

/** Above the control with its right edge level with the control's, below it when it does not fit above and does fit below, then held at the margin; sized like a menu. */
export function placeAbove(anchor: Rect, size: Size, viewport: Size): Placement {
  const width = inside(size.width, viewport.width);
  const height = inside(size.height, viewport.height);
  const above = anchor.top - ANCHOR_GAP - height;
  const below = anchor.bottom + ANCHOR_GAP;
  const top = above >= VIEWPORT_MARGIN || below + height > viewport.height - VIEWPORT_MARGIN ? above : below;
  return { left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.right - width, viewport.width - VIEWPORT_MARGIN - width)), top: Math.max(VIEWPORT_MARGIN, Math.min(top, viewport.height - VIEWPORT_MARGIN - height)) };
}
