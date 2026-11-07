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
    await expect(rows.first()).toContainText('Used by rule shared-link v1');
    await expect(rows.nth(1)).not.toContainText('Used by rule');
  });

  test('draws no View evidence action while no evidence panel is registered, and a row has nothing else to focus', async ({ page }) => {
    await searchFor(page, 'ev-2');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (2)')).toBeVisible();
    await expect(page.getByRole('button', { name: /View evidence/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^Evidence records/ }).getByRole('button')).toHaveCount(0);
  });

  test('reads 26 supporting relationships as "≥ 25 · lower bound" and shows 25 rows', async ({ page }) => {
    await searchFor(page, 'ev-26');
    await expect(groupTitle(page, 'Evidence records · Supporting relationships (≥ 25 · lower bound)')).toBeVisible();
    await expect(page.getByText('1 exact match · ≥ 25 supporting relationships · lower bound · 0.18 s')).toBeVisible();
    await expect(page.getByRole('region', { name: /^Evidence records/ }).getByRole('listitem')).toHaveCount(25);
  });

  test('names a relationship left out of the evidence group, and says no relationship is configured for evidence for a source with none', async ({ page }) => {
    await searchFor(page, 'evdrop-1');
    await expect(page.getByText('LINKS (ACCOUNT → ACCOUNT): Evidence records are disabled for this relationship.')).toBeVisible();
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
});
