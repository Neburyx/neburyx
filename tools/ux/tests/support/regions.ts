import { expect, type Locator, type Page } from '@playwright/test';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The tolerance for a value the recorded frames give exactly, and for one they give as approximate (a tilde in the record). */
export const EXACT = 0.5;
export const APPROXIMATE = 1.5;

export async function boxOf(region: Locator): Promise<Box> {
  const box = await region.boundingBox();
  if (box === null) throw new Error('REGION_NOT_FOUND');
  return box;
}

/** Fails with the region's name and the side that differs. */
export async function expectBox(name: string, region: Locator, expected: Partial<Box>, tolerance = EXACT): Promise<void> {
  const box = await boxOf(region);
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    const wanted = expected[side];
    if (wanted === undefined) continue;
    expect(Math.abs(box[side] - wanted), `${name}: ${side} is ${box[side]}, expected ${wanted} (±${tolerance})`).toBeLessThanOrEqual(tolerance);
  }
}

/** A region's distance from the bottom edge of the viewport. */
export async function fromBottom(page: Page, region: Locator, edge: 'top' | 'bottom' = 'top'): Promise<number> {
  const box = await boxOf(region);
  const height = page.viewportSize()?.height ?? 0;
  return height - (edge === 'top' ? box.y : box.y + box.height);
}

/** The page does not scroll sideways, and none of the named regions reaches outside the viewport. */
export async function expectInsideViewport(page: Page, regions: Readonly<Record<string, Locator>>): Promise<void> {
  const size = page.viewportSize();
  if (size === null) throw new Error('NO_VIEWPORT');
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, 'the page scrolls sideways').toBe(0);
  for (const [name, region] of Object.entries(regions)) {
    const box = await boxOf(region);
    expect(box.x, `${name} starts left of the viewport`).toBeGreaterThanOrEqual(-EXACT);
    expect(box.x + box.width, `${name} ends right of the viewport`).toBeLessThanOrEqual(size.width + EXACT);
    expect(box.y, `${name} starts above the viewport`).toBeGreaterThanOrEqual(-EXACT);
  }
}

/** A region that must not scroll has as much content as room. */
export async function expectNoScroll(name: string, region: Locator): Promise<void> {
  const sizes = await region.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(sizes.scrollWidth, `${name} scrolls sideways`).toBeLessThanOrEqual(sizes.clientWidth);
  expect(sizes.scrollHeight, `${name} scrolls up and down`).toBeLessThanOrEqual(sizes.clientHeight);
}

export async function styleOf(region: Locator, properties: readonly string[]): Promise<Record<string, string>> {
  return region.evaluate((element, names) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name)]));
  }, [...properties]);
}
