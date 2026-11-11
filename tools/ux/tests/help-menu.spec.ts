import { expect, test, type Page } from '@playwright/test';

const ITEMS = ['Keyboard shortcuts', 'Documentation', 'Quickstart: the demo case', 'Talk to us about Enterprise', 'Report a problem'];
const REPOSITORY = 'NEBURYX_RELEASE_PLACEHOLDER_REPOSITORY_URL';
const EXTERNAL: ReadonlyArray<readonly [string, string]> = [
  ['Documentation', `${REPOSITORY}/tree/main/docs`],
  ['Quickstart: the demo case', `${REPOSITORY}#quickstart`],
  ['Talk to us about Enterprise', `${REPOSITORY}/discussions`],
  ['Report a problem', `${REPOSITORY}/issues`],
];

const helpButton = (page: Page) => page.getByRole('button', { name: 'Help' });
const menu = (page: Page) => page.getByRole('menu', { name: 'Help' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

async function openMenu(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await helpButton(page).click();
  await expect(menu(page)).toBeVisible();
}

test.describe('the Help menu on Home', () => {
  test('lists the five items of the design in order, with the divider, inside the viewport, and sits above the Help item', async ({ page }, testInfo) => {
    await openMenu(page);
    const rows = menu(page).getByRole('menuitem');
    await expect(rows).toHaveCount(5);
    const labels = await rows.evaluateAll((elements) => elements.map((element) => element.querySelector('.menu-label')?.textContent ?? ''));
    expect(labels).toEqual(ITEMS);
    await expect(menu(page).getByRole('separator')).toHaveCount(1);
    const box = await menu(page).boundingBox();
    const trigger = await helpButton(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(trigger).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? -1) + (box?.height ?? 0)).toBeLessThanOrEqual(trigger?.y ?? 0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
    expect(box?.width).toBe(272);
    await page.screenshot({ path: testInfo.outputPath('help-menu.png') });
  });

  test('works by keyboard: Enter opens on the first item, arrows move, Esc returns to the Help item, Tab leaves', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await helpButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: /^Documentation/ })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu(page).getByRole('menuitem', { name: /^Report a problem/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(helpButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu(page)).toHaveCount(0);
    await expect(helpButton(page)).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test('opens the shortcut sheet from its item, keeps the focus inside it, leaves the page inert, and toggles on the shortcut key', async ({ page }) => {
    await openMenu(page);
    await menu(page).getByRole('menuitem', { name: /^Keyboard shortcuts/ }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(menu(page)).toHaveCount(0);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement) === true)).toBe(true);
    }
    expect(await page.locator('.page-shell').getAttribute('inert')).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(helpButton(page)).toBeFocused();
    expect(await page.locator('.page-shell').getAttribute('inert')).toBeNull();
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+/');
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+/');
    await expect(sheet(page)).toHaveCount(0);
  });

  for (const [name, target] of EXTERNAL) {
    test(`opens ${name} in a new page with no opener and no query data, without following it`, async ({ page, context }) => {
      const requested: URL[] = [];
      await context.route(`**/${REPOSITORY}/**`, async (route) => {
        requested.push(new URL(route.request().url()));
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stand-in</title>' });
      });
      await context.route(`**/${REPOSITORY}`, async (route) => {
        requested.push(new URL(route.request().url()));
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stand-in</title>' });
      });
      await openMenu(page);
      const link = menu(page).getByRole('menuitem', { name: new RegExp(`^${name}`) });
      await expect(link).toHaveAttribute('href', target);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      const popupPromise = page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(requested.map((url) => url.pathname)).toEqual([`/${target.replace(/#.*$/, '')}`]);
      expect(requested.every((url) => url.search === '')).toBe(true);
      expect(new URL(popup.url()).search).toBe('');
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await expect(menu(page)).toHaveCount(0);
    });
  }
});
