import { expect, test, type Page } from '@playwright/test';

const SOURCE = 'banking-demo';

const box = (page: Page) => page.getByRole('searchbox', { name: 'Search text' });
const groupTitle = (page: Page, title: string) => page.getByRole('heading', { level: 2, name: title });

async function searchFor(page: Page, text: string): Promise<void> {
  await page.goto(`/search?source=${SOURCE}`);
  await box(page).fill(text);
  await box(page).press('Enter');
  expect(new URL(page.url()).search, 'the address holds the source and never the text').toBe(`?source=${SOURCE}`);
}

test.describe('evidence records', () => {
  test('lists the relationships that carry the record after the other groups, with their records and the rule that uses the type', async ({ page }) => {
    await searchFor(page, 'ev-3');
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (3)')).toBeVisible();
    await expect(page.getByText('1 exact match · 3 supporting relationships · 0.18 s')).toBeVisible();
    const rows = page.getByRole('region', { name: 'Evidence records · Supporting relationships (3)' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('LINKS');
    await expect(rows.first()).toContainText('1 record: REC-ev-3-1');
    await expect(rows.first()).toContainText('Rule shared-link v1 uses this relationship type');
    await expect(rows.nth(1)).not.toContainText('uses this relationship type');
    await expect(page.getByText('Used by rule')).toHaveCount(0);
  });

  test('draws one View evidence action on each row, the only control of the row', async ({ page }) => {
    await searchFor(page, 'ev-2');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (2)')).toBeVisible();
    const region = page.getByRole('region', { name: /^Evidence records/ });
    await expect(region.getByRole('button', { name: /^View evidence/ })).toHaveCount(2);
    await expect(region.getByRole('button')).toHaveCount(2);
  });

  test('reads 26 supporting relationships as "≥ 25 · lower bound" and shows 25 rows', async ({ page }) => {
    await searchFor(page, 'ev-26');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (≥ 25 · lower bound)')).toBeVisible();
    await expect(page.getByText('1 exact match · ≥ 25 supporting relationships · lower bound · 0.18 s')).toBeVisible();
    await expect(page.getByRole('region', { name: /^Evidence records/ }).getByRole('listitem')).toHaveCount(25);
  });

  test('names a relationship left out of the evidence group, and says no relationship is configured for evidence for a source with none', async ({ page }) => {
    await searchFor(page, 'evdrop-1');
    await expect(page.getByText('Not searched: LINKS (ACCOUNT → ACCOUNT) · recordId: no online index')).toBeVisible();
    await expect(page.getByText('No relationship of this source is configured for evidence records.')).toHaveCount(0);
    await searchFor(page, 'missing-1');
    await expect(page.getByText('No relationship of this source is configured for evidence records.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'No matching entities' })).toBeVisible();
  });

  test('keeps the other groups and says that the evidence records were not read when their read fails, and Retry repeats the search', async ({ page }) => {
    await searchFor(page, 'evfail-1');
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Evidence records were not read: the source did not answer within 5 s.');
    await expect(page.getByText('1 exact match · evidence records not read · 0.18 s')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'No matching entities' })).toHaveCount(0);
    await expect(page.getByText(/0 supporting/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(groupTitle(page, 'Exact ID match (1)')).toBeVisible();
  });

  test('shows an aggregate of relationships with no stable ID with its members as text, and Show more adds the next members to the same row by keyboard', async ({ page }) => {
    await searchFor(page, 'agg-30');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (≥ 25 · lower bound)')).toBeVisible();
    const aggregate = page.getByRole('region', { name: /^Evidence records/ }).locator('.search-hits > li');
    await expect(aggregate).toHaveCount(1);
    await expect(aggregate).toContainText('SEEN_WITH');
    await expect(aggregate).toContainText('≥ 25 relationships · lower bound');
    await expect(aggregate.locator('.search-member')).toHaveCount(25);
    await expect(aggregate.locator('.search-member').first()).toHaveText('1 record: REC-agg-30 · observed 2026-03-01T10:01:00Z');
    await expect(aggregate.getByRole('button')).toHaveCount(0);
    const more = page.getByRole('button', { name: 'Show more: Evidence records' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (30)')).toBeVisible();
    await expect(aggregate).toHaveCount(1);
    await expect(aggregate.locator('.search-member')).toHaveCount(30);
    await expect(aggregate).toContainText('30 relationships');
    await expect(page.locator(':focus')).toHaveText('1 record: REC-agg-30 · observed 2026-03-01T10:26:00Z');
  });

  test('keeps a supporting relationship whose evidence value cannot be shown, and says so with the property name', async ({ page }) => {
    await searchFor(page, 'evx-1');
    const row = page.getByRole('region', { name: 'Evidence records · Supporting relationships (1)' }).getByRole('listitem');
    await expect(row).toContainText('2 records: REC-evx-1, docId: Value cannot be shown');
  });

  test.describe('View evidence', () => {
    const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });
    const viewButtons = (page: Page) => page.getByRole('region', { name: /^Evidence records/ }).getByRole('button', { name: /^View evidence/ });

    function watchReads(page: Page): { readonly edges: string[]; readonly investigations: string[] } {
      const edges: string[] = [];
      const investigations: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.startsWith('/v1/edges/')) edges.push(url.pathname);
        if (request.method() === 'POST' && url.pathname === '/v1/investigations') investigations.push(url.pathname);
      });
      return { edges, investigations };
    }

    test('is reached by Tab in order, opens the panel with Enter on that relationship and returns the focus to the row with Esc', async ({ page }) => {
      const { edges, investigations } = watchReads(page);
      await searchFor(page, 'ev-2');
      await expect(viewButtons(page)).toHaveCount(2);
      const [first, second] = [viewButtons(page).nth(0), viewButtons(page).nth(1)];
      await expect(first).toHaveAccessibleName('View evidence: LINKS ev-2-l01');
      await expect(second).toHaveAccessibleName('View evidence: LINKS ev-2-l02');
      const address = page.url();
      await box(page).focus();
      for (let step = 0; step < 30 && !(await first.evaluate((button) => button === document.activeElement)); step += 1) await page.keyboard.press('Tab');
      await expect(first).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(second).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(first).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
      await expect(panel(page).getByText('REC-ev-2-l01')).toBeVisible();
      expect(edges).toHaveLength(1);
      expect(Buffer.from(decodeURIComponent(edges[0]?.split('/').pop() ?? ''), 'base64url').toString('utf8')).toContain('"stableId":"ev-2-l01"');
      expect(investigations).toEqual([]);
      expect(page.url()).toBe(address);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
      await expect(first).toBeFocused();
    });

    test('opens the second relationship by a click, and Close returns the focus to its button', async ({ page }) => {
      const { edges } = watchReads(page);
      await searchFor(page, 'ev-2');
      await viewButtons(page).nth(1).click();
      await expect(panel(page).getByText('REC-ev-2-l02')).toBeVisible();
      expect(edges).toHaveLength(1);
      await panel(page).getByRole('button', { name: 'Close relationship evidence' }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(viewButtons(page).nth(1)).toBeFocused();
    });

    test('says Evidence not available for a relationship without retained records, without an alert, and Esc returns the focus', async ({ page }) => {
      await searchFor(page, 'evold-1');
      const button = viewButtons(page).first();
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText('Evidence not available')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('is not offered by the results of the canvas Search panel', async ({ page }) => {
      await page.goto(`/${SOURCE}/entity/account/AC-1`);
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('tab', { name: 'Add from source' }).click();
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/search/entities');
      await page.getByRole('searchbox', { name: 'Find in the source' }).fill('ev-2');
      await answered;
      await expect(page.getByText('ev-2-1').first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Search' })).toBeVisible();
      await expect(page.getByRole('button', { name: /View evidence/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: /Evidence records/ })).toHaveCount(0);
    });
  });
});
