import { useLayoutEffect, type RefObject } from 'react';

const GAP = 8;
const CLIPS = new Set(['auto', 'scroll', 'hidden', 'clip']);

/** The nearest ancestor that clips or scrolls what is drawn inside it: the menu is only as reachable as that box shows it. */
function clippingAncestor(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    if (CLIPS.has(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Keeps an open menu inside the window: it opens downward, upward when it does not fit below and fits above, and on the side with more room, scrolling inside, when it fits on neither. It measures after the menu is drawn, so
 * the height is the real one. The room is that of the window and of the box that clips the menu (the panel), whichever is smaller; both are read each time the menu opens.
 */
export function useMenuPlacement(open: boolean, menu: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = menu.current;
    const opener = trigger.current;
    if (!open || node === null || opener === null) return;
    node.style.maxHeight = '';
    delete node.dataset['placement'];
    const height = node.getBoundingClientRect().height;
    const from = opener.getBoundingClientRect();
    const clip = clippingAncestor(node)?.getBoundingClientRect();
    const below = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight) - from.bottom - GAP;
    const above = from.top - Math.max(0, clip?.top ?? 0) - GAP;
    if (height <= below) return;
    if (height <= above) {
      node.dataset['placement'] = 'above';
      return;
    }
    if (above > below) node.dataset['placement'] = 'above';
    node.style.maxHeight = `${Math.max(above > below ? above : below, 0)}px`;
  }, [open, menu, trigger]);
}
