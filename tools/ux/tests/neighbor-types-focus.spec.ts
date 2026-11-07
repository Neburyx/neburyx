import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf, openSample, screenOf } from './support/workspace.ts';

const count = { value: 3, quality: 'exact', scope: 'relationships' };

test.describe('the neighbor types submenu', () => {
  let release: (() => void) | undefined;
  let slow = false;

  test.beforeEach(async ({ page }) => {
    release = undefined;
    slow = false;
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      if (slow) await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total: count, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count }], warnings: [] } });
    });
  });

  const outline = (page: Page, selector: string): Promise<string> => page.locator(selector).first().evaluate((element) => getComputedStyle(element).outlineStyle);
  const entry = (page: Page) => menuOf(page).first().getByRole('menuitem', { name: 'Expand neighbors' });

  async function openByKeyboard(page: Page): Promise<void> {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await entry(page).focus();
    await page.keyboard.press('ArrowRight');
  }

  test('opened by the mouse, draws no ring on the panel, its body, its rows or the entry', async ({ page }) => {
    await openSample(page);
    const at = await screenOf(page, 'holder');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await entry(page).click();
    await expect(page.locator('.neighbor-types-row').first()).toBeVisible();
    expect(await outline(page, '.context-submenu .menu-panel'), 'the panel').toBe('none');
    expect(await outline(page, '.neighbor-types-body'), 'the body').toBe('none');
    expect(await page.locator('.context-submenu :focus-visible').count(), 'a ring inside the submenu').toBe(0);
    expect(await page.locator('.context-menu :focus-visible').count(), 'a ring anywhere in the menu').toBe(0);
  });

  test('opened by the keyboard, puts the ring on the first row only', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    const rows = page.locator('.neighbor-types-row');
    await expect(rows.first()).toBeFocused();
    expect(await outline(page, '.neighbor-types-row'), 'the row').not.toBe('none');
    expect(await outline(page, '.context-submenu .menu-panel'), 'the panel').toBe('none');
    expect(await outline(page, '.neighbor-types-body'), 'the body').toBe('none');
  });

  test('opened by the keyboard before the answer, holds the focus without a ring on the panel and moves it to the first row when the answer comes', async ({ page }) => {
    slow = true;
    await openSample(page);
    await openByKeyboard(page);
    await expect(page.locator('.neighbor-types-body')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('menu-panel');
    expect(await outline(page, '.context-submenu .menu-panel'), 'the panel while loading').toBe('none');
    release?.();
    await expect(page.locator('.neighbor-types-row').first()).toBeFocused();
    expect(await outline(page, '.neighbor-types-row'), 'the row').not.toBe('none');
  });
});
