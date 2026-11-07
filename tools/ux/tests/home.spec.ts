import { expect, test, type Locator, type Page } from '@playwright/test';
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

const degradedTest = {
  checkedAt: '2026-10-30T10:16:08.000Z',
  outcome: 'warn',
  server: { product: 'Neo4j Kernel', version: '5.26.32' },
  versionSupported: true,
  readOnlyCheck: 'privileges-inspected',
  loginCanWrite: false,
  degreeStatus: 'warn',
  degreeWarnings: ['Degree counts are estimated for 1 entity type'],
};
const failedTest = { checkedAt: '2026-10-29T08:00:00.000Z', outcome: 'fail', server: null, versionSupported: null, readOnlyCheck: 'not-verified', loginCanWrite: null, degreeStatus: 'not-run', degreeWarnings: [] };

const healthCard = (page: Page) => page.getByRole('region', { name: 'Source health' });
const blockOf = (page: Page, alias: string) => healthCard(page).locator('li', { has: page.getByRole('heading', { name: alias, level: 3 }) });

async function factsOf(scope: Locator): Promise<string[][]> {
  const labels = await scope.locator('dt').allTextContents();
  const values = await scope.locator('dd').allTextContents();
  return labels.map((label, index): string[] => [label, values[index] ?? '']).filter(([label]) => label !== 'Connection');
}

async function onSourcesPage(page: Page, alias: string): Promise<{ readonly state: string; readonly reason: string | null; readonly facts: string[][] }> {
  const row = page.getByRole('list', { name: 'Configured sources' }).getByRole('button', { name: new RegExp(alias) });
  await row.click();
  const reason = row.locator('.source-reason');
  return { state: (await row.locator('.pill').textContent()) ?? '', reason: (await reason.count()) === 0 ? null : await reason.textContent(), facts: await factsOf(page.getByRole('region', { name: `${alias} health` })) };
}

async function onHome(page: Page, alias: string): Promise<{ readonly state: string; readonly reason: string | null; readonly facts: string[][] }> {
  const block = blockOf(page, alias);
  const reason = block.locator('.source-reason');
  return { state: (await block.locator('.pill').textContent()) ?? '', reason: (await reason.count()) === 0 ? null : await reason.textContent(), facts: await factsOf(block) };
}

test.describe('Home: the Source health card in a browser', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__support/reset');
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__support/reset');
  });

  test('shows a degraded and an unavailable source with the state, reason and facts the Sources page shows for them, with one read of the sources, no horizontal scroll, and the link to Sources by keyboard', async ({ page, request }) => {
    await request.post('/__support/sources', {
      data: {
        'banking-demo': { state: 'degraded', stateReason: 'Degree counts are estimated', lastTest: degradedTest, lastTestAt: degradedTest.checkedAt },
        'claims-demo': { state: 'unavailable', stateReason: 'Connection refused', lastTest: failedTest, lastTestAt: failedTest.checkedAt },
      },
    });
    const sent = requests(page);
    await page.goto('/');
    await expect(healthCard(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(sent.filter((line) => line === 'GET /v1/sources'), 'the one read of the sources is the shell\'s').toHaveLength(1);
    expect(await noHorizontalScroll(page)).toBe(true);
    const homeBlocks = new Map<string, Awaited<ReturnType<typeof onHome>>>();
    for (const alias of ['banking-demo', 'claims-demo', 'restricted-demo']) homeBlocks.set(alias, await onHome(page, alias));
    expect(homeBlocks.get('banking-demo')).toMatchObject({ state: 'Degraded', reason: 'Degree counts are estimated' });
    expect(homeBlocks.get('claims-demo')).toMatchObject({ state: 'Unavailable', reason: 'Connection refused' });
    expect(homeBlocks.get('restricted-demo')).toMatchObject({ state: 'Connected', reason: null });

    const link = healthCard(page).getByRole('link', { name: 'View sources →' });
    for (let presses = 0; presses < 40 && !(await link.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.getByRole('list', { name: 'Configured sources' }).getByRole('button')).toHaveCount(3);
    for (const alias of ['banking-demo', 'claims-demo', 'restricted-demo']) expect(await onSourcesPage(page, alias), alias).toEqual(homeBlocks.get(alias));
  });

  test('shows the held report of a test run on the Sources page while the following sources read is held back, and the stored test after it is released', async ({ page, request }) => {
    await request.post('/__support/hold-after-test');
    let answered = 0;
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/v1/sources') answered += 1;
    });
    await page.goto('/');
    await expect(healthCard(page)).toBeVisible();
    const answeredAtLoad = answered;
    const before = await onHome(page, 'banking-demo');
    expect(before.facts.map(([label, value]) => `${label}: ${value}`).slice(0, 2)).toEqual(['Last test: Never tested', 'Read-only verified: Not tested yet']);
    await page.getByRole('link', { name: 'Sources', exact: true }).click();
    await page.getByRole('region', { name: 'banking-demo health' }).getByRole('button', { name: 'Test source' }).click();
    await expect(page.getByText('Test finished: connected')).toBeVisible();
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(healthCard(page)).toBeVisible();
    const held = await onHome(page, 'banking-demo');
    expect(answered, 'the sources read that follows the test has not been answered').toBe(answeredAtLoad);
    expect(held.facts[0]?.[1]).not.toBe('Never tested');
    expect(held.facts[1]).toEqual(['Read-only verified', 'Privileges inspected']);
    await page.getByRole('link', { name: 'Sources', exact: true }).click();
    expect(await onSourcesPage(page, 'banking-demo')).toMatchObject({ facts: held.facts });
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    const stored = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/sources');
    await request.post('/__support/release');
    await stored;
    expect(answered).toBe(answeredAtLoad + 1);
    await expect(healthCard(page)).toBeVisible();
    expect(await onHome(page, 'banking-demo')).toMatchObject({ facts: held.facts });
    await page.getByRole('link', { name: 'Sources', exact: true }).click();
    expect(await onSourcesPage(page, 'banking-demo')).toMatchObject({ facts: held.facts });
  });
});

