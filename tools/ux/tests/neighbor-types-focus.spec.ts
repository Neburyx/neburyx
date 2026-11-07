import { expect, test, type Page } from '@playwright/test';
import { canvasOf, drawing, menuOf, openSample, screenOf } from './support/workspace.ts';

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
    const inside = await rows.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth), radius: parseFloat(style.borderTopLeftRadius), background: style.backgroundColor };
    });
    expect(inside.offset, 'the ring sits inside the row').toBeLessThan(0);
    expect(inside.width, 'the ring is light').toBeLessThanOrEqual(2);
    expect(inside.radius, 'the ring follows the corners of the row').toBeGreaterThan(0);
    expect(inside.background, 'the focused row takes the hover background').not.toBe('rgba(0, 0, 0, 0)');
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

  test('draws one ring at a time: none on the canvas element while the menu or its submenu has the focus, and the ring is back when the menu is closed', async ({ page }) => {
    await openSample(page);
    const ringed = async (): Promise<number> => (await drawing(page)).nodes.filter((node) => node.focused).length;
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await ringed(), 'the walk element has its ring before the menu').toBe(1);
    await page.keyboard.press('ContextMenu');
    await expect(entry(page)).toBeFocused();
    await expect.poll(ringed, 'the canvas ring while the menu has the focus').toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.neighbor-types-row').first()).toBeFocused();
    expect(await ringed(), 'the canvas ring while the submenu has the focus').toBe(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(menuOf(page)).toHaveCount(0);
    await expect.poll(ringed, 'the canvas ring once the menu is closed').toBe(1);
  });
});
