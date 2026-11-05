import { expect, test } from '@playwright/test';
import { canvasOf, markPositions, movedSinceMark, openFixture, positions } from './support/workspace.ts';

const ADDED = 25;

test.describe('adding entities in the page', () => {
  test.beforeEach(async ({ page }) => openFixture(page));

  test('keeps the positions that a displacement gave, when 25 more are added after it', async ({ page }) => {
    await page.getByRole('button', { name: 'Displace 10 entities' }).click();
    await expect.poll(async () => Object.keys(await positions(page)).length).toBe(120);
    await page.waitForTimeout(300);
    const displaced = await positions(page);
    await page.getByRole('button', { name: `Add ${ADDED} entities` }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(120 + ADDED));
    const after = await positions(page);
    for (const [id, at] of Object.entries(displaced)) expect(after[id], `entity ${id} after the add`).toEqual(at);
  });

  test('draws exactly 25 more entities and leaves every existing entity where it was, reporting how many moved', async ({ page }) => {
    const before = await positions(page);
    expect(Object.keys(before)).toHaveLength(120);
    await markPositions(page);
    await page.getByRole('button', { name: `Add ${ADDED} entities` }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(120 + ADDED));
    const after = await positions(page);
    expect(Object.keys(after), 'the drawn entities').toHaveLength(120 + ADDED);
    for (const [id, at] of Object.entries(before)) expect(after[id], `entity ${id} after the add`).toEqual(at);
    const moved = await movedSinceMark(page);
    expect(moved, 'the entities marked before the add').toMatchObject({ marked: 120 });
    expect(moved.unpinned, 'unpinned entities that moved').toBe(0);
    expect(moved.pinned, 'pinned entities that moved').toBe(0);
    const added = Object.entries(after).filter(([id]) => !(id in before));
    expect(added, 'the entities that came').toHaveLength(ADDED);
    const taken = new Set(Object.values(before).map((at) => `${at.x},${at.y}`));
    for (const [id, at] of added) {
      expect(taken.has(`${at.x},${at.y}`), `the new entity ${id} sits on an existing one`).toBe(false);
      taken.add(`${at.x},${at.y}`);
    }
  });

  test('keeps the honest labels in the scope lines', async ({ page }) => {
    await page.getByRole('button', { name: `Add ${ADDED} entities` }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(120 + ADDED));
    const scope = page.locator('.graph-scope');
    await expect(scope).toContainText(`${120 + ADDED} entities`);
    await expect(scope).toContainText(/loaded · exact/);
  });
});
