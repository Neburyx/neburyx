import { expect, test, type Page } from '@playwright/test';
import { lookOf, tokenColour, focusWidth } from './support/controls.ts';
import { canvasOf } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const DEMO_CASE = { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' };

const post = (page: Page, path: string, data: unknown = {}) => page.request.post(path, { data });
const main = (page: Page) => page.getByRole('main');
const firstRunPage = (page: Page) => page.locator('.first-run');

async function startFresh(page: Page, sources: Record<string, unknown>): Promise<void> {
  expect((await post(page, '/__support/forget-investigations')).ok()).toBe(true);
  expect((await post(page, '/__support/sources', sources)).ok()).toBe(true);
}

test.beforeEach(async ({ page }) => startFresh(page, { 'banking-demo': { demoCase: DEMO_CASE } }));

test.afterEach(async ({ page }) => {
  await post(page, '/__support/reset');
  await post(page, '/__support/forget-investigations');
});

function requests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/v1/')) seen.push(`${request.method()} ${pathname}`);
  });
  return seen;
}

test.describe('First run in a browser', () => {
  test('starts a demo-only install on First run, with none of Home, and no sideways scroll', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No investigations yet', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Investigations', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open demo case' })).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Recent' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Source health' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('opens the preset with its case reference through the ordinary open, once, and goes back to Home with the investigation and no First run on the way', async ({ page }) => {
    const sent = requests(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open demo case' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await expect(page.getByText(DEMO_CASE.caseRef)).toBeVisible();
    expect(sent.filter((entry) => entry === 'POST /v1/investigations')).toHaveLength(1);
    await page.evaluate(() => {
      Object.assign(window, { sawFirstRun: false });
      new MutationObserver(() => {
        if (document.querySelector('.first-run') !== null) Object.assign(window, { sawFirstRun: true });
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.goBack();
    await expect(page.locator('.recent-row').first()).toContainText(`account ${DEMO_CASE.stableId}`);
    expect(await page.evaluate(() => Reflect.get(window, 'sawFirstRun'))).toBe(false);
    await expect(firstRunPage(page)).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toBeVisible();
  });

  test('opens the preset from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open demo case' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  });

  test('shows Home, with the real source Unavailable and its reason and no First run, for an investigation of a source that is down', async ({ page }) => {
    await page.goto(`/banking-demo/entity/account/FR-${String(Date.now()).slice(-8)}`);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    expect((await post(page, '/__support/sources', { 'banking-demo': { synthetic: false, state: 'unavailable', stateReason: 'Connection refused' } })).ok()).toBe(true);
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Source health' });
    await expect(card).toContainText('Unavailable');
    await expect(card).toContainText('Connection refused');
    await expect(page.locator('.recent-row').first()).toContainText('Source unavailable');
    await expect(main(page).getByText('No source connected')).toHaveCount(0);
    await expect(firstRunPage(page)).toHaveCount(0);
  });

  test('shows Home for a connected real source and no investigation', async ({ page }) => {
    expect((await post(page, '/__support/sources', { 'banking-demo': { synthetic: false } })).ok()).toBe(true);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No investigations yet', level: 3 })).toBeVisible();
    await expect(page.getByText('Search for an entity or open a deep link.')).toBeVisible();
  });

  test('offers Open the demo case on Home beside Open a deep link, and opens the preset again from there', async ({ page }) => {
    await page.goto(`/banking-demo/entity/${DEMO_CASE.entityType}/${DEMO_CASE.stableId}?caseRef=${DEMO_CASE.caseRef}`);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    const first = page.url();
    await page.goto('/');
    const entry = page.getByRole('button', { name: 'Open the demo case' });
    await expect(entry).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a deep link' })).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(first);
  });

  test('shows the setup note and the three steps inside the viewport, moves focus to the note on Connect your Neo4j, and copies the command', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.getByText('No sign-in')).toBeVisible();
    await expect(page.getByText('No source of your own connected')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Getting started' }).getByRole('heading', { level: 3 })).toHaveText(['Map your schema in YAML', 'Search or open a deep link', 'Expand safely and verify relationships']);
    const viewport = page.viewportSize();
    for (const name of ['Source setup', 'Getting started']) {
      const box = await page.getByRole('region', { name }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
    }
    await page.getByRole('button', { name: 'Connect your Neo4j' }).click();
    await expect(page.getByRole('region', { name: 'Source setup' })).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('neburyx test-source --name <source>');
    await expect(page.locator('main')).not.toContainText(/edition/i);
  });

  test('draws the focus outline on Open demo case, Connect your Neo4j and Copy, in reading order', async ({ page }) => {
    await page.goto('/');
    const focus = await tokenColour(page, '--color-focus');
    const order = [page.getByRole('button', { name: 'Open demo case' }), page.getByRole('button', { name: 'Connect your Neo4j' }), page.getByRole('button', { name: 'Copy' })];
    await order[0]?.focus();
    for (const [index, control] of order.entries()) {
      if (index > 0) await page.keyboard.press('Tab');
      await expect(control, `stop ${index}`).toBeFocused();
      expect(await lookOf(control, ['outline-style', 'outline-width', 'outline-color']), `stop ${index}`).toEqual({ 'outline-style': 'solid', 'outline-width': await focusWidth(page), 'outline-color': focus });
    }
  });
});
