import { buildStepThroughUi } from './support/pattern-editor.ts';
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
      await page.getByRole('button', { name: 'Patterns', exact: true }).click();
      const panel = page.getByRole('complementary', { name: 'Patterns' });
      await panel.getByRole('button', { name: 'New pattern' }).click();
      const builder = panel.getByRole('region', { name: 'New pattern' });
      await builder.getByLabel('Starting entity type').selectOption({ label: 'Account' });
      await buildStepThroughUi(page, builder, 1, 'out', 'Device', ['USES_DEVICE']);
      await buildStepThroughUi(page, builder, 2, 'in', 'Account', ['USES_DEVICE']);
      await expect(builder.getByRole('region', { name: 'Preview' })).toBeVisible();
      await builder.getByRole('button', { name: 'Run pattern' }).click();
      const result = builder.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('2 · exact');
      await expect(result.getByRole('table')).toContainText('USES_DEVICE');
      await expect(result).toContainText('1 supernode was not traversed.');
      await expect(result).toContainText('The window did not apply to 1 relationship type.');
    });
  }
});
