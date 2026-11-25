/** How much longer a text may be than its box before it counts as cut, in pixels: the rounding of layout. */
const CUT_TOLERANCE = 0.01;

/** The width a node's text needs on one line, with its fraction (scrollWidth and clientWidth are rounded, which hides a text that is a fraction of a pixel too long: the browser draws its ellipsis all the same). */
export function textWidthOf(node: Element): number {
  const range = document.createRange();
  // a window with no layout of ranges (a test one) has only the rounded width
  if (typeof range.getBoundingClientRect !== "function") return node.scrollWidth;
  range.selectNodeContents(node);
  return range.getBoundingClientRect().width;
}

/** Whether a clip draws an ellipsis: its text needs more than its box has, by any fraction. */
export const cuts = (clip: Element): boolean => textWidthOf(clip) > clip.getBoundingClientRect().width + CUT_TOLERANCE;
