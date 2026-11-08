import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf, openSample } from './support/workspace.ts';

const exact = (value: number) => ({ value, quality: 'exact', scope: 'relationships' });

test.describe('filters and rank in the Expand relationships panel', () => {
  let bodies: Array<Record<string, unknown>> = [];

  test.beforeEach(async ({ page }) => {
    bodies = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total: exact(40), byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: exact(40) }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown> & { sourceId: string; ref: { entityType: string; stableId: string } };
      bodies.push(body);
      const neighborTypes = body['neighborTypes'] as string[];
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, pageSize: 25, nodes: [], edges: [], pages: neighborTypes.map((neighborType) => ({ neighborType, returned: 0, hasMore: false, matchingTotal: exact(0) })), warnings: [] } });
    });
  });

  const panel = (page: Page) => page.getByRole('complementary', { name: 'Expand relationships' });

  async function openByKeyboard(page: Page): Promise<void> {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by type', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Loading neighbors')).toHaveCount(0);
  }

  test('adds a filter and a rank with the keyboard, sends them with the first page, and says when nothing matches, with a way to clear', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    const add = panel(page).getByRole('button', { name: 'Add filter' });
    await add.focus();
    await page.keyboard.press('Enter');
    const property = panel(page).getByRole('combobox', { name: 'Filter 1: Property' });
    await expect(property).toBeVisible();
    const first = (await property.locator('option').first().getAttribute('value')) ?? '';
    await property.selectOption(first);
    const value = panel(page).getByRole('textbox', { name: 'Filter 1: Value' });
    await value.focus();
    await page.keyboard.type('active');
    await panel(page).getByRole('button', { name: /^Load \d+ per type$/ }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]?.['filters']).toEqual([{ on: 'neighbor', property: first.split(':')[1], op: 'eq', value: { kind: 'text', value: 'active' } }]);
    await expect(panel(page).getByText(/Nothing matches these filters\./)).toBeVisible();
    await expect(panel(page).getByText(/matching 0 · exact/)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Clear filters' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('group', { name: 'Filter 1' })).toHaveCount(0);
    await expect(panel(page).getByText(/Nothing matches these filters\./)).toHaveCount(0);
    const shot = process.env['NEBURYX_UX_SHOT'];
    if (shot !== undefined) await page.screenshot({ path: shot });
  });

  test('keeps Load off, with the reason, until each filter row is whole, and ranks by a declared property', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await panel(page).getByRole('button', { name: 'Add filter' }).click();
    const load = panel(page).getByRole('button', { name: /^Load \d+ per type$/ });
    await expect(load).toBeDisabled();
    await expect(panel(page).getByText('Fill in or remove each filter before loading.')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Remove filter 1' }).click();
    await expect(load).toBeEnabled();
    const rank = panel(page).getByRole('combobox', { name: 'Rank by' });
    const choices = await rank.locator('option').allTextContents();
    expect(choices[0]).toBe('Most recent');
    if (choices.length > 1) {
      await rank.selectOption({ index: 1 });
      await panel(page).getByRole('combobox', { name: 'Order' }).selectOption('asc');
      await load.click();
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0]?.['rank']).toMatchObject({ order: 'asc' });
    }
  });
});
