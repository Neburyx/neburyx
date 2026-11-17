import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { openPatternList, patternsPanel as panelOf, press } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['NEBURYX_UX_SHOTS'];
  if (folder === undefined || folder === '') return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: false });
}

const rowOf = (page: Page, name: string) => panelOf(page).getByRole('listitem').filter({ has: page.getByRole('button', { name, exact: true }) });

test.describe('the AML typologies of a mapping in the Patterns panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await page.request.post('/__support/patterns-mode', { data: { typologies: true } });
    await openOneEntity(page, SOURCE, 'AC-1');
    await openPatternList(page);
  });

  test.afterEach(async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
  });

  test('lists the four under "Built-in · AML typologies" with the AML tag and a sentence, opens a row to its steps in words, and the others stay under "Built-in · general"', async ({ page }) => {
    const panel = panelOf(page);
    await expect(panel.getByRole('heading', { name: 'Built-in · AML typologies · 4' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Built-in · general · 3' })).toBeVisible();
    for (const name of ['Fan-out', 'Fan-in', 'Cycles', 'Rapid pass-through']) await expect(panel.getByRole('button', { name: `Run ${name}` })).toBeVisible();
    await expect(panel.getByText('One account sends to many accounts.')).toBeVisible();
    await rowOf(page, 'Rapid pass-through').getByRole('button', { name: 'Rapid pass-through', exact: true }).click();
    const words = panel.getByRole('region', { name: 'Rapid pass-through: Steps in words' });
    await expect(words).toContainText('follow TRANSFERRED_TO forward to a account, after the previous step (by transferredAt), within 24 hours');
    await rowOf(page, 'Fan-out').getByRole('button', { name: 'Fan-out', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Fan-out: Steps in words' })).toContainText('follow TRANSFERRED_TO forward to at least 10 other accounts');
    await shot(page, 'typologies-list');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('runs a typology from its row through the preview with a built-in note and no Save, and the way back leaves the list as it was', async ({ page }) => {
    const panel = panelOf(page);
    const mine = (await panel.getByRole('heading', { name: /^My patterns/ }).textContent()) ?? '';
    await press(page, panel.getByRole('button', { name: 'Run Cycles' }));
    await expect(panel.getByRole('heading', { name: 'Cycles', exact: true })).toBeVisible();
    await expect(panel.getByText('Built-in typology', { exact: true })).toBeVisible();
    await expect(panel.getByText('A built-in typology. Copy to builder opens a copy of it; the built-in itself does not change.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Save pattern/ })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Copy to builder$/ })).toBeVisible();
    await expect(panel.getByRole('region', { name: 'In plain words' })).toContainText('close back at the start');
    await shot(page, 'typologies-run-preview');
    await press(page, panel.getByRole('button', { name: 'Back to patterns' }));
    await expect(panel.getByRole('heading', { name: 'Built-in · AML typologies · 4' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: /^My patterns/ })).toHaveText(mine);
  });

  test('copies a typology to the builder as a draft that is not saved, with its kinds kept and shown, and the built-in unchanged', async ({ page }) => {
    const panel = panelOf(page);
    const mine = (await panel.getByRole('heading', { name: /^My patterns/ }).textContent()) ?? '';
    await press(page, panel.getByRole('button', { name: /^More: Rapid pass-through/ }));
    await page.getByRole('menuitem', { name: 'Copy' }).click();
    await expect(panel.getByText('Copy of Rapid pass-through · not saved')).toBeVisible();
    const chain = panel.locator('.pattern-chain');
    await expect(chain).toContainText('after previous');
    await expect(chain).toContainText('within 24 h');
    await expect(panel.getByRole('region', { name: 'In words' })).toContainText('after the previous step (by transferredAt), within 24 hours');
    await shot(page, 'typologies-copy-in-builder');
    await press(page, panel.getByRole('button', { name: 'Cancel' }));
    const discard = page.getByRole('dialog');
    if (await discard.count() > 0) await press(page, discard.getByRole('button', { name: 'Discard draft' }));
    await expect(panel.getByRole('heading', { name: 'Built-in · AML typologies · 4' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: /^My patterns/ })).toHaveText(mine);
  });

  test('runs a typology with Run pattern, shows the result under its name with Copy to builder, and keeps nothing', async ({ page }) => {
    const panel = panelOf(page);
    const mine = (await panel.getByRole('heading', { name: /^My patterns/ }).textContent()) ?? '';
    await press(page, panel.getByRole('button', { name: 'Run Fan-out' }));
    await expect(panel.getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Run pattern' }).click();
    await expect(panel.getByText('2 matches')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Fan-out', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy to builder' })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Save pattern/ })).toHaveCount(0);
    await shot(page, 'typologies-run-result');
    await press(page, panel.getByRole('button', { name: 'Back to patterns' }));
    await expect(panel.getByRole('heading', { name: /^My patterns/ })).toHaveText(mine);
  });

  test('saves a copy of a typology as the person’s own pattern with its fan kept, and the built-in stays', async ({ page }) => {
    const panel = panelOf(page);
    await press(page, panel.getByRole('button', { name: /^More: Fan-out/ }));
    await page.getByRole('menuitem', { name: 'Copy' }).click();
    await expect(panel.getByText('Copy of Fan-out · not saved')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Preview' })).toBeEnabled();
    await press(page, panel.getByRole('button', { name: 'Preview' }));
    await press(page, panel.getByRole('button', { name: 'Save pattern…' }));
    await press(page, page.getByRole('dialog').getByRole('button', { name: 'Save' }));
    await expect(panel.getByText('Account → TRANSFERRED_TO → Account (at least 10 neighbours)').first()).toBeVisible();
    await press(page, panel.getByRole('button', { name: 'Close Patterns' }));
    await openPatternList(page);
    await expect(panel.getByRole('heading', { name: 'Built-in · AML typologies · 4' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Account → TRANSFERRED_TO → Account (at least 10 neighbours)', level: 4 })).toBeVisible();
  });

  test('keeps and marks the order of a copied rapid pass-through when its first step is removed, and Undo gives it back', async ({ page }) => {
    const panel = panelOf(page);
    await press(page, panel.getByRole('button', { name: /^More: Rapid pass-through/ }));
    await page.getByRole('menuitem', { name: 'Copy' }).click();
    await panel.getByRole('tab', { name: /^Step 1( !)?$/ }).click();
    await press(page, panel.getByRole('button', { name: 'Remove step' }));
    const banner = panel.getByRole('group', { name: 'Changes that break the pattern' });
    await expect(banner).toContainText('it is ordered after the previous step, and it is now the first step, which has none.');
    await expect(panel.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await expect(panel.locator('.pattern-chain')).toContainText('within 24 h');
    await press(page, banner.getByRole('button', { name: 'Undo change' }));
    await expect(banner).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  test('keeps and marks the closing of a copied cycle when a step is added after it, and Undo gives it back', async ({ page }) => {
    const panel = panelOf(page);
    await press(page, panel.getByRole('button', { name: /^More: Cycles/ }));
    await page.getByRole('menuitem', { name: 'Copy' }).click();
    await press(page, panel.getByRole('button', { name: '+ Step' }));
    const banner = panel.getByRole('group', { name: 'Changes that break the pattern' });
    await expect(banner).toContainText('it closes the cycle at the start, and it is no longer the last step');
    await expect(panel.locator('.pattern-chain')).toContainText('closes back');
    await expect(panel.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await press(page, banner.getByRole('button', { name: 'Undo change' }));
    await expect(banner).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });
});
