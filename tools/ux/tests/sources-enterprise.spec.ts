import { expect, test } from '@playwright/test';
import { focusWidth, lookOf, tokenColour } from './support/controls.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const NAME = 'Talk to us about Enterprise';
const MOST_TAB_STOPS = 60;
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 600, height: 800 }] as const;

test.describe('the Enterprise link of the Sources page', () => {
  test('is the last tab stop of the page, has its name and shows the focus outline', async ({ page }) => {
    await page.goto('/sources');
    const link = page.getByRole('main').getByRole('link', { name: NAME });
    await expect(link).toBeVisible();
    await expect(page.locator('.source-list button').first()).toBeVisible();
    await page.locator('.source-list button').first().focus();
    let reached = false;
    for (let press = 0; press < MOST_TAB_STOPS && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await link.evaluate((element) => element === document.activeElement);
    }
    expect(reached, 'the link takes a tab stop').toBe(true);
    expect(await lookOf(link, ['outline-style', 'outline-width', 'outline-color'])).toEqual({ 'outline-style': 'solid', 'outline-width': await focusWidth(page), 'outline-color': await tokenColour(page, '--color-focus') });
    const after = await page.evaluate(() => {
      const controls = [...document.querySelectorAll<HTMLElement>('main a[href], main button:not([disabled])')];
      return controls.at(-1)?.textContent;
    });
    expect(after).toBe(NAME);
  });

  for (const size of SIZES) {
    test(`sits below the list and the detail without overlapping them or leaving the window at ${size.width} wide`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/sources');
      const link = page.getByRole('main').getByRole('link', { name: NAME });
      await expect(link).toBeVisible();
      await expect(page.locator('.source-list button').first()).toBeVisible();
      const [box, layout] = [await link.boundingBox(), await page.locator('.sources-layout').boundingBox()];
      if (box === null || layout === null) throw new Error('the link and the layout have boxes');
      expect(box.y).toBeGreaterThanOrEqual(layout.y + layout.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});
