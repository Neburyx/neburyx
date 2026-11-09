import { expect, test, type Page } from '@playwright/test';
import { menuItems, menuOf, openSample, screenOf } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });
const OPEN = 'Open source record';

async function select(page: Page, id: string): Promise<void> {
  const at = await screenOf(page, id);
  await page.mouse.click(at.x, at.y);
  await expect(inspector(page)).toBeVisible();
}

async function expectAppsOwnPath(link: ReturnType<Page['getByRole']>): Promise<void> {
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await link.evaluate((anchor) => (anchor instanceof HTMLAnchorElement ? anchor.origin === window.location.origin && anchor.pathname.startsWith('/v1/source-links/') : false))).toBe(true);
}

test.describe('Open source record', () => {
  test('is a link to the app\'s own path in the inspector header of a linked type, and absent for a type without a link', async ({ page }) => {
    await openSample(page, '?evidence=on&links=on');
    await select(page, 'holder');
    await expectAppsOwnPath(inspector(page).getByRole('link', { name: OPEN }));
    await select(page, 'led-1');
    await expect(inspector(page).getByRole('link', { name: OPEN })).toHaveCount(0);
  });

  test('is in the node menu of a linked type only, and shows no entry anywhere when the mapping gives no link', async ({ page }) => {
    await openSample(page, '?evidence=on&links=on');
    const holder = await screenOf(page, 'holder');
    await page.mouse.click(holder.x, holder.y, { button: 'right' });
    expect(await menuItems(page)).toContain(OPEN);
    await page.keyboard.press('Escape');
    const ledger = await screenOf(page, 'led-1');
    await page.mouse.click(ledger.x, ledger.y, { button: 'right' });
    expect(await menuItems(page)).not.toContain(OPEN);
    await page.keyboard.press('Escape');
    await openSample(page, '?evidence=on');
    await select(page, 'holder');
    await expect(inspector(page).getByRole('link', { name: OPEN })).toHaveCount(0);
  });

  test('links each linkable record of a relationship, opened from the relationship menu, and never shows an address of the source', async ({ page }) => {
    await openSample(page, '?evidence=on&links=on');
    const a = await screenOf(page, 'holder');
    const b = await screenOf(page, 'lin');
    await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
    await expect(menuOf(page)).toHaveCount(1);
    expect(await menuItems(page)).toContain(OPEN);
    await menuOf(page).getByRole('menuitem', { name: OPEN }).click();
    await expect(panel(page)).toBeVisible();
    const record = panel(page).getByRole('link', { name: /REC-/ }).first();
    await expect(record).toBeVisible();
    await expectAppsOwnPath(record);
    expect(await record.getAttribute('href')).toContain('record=REC-');
    expect(await page.content()).not.toMatch(/https:\/\/(?!.*localhost)[a-z.-]+\/records/);
  });
});
