import { buildTwoSteps, patternBuilder, patternsPanel, openPatternList } from './support/pattern-editor.ts';
import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4175' });

test.describe('running a built pattern on each source of the second server', () => {
  for (const source of ['banking-demo', 'claims-demo']) {
    test(`previews and runs a two-step pattern on ${source}`, async ({ page }) => {
      await page.goto('/dev/open-entity');
      await page.getByRole('button', { name: source, exact: true }).click();
      const form = page.getByRole('form', { name: 'Open an entity' });
      await form.getByLabel('Stable ID').fill('AC-1');
      await form.getByRole('button', { name: 'Open' }).click();
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await openPatternList(page);
      await buildTwoSteps(page);
      await patternBuilder(page).getByRole('button', { name: 'Preview' }).click();
      const panel = patternsPanel(page);
      await expect(panel.getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
      await expect(panel.getByText('Follows USES_DEVICE outgoing to a device.')).toBeVisible();
      await panel.getByRole('button', { name: 'Run pattern' }).click();
      await expect(panel.getByRole('heading', { name: 'Pattern result' })).toBeVisible();
      await expect(panel.getByRole('status').filter({ hasText: 'Exact' }).first()).toHaveText('2 matches · Exact');
      await expect(panel.locator('.run-match').first().getByRole('list', { name: 'Path' })).toContainText('MID-1');
      await expect(panel).toContainText('1 supernode was not traversed.');
      await expect(panel).toContainText('The window did not apply to 1 relationship type.');
    });
  }
});
