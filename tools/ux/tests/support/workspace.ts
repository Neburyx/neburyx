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
