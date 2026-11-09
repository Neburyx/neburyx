import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, menuOf, openSample } from './support/workspace.ts';

const lines = (page: Page) => page.locator('.graph-scope p');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions' });

async function selectFirst(page: Page, count = 1): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  for (let more = 1; more < count; more += 1) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
  }
}

test.describe('hide from view', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
  });

  test('hides the selected entity on Delete, counts it on the first scope line, and shows it again from the line', async ({ page }) => {
    await expect(lines(page).nth(1)).toContainText('10 shown');
    await selectFirst(page);
    await page.keyboard.press('Delete');
    await expect(lines(page).first()).toContainText('1 hidden from view');
    await expect(lines(page).nth(1)).toContainText('9 shown');
    await page.getByRole('button', { name: 'Show 1 hidden entity' }).click();
    await expect(lines(page).first()).not.toContainText('hidden from view');
    await expect(lines(page).nth(1)).toContainText('10 shown');
    await expect(canvasOf(page)).toBeFocused();
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('hides by the node menu and by the action bar to the same result, and keeps the pointer on the canvas under the backdrop', async ({ page }) => {
    await selectFirst(page);
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Hide from view' }).click();
    await expect(lines(page).first()).toContainText('1 hidden from view');
    await page.getByRole('button', { name: 'Show 1 hidden entity' }).click();

    await selectFirst(page, 2);
    await bar(page).getByRole('button', { name: 'Hide' }).click();
    await expect(lines(page).first()).toContainText('2 hidden from view');
    await expect(lines(page).nth(1)).toContainText('8 shown');
    await expect(bar(page)).toHaveCount(0);

    expect(await page.locator('.graph-scope').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    expect(await page.locator('.graph-scope-show').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    expect(apartFromInspector(requests)).toEqual([]);
  });
});
