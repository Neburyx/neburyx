import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, drawing, menuOf, openSample } from './support/workspace.ts';

const exact = (value: number) => ({ value, quality: 'exact', scope: 'relationships' });
const bound = (value: number) => ({ value, quality: 'lowerBound', scope: 'relationships' });

test.describe('the Expand relationships panel', () => {
  let expandBodies: Array<Record<string, unknown>> = [];

  test.beforeEach(async ({ page }) => {
    expandBodies = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({
        json: {
          ref: { sourceId: body.sourceId, ...body.ref },
          total: bound(3316),
          byType: [],
          byNeighborType: [{ entityType: body.ref.entityType, count: bound(3300) }, { entityType: 'another', count: exact(12) }],
          warnings: [],
          pageSize: 25,
          heavyOpThreshold: 500,
        },
      });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown> & { sourceId: string; ref: { entityType: string; stableId: string } };
      expandBodies.push(body);
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, pageSize: 25, nodes: [], edges: [], pages: [], warnings: [] } });
    });
  });

  const panel = (page: Page) => page.getByRole('complementary', { name: 'Expand relationships' });

  async function openByKeyboard(page: Page): Promise<void> {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by type', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
  }

  test('opens from the menu with the focus on Relationship type, and the keys visit every control in reading order, Close first, back to it with Shift+Tab', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await expect(panel(page).getByRole('combobox', { name: 'Relationship type' })).toBeFocused();
    await expect(panel(page).getByText('Loading neighbors')).toHaveCount(0);
    const inside = () => page.evaluate(() => document.activeElement?.closest('aside[aria-label="Expand relationships"]') !== null && document.activeElement?.closest('aside[aria-label="Expand relationships"]') !== undefined);
    const label = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
    const forward: string[] = [];
    for (let press = 0; press < 30 && (await inside()); press += 1) {
      forward.push(await label());
      await page.keyboard.press('Tab');
    }
    expect(forward[0], 'starts on the relationship type').toBe('All sourced types');
    const at = (matcher: (name: string) => boolean): number => forward.findIndex(matcher);
    expect(at((name) => name === 'Invert selection'), 'the neighbor types come before the rank').toBeGreaterThan(0);
    expect(at((name) => name === 'Select all')).toBeGreaterThan(at((name) => name === 'Invert selection'));
    expect(at((name) => name.startsWith('Load ') && name.endsWith(' per type')), 'the Load button follows the page size').toBeGreaterThan(at((name) => name === 'Select all'));
    for (let press = 0; press < 40; press += 1) {
      if ((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Close Expand relationships') break;
      await page.keyboard.press('Shift+Tab');
    }
    await expect(panel(page).getByRole('button', { name: 'Close Expand relationships' })).toBeFocused();
  });

  test('changes the page size with the arrow keys by 1, and a typed value out of range says so and disables the button', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    const size = panel(page).getByRole('spinbutton', { name: 'Page size per type' });
    await expect(size).toHaveValue('25');
    await size.focus();
    await page.keyboard.press('ArrowUp');
    await expect(size).toHaveValue('26');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(size).toHaveValue('24');
    await size.fill('51');
    await expect(panel(page).getByRole('alert')).toHaveText('Enter a whole number from 1 to 50.');
    await expect(panel(page).getByRole('button', { name: /^Load .* per type$/ })).toBeDisabled();
  });

  test('draws one ring at a time, light, on each control it focuses', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    for (let press = 0; press < 5; press += 1) {
      expect(await page.locator(':focus-visible').count(), 'elements with a focus ring').toBeLessThanOrEqual(1);
      const width = await page.evaluate(() => (document.activeElement === null ? 0 : parseFloat(getComputedStyle(document.activeElement).outlineWidth)));
      expect(width, 'the ring is light').toBeLessThanOrEqual(2);
      await page.keyboard.press('Tab');
    }
  });

  test('closes on Escape and gives the focus back to the canvas', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
  });

  test('sends a limit with every request the panel makes', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await panel(page).getByRole('button', { name: /^Load .* per type$/ }).click();
    await expect.poll(() => expandBodies.length).toBeGreaterThan(0);
    expect(expandBodies.every((body) => typeof body['limit'] === 'number'), 'every request carries a limit').toBe(true);
  });

  test('draws an aggregate node for the opened node, reached by the walk, and Enter on it opens the panel', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await expect.poll(async () => (await drawing(page) as unknown as { remainders: unknown[] }).remainders.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    for (let step = 0; step < 60; step += 1) {
      if (((await announcement(page).textContent()) ?? '').includes('relationships loaded, not all loaded')) break;
      await page.keyboard.press('Tab');
    }
    expect(await announcement(page).textContent()).toContain('not all loaded');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
  });
});
