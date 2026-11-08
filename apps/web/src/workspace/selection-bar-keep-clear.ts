import { placeSelectionBar, type Box, type Placement } from './selection-bar-place.js';

const OBSTACLES = '.region-tool-strip, .canvas-notice, .floating-panel, .region-zoom-controls, .region-toggles';
const WATCHED = `.graph-scope, ${OBSTACLES}`;
const LEFT = '--selection-bar-place-left';
const SHIFT = '--selection-bar-place-shift';
const TOP = '--selection-bar-place-top';
const MAX = '--selection-bar-place-max';
const COMPACT = 'data-compact';

/** Keeps the bar clear of the scope lines and the other controls at the top of the canvas, by measuring them: at its usual place when that is clear, otherwise beside the scope lines, otherwise below them. Measures again when any of them changes size. Returns the function that stops it. */
export function keepBarClear(bar: HTMLElement): () => void {
  const region = bar.parentElement;
  if (region === null) return () => undefined;
  const measure = (): void => {
    // the bar is measured at its own width and place, not at the ones it was given last time
    for (const name of [LEFT, SHIFT, TOP, MAX]) bar.style.removeProperty(name);
    bar.removeAttribute(COMPACT);
    const origin = region.getBoundingClientRect();
    const inRegion = (element: Element): Box => {
      const box = element.getBoundingClientRect();
      return { left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top };
    };
    const scopeElement = region.querySelector('.graph-scope');
    const scope = scopeElement === null ? undefined : inRegion(scopeElement);
    const obstacles = [...(scope === undefined ? [] : [scope]), ...[...region.querySelectorAll(OBSTACLES)].map(inRegion)];
    const usual = Number.parseFloat(getComputedStyle(region).getPropertyValue('--selection-bar-top')) || 22;
    const placeAs = (compact: boolean): Placement => {
      if (compact) bar.setAttribute(COMPACT, '');
      else bar.removeAttribute(COMPACT);
      return placeSelectionBar({ width: origin.width, height: origin.height }, { width: bar.offsetWidth, height: bar.offsetHeight }, usual, scope, obstacles);
    };
    // at its own width when that is clear, otherwise with the action labels left out (wrapped too, when even that is not clear)
    const full = placeAs(false);
    const placed = full.clear ? full : placeAs(true);
    if (placed.left === undefined && placed.top === usual) return;
    bar.style.setProperty(TOP, `${placed.top}px`);
    if (placed.maxWidth === undefined) bar.style.removeProperty(MAX);
    else bar.style.setProperty(MAX, `${placed.maxWidth}px`);
    if (placed.left === undefined) {
      bar.style.removeProperty(LEFT);
      bar.style.removeProperty(SHIFT);
    } else {
      bar.style.setProperty(LEFT, `${placed.left}px`);
      bar.style.setProperty(SHIFT, '0px');
    }
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const watcher = new ResizeObserver(measure);
  const watch = (): void => {
    watcher.disconnect();
    for (const element of [region, bar, ...region.querySelectorAll(WATCHED)]) watcher.observe(element);
  };
  watch();
  // a panel or the notice that opens or closes while the bar is shown is measured too
  const concerns = (node: Node): boolean => node instanceof Element && (node.matches(WATCHED) || node.querySelector(WATCHED) !== null);
  const changes = new MutationObserver((records) => {
    if (!records.some((record) => [...record.addedNodes, ...record.removedNodes].some(concerns))) return;
    watch();
    measure();
  });
  changes.observe(region, { childList: true, subtree: true });
  return () => {
    watcher.disconnect();
    changes.disconnect();
    for (const name of [LEFT, SHIFT, TOP, MAX]) bar.style.removeProperty(name);
    bar.removeAttribute(COMPACT);
  };
}
