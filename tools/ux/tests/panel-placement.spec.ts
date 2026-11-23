import { expect, test, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';
import { openSample } from './support/workspace.ts';

const legend = (page: Page) => page.getByRole('complementary', { name: 'Legend' });

async function wantedTop(page: Page): Promise<number> {
  const header = await boxOf(page.getByRole('banner'));
  const scope = await boxOf(page.locator('.graph-scope'));
  const panel = await boxOf(legend(page));
  const reaches = panel.x < scope.x + scope.width && scope.x < panel.x + panel.width;
  return (reaches ? Math.max(header.y + header.height, scope.y + scope.height) : header.y + header.height) + 16;
}

test.describe('where a right-hand panel starts', () => {
  test('is already right in the first frame the panel is drawn, not corrected afterwards', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await page.locator('.graph-scope').evaluate((element) => {
      const line = document.createElement('p');
      line.textContent = 'a long scope line '.repeat(30);
      element.appendChild(line);
    });
    await expect.poll(async () => (await boxOf(page.locator('.graph-scope'))).height).toBeGreaterThan(80);
    await page.evaluate(() => {
      const seen: number[] = [];
      Object.assign(window, { firstTops: seen });
      new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (!(added instanceof Element)) continue;
            const panel = added.matches('.floating-panel[aria-label="Legend"]') ? added : added.querySelector('.floating-panel[aria-label="Legend"]');
            if (panel !== null) seen.push(panel.getBoundingClientRect().top);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press('l');
    await expect(legend(page)).toBeVisible();
    const settled = await boxOf(legend(page));
    const first = await page.evaluate(() => {
      const tops: unknown = Reflect.get(window, 'firstTops');
      return Array.isArray(tops) && typeof tops[0] === 'number' ? tops[0] : undefined;
    });
    const scope = await boxOf(page.locator('.graph-scope'));
    expect(settled.x < scope.x + scope.width && scope.x < settled.x + settled.width, 'the panel reaches under the scope lines').toBe(true);
    expect(first).toBeDefined();
    expect(Math.round(first ?? 0)).toBe(Math.round(settled.y));
    expect(Math.round(settled.y)).toBe(Math.round(await wantedTop(page)));
  });

  test('follows the scope lines when they gain a line after the panel is open, and back when they lose it', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await page.keyboard.press('l');
    await expect(legend(page)).toBeVisible();
    await expect.poll(async () => Math.round((await boxOf(legend(page))).y - (await wantedTop(page)))).toBe(0);
    await page.locator('.graph-scope').evaluate((element) => {
      const line = document.createElement('p');
      line.dataset['added'] = 'yes';
      line.textContent = 'a long scope line '.repeat(30);
      element.appendChild(line);
    });
    await expect.poll(async () => Math.round((await boxOf(legend(page))).y - (await wantedTop(page)))).toBe(0);
    const grown = await boxOf(legend(page));
    await page.locator('.graph-scope [data-added]').evaluate((line) => line.remove());
    await expect.poll(async () => Math.round((await boxOf(legend(page))).y - (await wantedTop(page)))).toBe(0);
    expect((await boxOf(legend(page))).y).toBeLessThan(grown.y);
  });
});
