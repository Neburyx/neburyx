import { expect, test } from '@playwright/test';
import { setNumber } from './support/pattern-editor.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

test.describe('the Patterns panel on each pack', () => {
  test('lists the presets of the pack the source declares', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'claims-demo', exact: true }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('CL-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Patterns', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Patterns' }).getByRole('heading', { name: 'Built-in · 2' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Patterns' }).getByRole('button', { name: /^Run (Shared addresses|Claims by claimant)$/ })).toHaveCount(2);
    await expect(page.getByRole('complementary', { name: 'Patterns' }).getByRole('heading', { level: 4 }).filter({ hasText: /^(Shared addresses|Claims by claimant)$/ })).toHaveText(['Shared addresses', 'Claims by claimant']);
  });

  test('lists the three presets of the banking pack on the first source', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo', exact: true }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('AC-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Patterns', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Patterns' }).getByRole('heading', { name: 'Built-in · 3' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Patterns' }).getByRole('heading', { level: 4 }).filter({ hasText: /^(Shared devices|Shared addresses|Connected accounts)$/ })).toHaveText(['Shared devices', 'Shared addresses', 'Connected accounts']);
  });

  for (const pack of [
    { source: 'banking-demo', type: 'account', entity: 'AC-1', preset: 'Shared devices', limit: 'Max matching accounts' },
    { source: 'claims-demo', type: 'claimant', entity: 'CL-1', preset: 'Shared addresses', limit: 'Max matching claimants' },
  ]) {
    test(`saves a built-in run of ${pack.source} with a changed limit and runs it from its row with the matches and evidence of the form`, async ({ page }) => {
      await page.request.post('/__support/reset');
      await page.goto('/dev/open-entity');
      await page.getByRole('button', { name: pack.source, exact: true }).click();
      const form = page.getByRole('form', { name: 'Open an entity' });
      await form.getByLabel('Entity type').selectOption(pack.type);
      await form.getByLabel('Stable ID').fill(pack.entity);
      await form.getByRole('button', { name: 'Open' }).click();
      await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
      await page.getByRole('button', { name: 'Patterns', exact: true }).click();
      const panel = page.getByRole('complementary', { name: 'Patterns' });
      await panel.getByRole('button', { name: `Run ${pack.preset}` }).click();
      await setNumber(panel, pack.limit, '5');
      await panel.getByRole('button', { name: 'Run pattern' }).click();
      await expect(panel.locator('.patterns-result')).toBeVisible();
      const fromForm = await panel.locator('.patterns-result').innerText();
      expect(fromForm).toMatch(/AUTH-/);
      expect(fromForm).toMatch(/lower bound|≥/i);
      await panel.getByRole('button', { name: 'Save pattern', exact: true }).click();
      await page.getByRole('dialog').getByLabel('Name').fill('Saved from the form');
      await page.getByRole('dialog').getByRole('button', { name: 'Save pattern' }).click();
      await expect(panel.getByText('Pattern saved.')).toBeVisible();
      await panel.getByRole('button', { name: 'Back to patterns' }).click();
      const row = panel.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Saved from the form', level: 4 }) });
      await expect(row).toContainText(`${pack.limit} 5`);
      await row.getByRole('button', { name: 'Run Saved from the form' }).click();
      await panel.getByRole('button', { name: 'Run pattern' }).click();
      await expect(panel.locator('.patterns-result')).toBeVisible();
      expect(await panel.locator('.patterns-result').innerText()).toBe(fromForm);
    });
  }
});
