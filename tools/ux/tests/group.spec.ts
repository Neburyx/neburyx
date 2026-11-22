import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, openSample } from './support/workspace.ts';

const groupButton = (page: Page) => page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Group loaded nodes' });
const panel = (page: Page) => page.locator('.group-panel');

test.describe('grouping of loaded nodes', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
  });

  test('opens from the tool strip on the first choice, groups by entity type, lists the groups, collapses and ungroups, and fetches nothing', async ({ page }) => {
    await groupButton(page).click();
    await expect(groupButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByText('Rearranges what is loaded. Nothing new is fetched.')).toBeVisible();
    await expect(panel(page).getByText('GROUPS · 10 LOADED ITEMS')).toBeVisible();
    await expect(panel(page).getByRole('radio', { name: 'Entity type' })).toBeFocused();

    await panel(page).getByRole('radio', { name: 'Entity type' }).click();
    await expect(panel(page).getByText('Other types')).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '0');
    await panel(page).getByRole('button', { name: /^Expand / }).first().click();
    await expect(canvasOf(page)).not.toHaveAttribute('data-drawn-entities', '0');

    await panel(page).getByRole('button', { name: 'Ungroup all' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await expect(panel(page).getByText('No groups yet. Choose how to group.')).toBeVisible();
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('closes with Escape and gives the focus back to the tool', async ({ page }) => {
    await groupButton(page).click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(groupButton(page)).toBeFocused();
  });

  test('groups all by type from the canvas menu, through its submenu, and ungroups from the same menu', async ({ page }) => {
    await canvasOf(page).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByRole('menuitem', { name: 'Group all by type' }).click();
    await page.getByRole('menuitem', { name: 'All entity types' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '0');
    await canvasOf(page).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByRole('menuitem', { name: 'Ungroup all' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    expect(apartFromInspector(requests)).toEqual([]);
  });
});
