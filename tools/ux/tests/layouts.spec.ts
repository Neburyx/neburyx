import { expect, test, type Page } from '@playwright/test';
import { canvasOf, grabbablePoint, markPositions, movedSinceMark, openFixture, positions, type Drawn } from './support/workspace.ts';

const BOX_WIDTH = 160;
const BOX_HEIGHT = 94;

async function chooseLayout(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^Layout:/ }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

function overlapping(drawn: Drawn): number {
  const points = Object.values(drawn);
  let count = 0;
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const first = points[a];
      const second = points[b];
      if (first !== undefined && second !== undefined && Math.abs(first.x - second.x) < BOX_WIDTH && Math.abs(first.y - second.y) < BOX_HEIGHT) count += 1;
    }
  }
  return count;
}

async function insideView(page: Page, drawn: Drawn): Promise<boolean> {
  const box = await canvasOf(page).boundingBox();
  const [zoom, panX, panY] = await canvasOf(page).evaluate((element) => [Number(element.dataset['zoom']), Number(element.dataset['panX']), Number(element.dataset['panY'])]);
  if (box === null) return false;
  return Object.values(drawn).every((at) => {
    const x = at.x * (zoom ?? 1) + (panX ?? 0);
    const y = at.y * (zoom ?? 1) + (panY ?? 0);
    return x >= 0 && y >= 0 && x <= box.width && y <= box.height;
  });
}

test.describe('layouts', () => {
  test.beforeEach(async ({ page }) => {
    await openFixture(page);
  });

  for (const layout of ['Force', 'Hierarchical', 'Radial', 'Grid']) {
    test(`${layout} leaves no two boxes overlapping, fits every entity in the view and moves no pinned entity`, async ({ page }) => {
      await markPositions(page);
      await chooseLayout(page, layout);
      await expect(page.getByRole('button', { name: `Layout: ${layout}` })).toBeVisible();
      await expect.poll(async () => (await movedSinceMark(page)).unpinned).toBeGreaterThan(0);
      const moved = await movedSinceMark(page);
      expect(moved.pinned, 'no pinned entity moved').toBe(0);
      const drawn = await positions(page);
      expect(Object.keys(drawn).length).toBe(120);
      expect(overlapping(drawn), 'overlapping boxes').toBe(0);
      expect(await insideView(page, drawn), 'every entity is in the view').toBe(true);
    });
  }

  test('Hierarchical runs left to right when asked, and the control names the layout', async ({ page }) => {
    await chooseLayout(page, 'Hierarchical');
    const down = await positions(page);
    await page.getByRole('button', { name: /^Layout:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Left to right' }).click();
    const right = await positions(page);
    const spread = (drawn: Drawn, axis: 'x' | 'y'): number => {
      const values = Object.values(drawn).map((at) => at[axis]);
      return Math.max(...values) - Math.min(...values);
    };
    expect(spread(down, 'y') / spread(down, 'x')).toBeGreaterThan(spread(right, 'y') / spread(right, 'x'));
  });

  test('the closed control reads the layout and a caret, as the frame draws it, and Physics is off until it is switched on', async ({ page }) => {
    const control = page.getByRole('button', { name: 'Layout: Force' });
    await expect(control).toHaveText('Force ▾');
    await control.click();
    await expect(page.getByRole('menuitemcheckbox', { name: /Physics/ })).toHaveAttribute('aria-checked', 'false');
  });

  test('with Physics on, dragging an entity moves its neighbor and no pinned entity', async ({ page }) => {
    await chooseLayout(page, 'Force');
    await page.getByRole('button', { name: /^Layout:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /Physics/ }).click();
    await page.waitForTimeout(2500);
    const { key, x: sx, y: sy } = await grabbablePoint(page);
    await markPositions(page);
    const before = await positions(page);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 150, sy + 90, { steps: 12 });
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.waitForTimeout(2500);
    const during = await positions(page);
    const changed = Object.keys(before).filter((id) => id !== key && (before[id]?.x !== during[id]?.x || before[id]?.y !== during[id]?.y));
    expect(changed.length, 'other entities followed').toBeGreaterThan(0);
    expect(Math.hypot((during[key]?.x ?? 0) - (before[key]?.x ?? 0), (during[key]?.y ?? 0) - (before[key]?.y ?? 0)), 'the dragged entity stayed where it was dropped').toBeGreaterThan(100);
    expect((await movedSinceMark(page)).pinned, 'no pinned entity moved').toBe(0);
  });
});
