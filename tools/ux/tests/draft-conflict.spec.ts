import { expect, test, type Browser, type Page } from '@playwright/test';
import { canvasOf, openWithDraft, positions, storedMatchesDrawn } from './support/workspace.ts';

const IDS = ['AC-1', 'AC-2', 'AC-3'];
const region = (page: Page) => page.getByRole('region', { name: 'Request status' });
const storedVersion = async (page: Page, id: string) => ((await (await page.request.get(`/v1/investigations/${id}`)).json()) as { draft: { version: number } }).draft.version;

async function secondTab(browser: Browser, first: Page, id: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: new URL(first.url()).origin });
  const page = await context.newPage();
  await page.goto(`/explore/${id}`);
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length));
  return page;
}

/** Selects the first entity and moves it with the arrow keys; returns once the canvas has drawn it somewhere else and it has stopped moving. */
async function nudge(page: Page): Promise<void> {
  const before = JSON.stringify(await positions(page));
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowRight');
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await positions(page));
        const settled = now === last && now !== before;
        last = now;
        return settled;
      },
      { message: 'the entity was drawn somewhere else and stopped moving' },
    )
    .toBe(true);
}

/** Two tabs on one investigation, each holding the draft as it was stored; the second is closed when the case ends, however it ends. */
async function withTwoTabs(page: Page, browser: Browser, run: (first: Page, second: Page, id: string) => Promise<void>): Promise<void> {
  const id = await openWithDraft(page, IDS, (index) => ({ x: index * 100, y: index * 50 }));
  await page.reload();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length));
  const other = await secondTab(browser, page, id);
  try {
    await run(page, other, id);
  } finally {
    await other.context().close();
  }
}

test.describe('an investigation changed in another tab', () => {
  test('shows the banner in the second tab with its words and a Reload that has no dismiss, keeps its canvas, and Reload shows the first tab\'s change', async ({ page, browser }) => {
    await withTwoTabs(page, browser, async (first, other, id) => {
      await nudge(first);
      await expect.poll(() => storedMatchesDrawn(first, id), { message: 'the autosave caught up with the last move', timeout: 20_000 }).toBe(true);
      const firstTabMoved = await positions(first);

      await nudge(other);
      const shown = await positions(other);
      await expect(region(other)).toContainText('This investigation changed in another tab.', { timeout: 15_000 });
      await expect(region(other)).toContainText('Changes made in this tab are not saved. Reload to continue with the latest version.');
      await expect(region(other).getByRole('button', { name: 'Reload' })).toBeVisible();
      await expect(region(other).getByRole('button', { name: /dismiss|close/i })).toHaveCount(0);
      expect(await positions(other)).toEqual(shown);

      await region(other).getByRole('button', { name: 'Reload' }).click();
      await expect(region(other)).toHaveCount(0);
      await expect(canvasOf(other)).toHaveAttribute('data-drawn-entities', String(IDS.length));
      const reloaded = await positions(other);
      for (const [key, at] of Object.entries(firstTabMoved)) {
        expect(reloaded[key]?.x).toBeCloseTo(at.x, 0);
        expect(reloaded[key]?.y).toBeCloseTo(at.y, 0);
      }
    });
  });

  test('reaches Reload with the keyboard, activates it with Enter, and the keyboard goes on from the top of the reloaded page', async ({ page, browser }) => {
    await withTwoTabs(page, browser, async (first, other, id) => {
      const start = await storedVersion(first, id);
      await nudge(first);
      await expect.poll(() => storedVersion(first, id), { timeout: 15_000 }).toBeGreaterThan(start);
      await nudge(other);
      const reload = region(other).getByRole('button', { name: 'Reload' });
      await expect(reload).toBeVisible({ timeout: 15_000 });
      await reload.focus();
      await expect(reload).toBeFocused();
      await other.keyboard.press('Enter');
      await expect(region(other)).toHaveCount(0);
      await expect(canvasOf(other)).toHaveAttribute('data-drawn-entities', String(IDS.length));
      // the page was loaded again, so the focus starts over: the first Tab must land on a control, not on the page itself
      await other.keyboard.press('Tab');
      await expect.poll(() => other.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toMatch(/^(BODY|NONE)$/);
    });
  });
});
