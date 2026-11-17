import { expect, test, type Page } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const DEMO_CASE = { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' };
const PAD = 6;
const SLACK = 2;

const dialog = (page: Page, step: number) => page.getByRole('dialog', { name: `Guided tour, step ${step} of 4` });
const spot = (page: Page) => page.locator('.tour-spot');
const stored = async (page: Page): Promise<unknown> => ((await (await page.request.get('/v1/me/preferences')).json()) as { preferences: unknown }).preferences;

test.beforeEach(async ({ page }) => {
  // a real source keeps `/` on Home; the synthetic one offers the demo case; the person has not seen the tour
  await page.request.post('/__support/forget-investigations');
  await page.request.post('/__support/sources', { data: { 'claims-demo': { synthetic: false }, 'banking-demo': { demoCase: DEMO_CASE } } });
  await page.request.post('/__support/preferences', { data: {} });
});

test.afterEach(async ({ page }) => {
  await page.request.post('/__support/reset');
  await page.request.post('/__support/forget-investigations');
});

async function expectAround(page: Page, anchor: ReturnType<Page['locator']>): Promise<void> {
  const [around, inside] = [await spot(page).boundingBox(), await anchor.boundingBox()];
  if (around === null || inside === null) throw new Error('the spotlight and its anchor have boxes');
  expect(around.x).toBeLessThanOrEqual(inside.x - PAD + SLACK);
  expect(around.y).toBeLessThanOrEqual(inside.y - PAD + SLACK);
  expect(around.x + around.width).toBeGreaterThanOrEqual(inside.x + inside.width + PAD - SLACK);
  expect(around.y + around.height).toBeGreaterThanOrEqual(inside.y + inside.height + PAD - SLACK);
}

async function expectInWindow(page: Page, step: number): Promise<void> {
  const box = await dialog(page, step).boundingBox();
  const size = page.viewportSize();
  if (box === null || size === null) throw new Error('the popover has a box');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  expect(box.width).toBeLessThanOrEqual(340);
}

test.describe('the guided tour', () => {
  test('starts by itself on Home, walks into the demo case, and Done stores completed for every browser', async ({ page, browser }, testInfo) => {
    const calls: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) calls.push(`${request.method()} ${pathname}`);
    });
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    await expect(dialog(page, 1).getByRole('heading', { name: 'Start with an entity' })).toBeVisible();
    await expectAround(page, page.locator('.home-search'));
    await expectInWindow(page, 1);
    await page.screenshot({ path: testInfo.outputPath('tour-step-1.png') });
    await dialog(page, 1).getByRole('button', { name: 'Next' }).click();

    await expect(dialog(page, 2)).toBeVisible();
    await expect(page).toHaveURL(/\/explore\//);
    const before = calls.length;
    const shownBefore = await page.getByRole('group', { name: 'Graph scope' }).innerText();
    await expect(dialog(page, 2).getByRole('heading', { name: 'Read the network' })).toBeVisible();
    await expectAround(page, page.getByRole('group', { name: 'Graph scope' }));
    await expectInWindow(page, 2);
    await page.screenshot({ path: testInfo.outputPath('tour-step-2.png') });
    await dialog(page, 2).getByRole('button', { name: 'Next' }).click();

    await expect(dialog(page, 3)).toBeVisible();
    await expect(dialog(page, 3).getByRole('heading', { name: 'Right-click for actions' })).toBeVisible();
    await expect(spot(page)).toBeVisible();
    await expectInWindow(page, 3);
    await page.screenshot({ path: testInfo.outputPath('tour-step-3.png') });
    await dialog(page, 3).getByRole('button', { name: 'Next' }).click();

    await expect(dialog(page, 4)).toBeVisible();
    await expect(dialog(page, 4).getByRole('heading', { name: 'Keep your work' })).toBeVisible();
    await expect(spot(page)).toBeVisible();
    await expectInWindow(page, 4);
    await page.screenshot({ path: testInfo.outputPath('tour-step-4.png') });
    await dialog(page, 4).getByRole('button', { name: 'Back' }).click();
    await expect(dialog(page, 3)).toBeVisible();
    await dialog(page, 3).getByRole('button', { name: 'Next' }).click();
    await dialog(page, 4).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // steps 2 to 4 read, expand and save nothing: the only call of the walk is the store of the choice
    expect(calls.slice(before).filter((call) => call !== 'PUT /v1/me/preferences')).toEqual([]);
    expect(await page.getByRole('group', { name: 'Graph scope' }).innerText()).toBe(shownBefore);
    await expect.poll(() => stored(page)).toEqual({ tour: 'completed' });

    await page.goto('/');
    await expect(page.getByRole('searchbox', { name: 'Search text' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4175', viewport: page.viewportSize() });
    const second = await other.newPage();
    await second.goto('/');
    await expect(second.getByRole('searchbox', { name: 'Search text' })).toBeVisible();
    await expect(second.getByRole('dialog')).toHaveCount(0);
    await other.close();
  });

  test('Esc closes it, stores skipped and gives the focus back; the Help item shows it again', async ({ page }) => {
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    await expect(dialog(page, 1).getByRole('button', { name: 'Next' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => stored(page)).toEqual({ tour: 'skipped' });
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Search text' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'Take the tour' }).click();
    await expect(dialog(page, 1)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog(page, 1).getByRole('button', { name: 'Skip tour' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page, 1).getByRole('button', { name: 'Next' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page, 2)).toBeVisible();
  });

  test('follows its anchor when the window is resized and keeps the popover inside the window', async ({ page }) => {
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => {
        const [around, inside] = [await spot(page).boundingBox(), await page.locator('.home-search').boundingBox()];
        return around !== null && inside !== null && Math.abs(around.x - (inside.x - PAD)) <= SLACK && Math.abs(around.width - (inside.width + PAD * 2)) <= SLACK;
      }).toBe(true);
      await expectInWindow(page, 1);
    }
  });

  test('follows its anchor when the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    const scrolled = await page.evaluate(() => {
      const region = [...document.querySelectorAll<HTMLElement>('*')].find((element) => element.scrollHeight > element.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
      const holder = region ?? document.scrollingElement;
      if (!(holder instanceof HTMLElement) || holder.scrollHeight <= holder.clientHeight) return false;
      holder.scrollTop = 60;
      return holder.scrollTop > 0;
    });
    expect(scrolled, 'the page has a scrolling region at this height').toBe(true);
    await expect.poll(async () => {
      const [around, inside] = [await spot(page).boundingBox(), await page.locator('.home-search').boundingBox()];
      return around !== null && inside !== null && Math.abs(around.y - (inside.y - PAD)) <= SLACK;
    }).toBe(true);
  });

  test('leaves the Export dialog its own Esc while the tour is on step 4', async ({ page }) => {
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    await dialog(page, 1).getByRole('button', { name: 'Next' }).click();
    for (const step of [2, 3]) await dialog(page, step).getByRole('button', { name: 'Next' }).click();
    await expect(dialog(page, 4)).toBeVisible();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exporting = page.getByRole('dialog').filter({ hasNotText: 'STEP 4 OF 4' });
    await expect(exporting).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exporting).toHaveCount(0);
    await expect(dialog(page, 4)).toBeVisible();
    expect(await stored(page)).toEqual({});
  });

  test('leaving Home ends it and stores nothing', async ({ page }) => {
    await page.goto('/');
    await expect(dialog(page, 1)).toBeVisible();
    await page.getByRole('link', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await stored(page)).toEqual({});
  });
});
