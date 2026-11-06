import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const sourceLine = (page: Page) => page.locator('section[aria-label="Source"]');
const rows = (page: Page) => page.locator('.recent-row');
const stamp = (): string => String(Date.now()).slice(-8);

async function openByLink(page: Page, source: string, stableId: string): Promise<void> {
  await page.goto(`/${source}/entity/account/${stableId}`);
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

function requests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/v1/') || pathname === '/healthz' || pathname === '/readyz') seen.push(`${request.method()} ${pathname.replace(/[0-9a-f-]{36}/, ':id')}`);
  });
  return seen;
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test.describe('Home: the Recent list in a browser', () => {
  test('lists the investigations of both sources with their sources, newest first, five at most, and says so when there are more', async ({ page }) => {
    const id = stamp();
    await openByLink(page, 'banking-demo', `HA-${id}`);
    await openByLink(page, 'claims-demo', `HB-${id}`);
    await page.goto('/');
    await expect(rows(page).first()).toContainText(`account HB-${id}`);
    await expect(rows(page).first()).toContainText('claims-demo');
    await expect(rows(page).nth(1)).toContainText(`account HA-${id}`);
    await expect(rows(page).nth(1)).toContainText('banking-demo');
    for (const suffix of ['C', 'D', 'E', 'F']) await openByLink(page, 'banking-demo', `H${suffix}-${id}`);
    await page.goto('/');
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByText('Showing the 5 most recent.')).toBeVisible();
    await expect(rows(page).first()).toContainText(`account HF-${id}`);
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(page.getByText('An investigation opens with its starting entity.')).toBeVisible();
    await expect(rows(page).first().locator('.badge')).toHaveText('Unsaved');
    await expect(rows(page).first().locator('time')).toHaveAttribute('dateTime', /^20\d\d-/);
  });

  test('opens the investigation a row lists, by its ID, sends no open, and a reload shows only its starting entity', async ({ page }) => {
    const id = stamp();
    await openByLink(page, 'claims-demo', `HR-${id}`);
    const sent = requests(page);
    await page.goto('/');
    const row = rows(page).first();
    await expect(row).toContainText(`account HR-${id}`);
    const listed = (await row.getByRole('link').getAttribute('href')) ?? '';
    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`${listed}$`));
    await expect(heading(page)).toHaveText(`account HR-${id}`);
    await expect(sourceLine(page)).toContainText('claims-demo');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(sent.filter((line) => line === 'POST /v1/investigations')).toEqual([]);
    await page.reload();
    await expect(heading(page)).toHaveText(`account HR-${id}`);
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });

  test('returns to each of two investigations opened from Recent, in two sources, by Back and Forward, with its source, title and graph, and no read of the investigation or its entity', async ({ page }) => {
    const id = stamp();
    await openByLink(page, 'banking-demo', `HX-${id}`);
    await openByLink(page, 'claims-demo', `HY-${id}`);
    await page.goto('/');
    await rows(page).filter({ hasText: `HX-${id}` }).getByRole('link').click();
    await expect(heading(page)).toHaveText(`account HX-${id}`);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await rows(page).filter({ hasText: `HY-${id}` }).getByRole('link').click();
    await expect(heading(page)).toHaveText(`account HY-${id}`);
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    const sent = requests(page);
    const drain = async (): Promise<string[]> => {
      await page.waitForLoadState('networkidle');
      return sent.splice(0).sort();
    };
    await drain();
    const atHome = ['GET /v1/investigations', 'GET /v1/sources/banking-demo/profile', 'GET /v1/sources/claims-demo/profile'];
    for (let round = 0; round < 2; round += 1) {
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
      expect(await drain(), 'Home reads its list and the profile of each source among its rows').toEqual(atHome);
      await page.goBack();
      await expect(heading(page)).toHaveText(`account HX-${id}`);
      await expect(sourceLine(page)).toContainText('banking-demo');
      await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
      expect(await drain(), 'the first investigation returns with only the profile of its source read again').toEqual(['GET /v1/sources/banking-demo/profile']);
      await page.goForward();
      await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
      expect(await drain()).toEqual(atHome);
      await page.goForward();
      await expect(heading(page)).toHaveText(`account HY-${id}`);
      await expect(sourceLine(page)).toContainText('claims-demo');
      await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
      expect(await drain(), 'the second investigation returns with only the profile of its source read again').toEqual(['GET /v1/sources/claims-demo/profile']);
    }
  });
});

test.describe('Home: the search box and the deep link in a browser', () => {
  test('searches from Home with the text in the history entry and not in the address, and a reload, Back and Forward show the results again', async ({ page }) => {
    await page.goto('/');
    const form = page.getByRole('search');
    await expect(form.getByRole('searchbox', { name: 'Search text' })).toHaveAttribute('placeholder', 'Search an entity or ID');
    await form.getByRole('searchbox', { name: 'Search text' }).fill('AC-77');
    await form.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/\/search\?source=[a-z-]+$/);
    expect(page.url()).not.toContain('AC-77');
    await expect(page.getByText('Exact ID match')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Exact ID match')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('search')).toBeVisible();
    await page.goForward();
    await expect(page.getByText('Exact ID match')).toBeVisible();
  });

  test('opens a pasted link from Home and Back returns to Home; a malformed or foreign link sends nothing; a link to the source that is listed but refused shows the page for a link that cannot be opened', async ({ page }) => {
    const id = stamp();
    await page.goto('/');
    const sent = requests(page);
    await page.getByRole('button', { name: 'Open a deep link' }).click();
    const form = page.getByRole('form', { name: 'Open a link' });
    for (const text of ['hello', 'https://evil.example.test/banking-demo/entity/account/AC-1']) {
      await form.getByLabel('Link').fill(text);
      await form.getByRole('button', { name: 'Open' }).click();
      await expect(form.getByRole('alert')).toBeVisible();
    }
    expect(sent.filter((line) => line.startsWith('POST'))).toEqual([]);
    await form.getByLabel('Link').fill(`/banking-demo/entity/account/HL-${id}`);
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(heading(page)).toHaveText(`account HL-${id}`);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Open a deep link' }).click();
    await page.getByRole('form', { name: 'Open a link' }).getByLabel('Link').fill('/restricted-demo/entity/account/AC-1');
    await page.getByRole('form', { name: 'Open a link' }).getByRole('button', { name: 'Open' }).click();
    await expect(heading(page)).toHaveText('Nothing was found at this link');
  });
});
