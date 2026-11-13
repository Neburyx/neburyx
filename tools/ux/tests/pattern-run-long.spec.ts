import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { patternsPanel as panelOf, previewTwoSteps } from './support/pattern-editor.ts';
import { LONG_MATCHES } from '../src/support-pattern-runs.ts';

const SOURCE = 'banking-demo';

const fits = async (box: Locator): Promise<boolean> => box.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);

async function previewedLong(page: Page): Promise<void> {
  await openOneEntity(page, SOURCE, 'LONG-1');
  await previewTwoSteps(page);
}

test.describe('labels as long as a mapping can make them', () => {
  test('keeps the preview and the chosen entity within the panel, the entity named once and the helper gone', async ({ page }) => {
    await previewedLong(page);
    const panel = panelOf(page);
    await expect(panel.locator('.run-start-chosen')).toHaveText('Chosen: account LONG-1');
    await expect(panel.locator('#run-start-help')).toHaveCount(0);
    await expect(panel.locator('.run-bounds')).toBeVisible();
    expect(await fits(panel.locator('.run-body'))).toBe(true);
  });

  test('keeps every match card within the panel, shows the untitled match by its ID and the long title whole to a screen reader, and folds the many properties', async ({ page }) => {
    await previewedLong(page);
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'Run pattern' }).click();
    await expect(panel.getByRole('heading', { name: 'Pattern result' })).toBeVisible();
    const cards = panel.locator('.run-match');
    await expect(cards).toHaveCount(2);
    expect(await fits(panel.locator('.run-body'))).toBe(true);
    for (const index of [0, 1]) expect(await fits(cards.nth(index))).toBe(true);
    await expect(cards.nth(0).getByRole('list', { name: 'Path' })).toContainText(LONG_MATCHES.titled.slice(0, 40));
    await expect(cards.nth(1).getByRole('list', { name: 'Path' })).toContainText(LONG_MATCHES.untitledId);
    await expect(cards.nth(0).locator('.run-detail')).toHaveCount(3);
    await expect(cards.nth(0).locator('.run-detail').filter({ hasText: /^empty/ })).toHaveCount(0);
    await cards.nth(0).getByRole('button', { name: /^Show all properties \(\d+\)$/ }).click();
    await expect(cards.nth(0).locator('.run-detail')).toHaveCount(25);
    expect(await fits(cards.nth(0))).toBe(true);
    await panel.getByRole('button', { name: 'About these counts' }).click();
    await expect(panel.getByText(/^Counts are always labelled/)).toBeVisible();
  });
});
