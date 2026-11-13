import { expect, test } from '@playwright/test';

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
});
