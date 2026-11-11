import { expect, type Locator, type Page } from '@playwright/test';

/** The key that stands for the platform's own modifier, as the product chooses it: Meta on macOS, Control elsewhere. */
export async function modifier(page: Page): Promise<'Meta' | 'Control'> {
  return (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))) ? 'Meta' : 'Control';
}

export function canvasOf(page: Page): Locator {
  return page.getByRole('application', { name: 'Graph canvas' });
}

/** The polite region of the canvas, which tells what the walk is at and what an arrow move did. */
export function announcement(page: Page): Locator {
  return canvasOf(page).locator('xpath=following-sibling::p[@role="status"]');
}

export async function openSample(page: Page, query = ''): Promise<void> {
  await page.goto(`/dev/frame-sample${query}`);
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
}

/** Presses Tab until the element is focused; fails when it never is, so a trap or a missing tab stop is not a pass. */
export async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  for (let press = 0; press < limit; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('NEVER_REACHED_BY_TAB');
}

export async function focusCanvas(page: Page): Promise<void> {
  await tabTo(page, canvasOf(page));
}

/** Starts recording, in the page, whether the page's own handlers cancelled each key press, as a listener that runs after theirs. */
export async function recordPrevented(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: boolean[] = [];
    Reflect.set(window, 'preventedLog', log);
    window.addEventListener('keydown', (event) => void log.push(event.defaultPrevented));
  });
}

export async function lastPrevented(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const log: unknown = Reflect.get(window, 'preventedLog');
    return Array.isArray(log) && log.at(-1) === true;
  });
}

export interface Drawn {
  readonly [key: string]: { readonly x: number; readonly y: number };
}

/** Where the renderer drew each entity, read back from the development canvas. */
export async function positions(page: Page): Promise<Drawn> {
  return canvasOf(page).evaluate((element) => {
    const read: unknown = Reflect.get(element, 'readDrawnPositions');
    if (typeof read !== 'function') throw new Error('NO_READ_BACK');
    return read.call(element);
  });
}

/** Where an entity is on the page, from its drawn position, the zoom and the pan. */
export async function screenOf(page: Page, id: string): Promise<{ readonly x: number; readonly y: number }> {
  const drawn = await positions(page);
  const key = Object.keys(drawn).find((candidate) => candidate.endsWith(`,"${id}"]`));
  const at = key === undefined ? undefined : drawn[key];
  if (at === undefined) throw new Error(`NO_ENTITY_${id}`);
  const canvas = canvasOf(page);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('NO_CANVAS');
  const [zoom, panX, panY] = await canvas.evaluate((element) => [Number(element.dataset['zoom']), Number(element.dataset['panX']), Number(element.dataset['panY'])]);
  return { x: box.x + at.x * (zoom ?? 1) + (panX ?? 0), y: box.y + at.y * (zoom ?? 1) + (panY ?? 0) };
}

export const menuOf = (page: Page): Locator => page.getByRole('menu');

/** The labels of the items of the open menu, in order. */
export async function menuItems(page: Page): Promise<string[]> {
  return menuOf(page).first().locator('[role="menuitem"] .menu-label').allTextContents();
}

/** The development fixture of 120 entities and 180 relationships with 10 pinned, loaded through the page's own controls and opened in Explore. */
export async function openFixture(page: Page): Promise<void> {
  await page.goto('/dev/fixture');
  await page.getByRole('button', { name: /^banking-demo/ }).first().click();
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.getByRole('link', { name: 'Open Explore' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '120');
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-relationships', '180');
}

/** Marks where every entity is now, so the page can say how many have moved since. */
export async function markPositions(page: Page): Promise<void> {
  await canvasOf(page).evaluate((element) => element.dispatchEvent(new Event('neburyx-dev-mark')));
}

export async function movedSinceMark(page: Page): Promise<{ readonly unpinned: number; readonly pinned: number; readonly marked: number }> {
  const data = await canvasOf(page).evaluate((element) => ({ unpinned: element.dataset['movedUnpinned'], pinned: element.dataset['movedPinned'], marked: element.dataset['markedEntities'] }));
  return { unpinned: Number(data.unpinned), pinned: Number(data.pinned), marked: Number(data.marked) };
}

export interface DrawingNode {
  readonly id: string;
  readonly captionShown: boolean;
  readonly glyphShown: boolean;
  readonly badgeShown: boolean;
  readonly images: readonly string[];
  readonly focused: boolean;
}

export interface DrawingEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly labelShown: boolean;
  readonly lineShown: boolean;
  readonly label: string;
  readonly width: number;
  readonly focused: boolean;
}