const library = (page: Page) => page.getByRole('group', { name: 'Library' });
const cardOf = (page: Page, title: string) => library(page).locator('.library-card', { has: page.getByRole('heading', { name: title, level: 3 }) });
const figureOf = async (page: Page, title: string): Promise<number> => Number(await cardOf(page, title).locator('.library-figure').textContent());

test.describe('Home: the library cards in a browser', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__support/reset');
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__support/reset');
  });

  test('shows the number of investigations opened in two sources with the sources they span, no saved view and the Patterns line, with no horizontal scroll, and the count grows by one with one more', async ({ page }) => {
    const id = stamp();
    await page.goto('/');
    await expect(cardOf(page, 'Investigations').locator('.library-figure')).toBeVisible();
    const before = await figureOf(page, 'Investigations');
    await openByLink(page, 'banking-demo', `LA-${id}`);
    await openByLink(page, 'claims-demo', `LB-${id}`);
    await page.goto('/');
    await expect(cardOf(page, 'Investigations').locator('.library-figure')).toHaveText(String(before + 2));
    await expect(cardOf(page, 'Investigations')).toContainText('Across 2 sources');
    await expect(cardOf(page, 'Saved views').locator('.library-figure')).toHaveText('0');
    await expect(cardOf(page, 'Saved views')).not.toContainText('Last edited');
    await expect(cardOf(page, 'Patterns')).toContainText('Built-in patterns are not available yet.');
    await expect(cardOf(page, 'Patterns').locator('.library-figure')).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(library(page).getByRole('link')).toHaveCount(0);
    await expect(library(page).getByRole('button')).toHaveCount(0);
    await openByLink(page, 'banking-demo', `LC-${id}`);
    await page.goto('/');
    await expect(cardOf(page, 'Investigations').locator('.library-figure')).toHaveText(String(before + 3));
    expect(await figureOf(page, 'Investigations')).toBeGreaterThanOrEqual(await page.locator('.recent-row').count());
  });

  test('sends one read of the list from a fresh load and none for the cards', async ({ page }) => {
    const sent = requests(page);
    await page.goto('/');
    await expect(cardOf(page, 'Investigations').locator('.library-figure')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(sent.filter((line) => line === 'GET /v1/investigations')).toHaveLength(1);
  });

  test('shows the count of named views and the time of the newest, in UTC, when the support server holds some', async ({ page, request }) => {
    await request.post('/__support/named-views', { data: { count: 3, lastEditedAt: '2026-11-05T09:42:00.000Z' } });
    await page.goto('/');
    await expect(cardOf(page, 'Saved views').locator('.library-figure')).toHaveText('3');
    await expect(cardOf(page, 'Saved views')).toContainText('Last edited 09:42 UTC');
  });
});
