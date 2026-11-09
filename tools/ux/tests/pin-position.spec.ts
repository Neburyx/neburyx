import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, drawing, menuOf, openSample, positions } from './support/workspace.ts';

async function selectFirst(page: Page): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
}

async function screenOfKey(page: Page, key: string): Promise<{ readonly x: number; readonly y: number }> {
  const at = (await positions(page))[key];
  const canvas = canvasOf(page);
  const box = await canvas.boundingBox();
  if (at === undefined || box === null) throw new Error('NO_ENTITY');
  const [zoom, panX, panY] = await canvas.evaluate((element) => [Number(element.dataset['zoom']), Number(element.dataset['panX']), Number(element.dataset['panY'])]);
  return { x: box.x + at.x * (zoom ?? 1) + (panX ?? 0), y: box.y + at.y * (zoom ?? 1) + (panY ?? 0) };
}

async function dragBy(page: Page, key: string, by: number): Promise<void> {
  const from = await screenOfKey(page, key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by / 2, from.y + by / 2, { steps: 4 });
  await page.mouse.move(from.x + by, from.y + by, { steps: 4 });
  await page.mouse.up();
}

const viewportOf = (page: Page) => canvasOf(page).evaluate((element) => [element.dataset['zoom'], element.dataset['panX'], element.dataset['panY']]);
const badges = async (page: Page): Promise<number> => (await drawing(page)).nodes.filter((node) => node.badgeShown).length;

test.describe('pin position', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
  });

  test('pins from the node menu, holds the entity against a drag, and releases it from the same item', async ({ page }) => {
    await selectFirst(page);
    const before = await positions(page);
    const viewBefore = await viewportOf(page);
    const already = (await drawing(page)).nodes.filter((node) => node.badgeShown).map((node) => node.id);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Pin position', exact: true }).click();
    await expect.poll(() => badges(page)).toBe(already.length + 1);
    const pinned = (await drawing(page)).nodes.find((node) => node.badgeShown && !already.includes(node.id))?.id ?? '';
    expect(Object.keys(before)).toContain(pinned);
    await expect(canvasOf(page)).toHaveAccessibleDescription(new RegExp(`(^|\\D)${already.length + 1} pinned`));
    expect(await viewportOf(page), 'a pin does not move the view').toEqual(viewBefore);
    await dragBy(page, pinned, 90);
    expect((await positions(page))[pinned], 'the pinned entity did not move').toEqual(before[pinned]);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Unpin position', exact: true }).click();
    await expect.poll(() => badges(page)).toBe(already.length);
    expect((await positions(page))[pinned], 'unpinning moved nothing').toEqual(before[pinned]);
    await dragBy(page, pinned, 90);
    await expect.poll(async () => JSON.stringify((await positions(page))[pinned])).not.toBe(JSON.stringify(before[pinned]));
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('pins and unpins the selection with P and from the bar, and a pinned entity stays through a layout', async ({ page }) => {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
    await page.keyboard.press('Escape');
    const before = await positions(page);
    const base = await badges(page);
    await page.keyboard.press('p');
    await expect.poll(() => badges(page)).toBeGreaterThan(base);
    const both = await badges(page);
    const bar = page.getByRole('toolbar', { name: 'Selection actions' });
    await expect(bar.getByRole('button', { name: 'Unpin' })).toBeVisible();
    await bar.getByRole('button', { name: 'Unpin' }).click();
    await expect.poll(() => badges(page)).toBe(base);
    await bar.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect.poll(() => badges(page)).toBe(both);
    await canvasOf(page).focus();
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Layout' }).hover();
    await page.getByRole('menuitemradio', { name: /Force/ }).click();
    const held = (await drawing(page)).nodes.filter((node) => node.badgeShown).map((node) => node.id);
    const moved = async (): Promise<number> => {
      const now = await positions(page);
      return Object.keys(before).filter((id) => !held.includes(id) && JSON.stringify(now[id]) !== JSON.stringify(before[id])).length;
    };
    await expect.poll(moved, { message: 'the layout ran: an unpinned entity moved' }).toBeGreaterThan(0);
    const after = await positions(page);
    for (const id of held) expect(after[id], 'a pinned entity stays through the layout').toEqual(before[id]);
    expect(apartFromInspector(requests)).toEqual([]);
  });
});