/** What the renderer has drawn, read from the development canvas. */
export async function drawing(page: Page): Promise<{ readonly nodes: readonly DrawingNode[]; readonly edges: readonly DrawingEdge[] }> {
  return canvasOf(page).evaluate((element) => {
    const inspect: unknown = Reflect.get(element, 'inspectDrawing');
    if (typeof inspect !== 'function') throw new Error('NO_INSPECTION');
    return inspect.call(element);
  });
}

export const zoomOf = (page: Page): Promise<number> => canvasOf(page).evaluate((element) => Number(element.dataset['zoom']));

/** The zoom below which captions and labels are not drawn: a caption of 12 px is then 7 px on the screen. */
export const CAPTION_LIMIT = 7 / 12;

/** Presses Zoom out until the zoom is under the limit (or Zoom in until it is over it), then waits for the page's read-out to settle. */
export async function zoomPast(page: Page, direction: 'below' | 'above'): Promise<void> {
  const button = page.getByRole('button', { name: direction === 'below' ? 'Zoom out' : 'Zoom in' });
  for (let press = 0; press < 30; press += 1) {
    const zoom = await zoomOf(page);
    if (direction === 'below' ? zoom < CAPTION_LIMIT * 0.9 : zoom > CAPTION_LIMIT * 1.2) break;
    await button.click();
    await page.waitForTimeout(80);
  }
  let last = -1;
  await expect.poll(async () => {
    const now = await zoomOf(page);
    const settled = now === last;
    last = now;
    return settled;
  }).toBe(true);
}

const KEY_NAMES: Readonly<Record<string, string>> = { escape: 'Esc', enter: 'Enter', space: 'Space', tab: 'Tab', delete: 'Del', contextmenu: 'Menu', arrowleft: '←', arrowup: '↑', arrowdown: '↓', arrowright: '→' };

/** How the page shows a key on this platform: ⇧⌘I on macOS, Ctrl+Shift+I elsewhere. */
export function shownKey(mod: 'Meta' | 'Control', spec: string): string {
  const parts = spec.split('+');
  const last = parts.pop() ?? '';
  const name = KEY_NAMES[last] ?? last.toUpperCase();
  const has = (word: string): boolean => parts.includes(word);
  return mod === 'Meta' ? `${has('shift') ? '⇧' : ''}${has('mod') ? '⌘' : ''}${name}` : [...(has('mod') ? ['Ctrl'] : []), ...(has('shift') ? ['Shift'] : []), name].join('+');
}

/** Each row of the open menu with the key it shows, the empty text where it shows none. */
export async function menuHints(page: Page): Promise<Array<readonly [string, string]>> {
  const rows = await menuOf(page).first().locator('[role="menuitem"], [role="menuitemradio"]').evaluateAll((items) => items.map((item) => ({ label: item.querySelector('.menu-label')?.textContent ?? '', hint: item.querySelector('.menu-hint, kbd')?.textContent ?? '' })));
  return rows.map(({ label, hint }) => [label, hint] as const);
}

