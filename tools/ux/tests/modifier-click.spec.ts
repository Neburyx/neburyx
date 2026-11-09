import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf, openSample, screenOf } from './support/workspace.ts';

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions' });
const count = (page: Page) => bar(page).locator('.selection-count');

type Key = 'Meta' | 'Control' | 'Shift';

async function clickWith(page: Page, key: Key | undefined, at: { readonly x: number; readonly y: number }): Promise<void> {
  if (key !== undefined) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  if (key !== undefined) await page.keyboard.up(key);
}

const middle = async (page: Page, from: string, to: string): Promise<{ readonly x: number; readonly y: number }> => {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

// The platform the product reads is the browser's own `navigator.platform`; the test sets it before the page loads.
const PLATFORMS = [
  { name: 'a Mac', navigatorPlatform: 'MacIntel', toggle: 'Meta' as const, notToggle: 'Control' as const },
  { name: 'another platform', navigatorPlatform: 'Win32', toggle: 'Control' as const, notToggle: 'Meta' as const },
];

for (const platform of PLATFORMS) {
  test.describe(`clicks with a modifier held on ${platform.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => value, configurable: true }), platform.navigatorPlatform);
      await openSample(page);
    });

    // A single selected entity opens the inspector, which at the narrower window covers the entities at the right, so the selection starts with the relationship.
    test(`${platform.toggle}+click adds and removes an entity and a relationship, as Shift+click does`, async ({ page }) => {
      const holder = await screenOf(page, 'holder');
      const lin = await screenOf(page, 'led-1');
      const line = await middle(page, 'holder', 'led-1');
      await clickWith(page, undefined, line);
      await expect(bar(page)).toHaveCount(0);
      await clickWith(page, platform.toggle, holder);
      await expect(count(page)).toHaveText('2 selected');
      await clickWith(page, platform.toggle, lin);
      await expect(count(page)).toHaveText('3 selected');
      await clickWith(page, platform.toggle, line);
      await expect(count(page)).toHaveText('2 selected');
      await clickWith(page, 'Shift', line);
      await expect(count(page)).toHaveText('3 selected');
    });

    test(`${platform.notToggle}+click does not toggle (it is a plain click)`, async ({ page }) => {
      const holder = await screenOf(page, 'holder');
      const line = await middle(page, 'holder', 'led-1');
      await clickWith(page, undefined, line);
      await clickWith(page, platform.notToggle, holder);
      if (platform.navigatorPlatform === 'MacIntel') {
        // on a Mac Ctrl+click is the system's right-click: it opens the menu of the item and selects only that item
        await expect(menuOf(page)).toHaveCount(1);
        await page.keyboard.press('Escape');
      }
      await expect(bar(page)).toHaveCount(0);
    });
  });
}

test.describe('a Ctrl+click on a Mac', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true }));
    await openSample(page);
  });

  test('opens the menu of an entity, of a relationship and of the canvas as a right-click does, and selects nothing else', async ({ page }) => {
    const holder = await screenOf(page, 'holder');
    const line = await middle(page, 'holder', 'led-1');
    await clickWith(page, 'Control', holder);
    await expect(menuOf(page)).toHaveCount(1);
    const entityMenu = await menuOf(page).getByRole('menuitem').allTextContents();
    await page.keyboard.press('Escape');
    await page.mouse.click(holder.x, holder.y, { button: 'right' });
    expect(await menuOf(page).getByRole('menuitem').allTextContents(), 'the items of a right-click on the same entity').toEqual(entityMenu);
    await page.keyboard.press('Escape');
    await clickWith(page, 'Control', line);
    await expect(menuOf(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    const box = await canvasOf(page).boundingBox();
    await clickWith(page, 'Control', { x: (box?.x ?? 0) + (box?.width ?? 0) - 40, y: (box?.y ?? 0) + (box?.height ?? 0) - 120 });
    await expect(menuOf(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
  });
});
