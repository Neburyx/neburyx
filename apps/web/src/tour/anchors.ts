export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const ENTITY_HALF = 36;

function boxOf(element: Element): Box | undefined {
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? undefined : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function union(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** The search box on Home: found by the class its search block already has. */
export function searchBox(): Box | undefined {
  const element = document.querySelector('.home-search');
  return element === null ? undefined : boxOf(element);
}

/** The graph scope line (the counts), found by its group name. */
export function scopeBox(): Box | undefined {
  const element = document.querySelector('[role="group"][aria-label="Graph scope"]');
  return element === null ? undefined : boxOf(element);
}

/** A square around a point on the page, for the starting entity the canvas can place. */
export function entityBox(at: { readonly x: number; readonly y: number } | undefined): Box | undefined {
  return at === undefined ? undefined : { left: at.x - ENTITY_HALF, top: at.y - ENTITY_HALF, width: ENTITY_HALF * 2, height: ENTITY_HALF * 2 };
}

/** The Export and Save buttons, found by their accessible names among the page's buttons; one box around the two that are there. */
export function keepWorkBox(): Box | undefined {
  const wanted = new Set(['Export', 'Save']);
  const found = [...document.querySelectorAll('button')].filter((button) => wanted.has(button.textContent.trim()) && !button.closest('[role="dialog"], [role="menu"]'));
  return union(found.flatMap((button) => boxOf(button) ?? []));
}