/** Opens Explore on one entity the way a person does: through the search page and its Open in graph button. */
export async function openOneEntity(page: Page, source: string, id: string): Promise<void> {
  await page.goto(`/search?source=${source}`);
  await page.getByRole('searchbox', { name: 'Search text' }).fill(id);
  await page.getByRole('searchbox', { name: 'Search text' }).press('Enter');
  await page.getByRole('button', { name: 'Open in graph' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

/** Zooms in until entities are big enough to grab, then returns the page position of the unpinned entity nearest the middle of the canvas, and its key. */
export async function grabbablePoint(page: Page): Promise<{ readonly key: string; readonly x: number; readonly y: number }> {
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  for (let press = 0; press < 12 && (await zoomOf(page)) < 0.8; press += 1) await zoomIn.click();
  await page.waitForTimeout(300);
  const canvas = canvasOf(page);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('NO_CANVAS');
  const [zoom, panX, panY] = await canvas.evaluate((element) => [Number(element.dataset['zoom']), Number(element.dataset['panX']), Number(element.dataset['panY'])]);
  const held = new Set((await drawing(page)).nodes.filter((node) => node.badgeShown).map((node) => node.id));
  const drawn = await positions(page);
  let best: { key: string; x: number; y: number; apart: number } | undefined;
  for (const [key, at] of Object.entries(drawn)) {
    if (held.has(key)) continue;
    const x = box.x + at.x * (zoom ?? 1) + (panX ?? 0);
    const y = box.y + at.y * (zoom ?? 1) + (panY ?? 0);
    const apart = Math.hypot(x - (box.x + box.width / 2), y - (box.y + box.height / 2));
    if (apart < (best?.apart ?? Infinity)) best = { key, x, y, apart };
  }
  if (best === undefined) throw new Error('NO_ENTITY');
  return best;
}

/**
 * What selecting entities asks of the API for the inspector: one entity read and one degree preview for each entity that was selected on its own, `selected` in all, and one read of the rule-derived neighbors for each of a type some rule of the source starts from. A spec that says nothing else was asked leaves
 * out exactly those; one more read of either kind stays in the list and fails it.
 */
export function apartFromInspector(requests: readonly string[], selected = 1): string[] {
  let reads = selected;
  let previews = selected;
  let derived = selected;
  return requests.filter((request) => {
    if (request.startsWith('GET /v1/entities/') && reads > 0) {
      reads -= 1;
      return false;
    }
    if (request === 'POST /v1/graph/preview-expansion' && previews > 0) {
      previews -= 1;
      return false;
    }
    if (request === 'POST /v1/graph/derived-neighbors' && derived > 0) {
      derived -= 1;
      return false;
    }
    return true;
  });
}

const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };

/** Opens `AC-1` from the open-an-entity page and gives its investigation a stored draft of the named accounts, each at the place `at` gives; the page is not reloaded. */
export async function openWithDraft(page: Page, ids: readonly string[], at: (index: number) => { readonly x: number; readonly y: number }): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop() ?? '';
  const layout = { schemaVersion: 1, layout: 'force', nodes: ids.map((stable, index) => ({ t: 'account', id: stable, pinned: false, hidden: false, groupId: null, ...at(index) })), edges: [], groups: [] };
  const queryContext = { schemaVersion: 1, loaded: { nodes: ids.map((stable) => ({ t: 'account', id: stable })), edges: [] }, expansions: [], filters: NO_FILTERS };
  expect((await page.request.put(`/v1/investigations/${id}/draft`, { headers: { 'If-Match': '"1"' }, data: { layout, queryContext, notes: null } })).status()).toBe(200);
  return id;
}

/** True once the stored draft holds, for each entity that has a stored place, the place the canvas draws it at: the autosave has caught up with the last move. */
export async function storedMatchesDrawn(page: Page, id: string): Promise<boolean> {
  const body = (await (await page.request.get(`/v1/investigations/${id}`)).json()) as { draft: { layout: { nodes: { id: string; x?: number; y?: number }[] } } };
  const drawn = await positions(page);
  const byId = new Map(Object.entries(drawn).map(([key, at]) => [String((JSON.parse(key) as string[]).at(-1)), at]));
  const placed = body.draft.layout.nodes.filter((node) => node.x !== undefined && node.y !== undefined);
  return placed.length > 0 && placed.every((node) => Math.abs((byId.get(node.id)?.x ?? NaN) - (node.x ?? 0)) < 0.5 && Math.abs((byId.get(node.id)?.y ?? NaN) - (node.y ?? 0)) < 0.5);
}
