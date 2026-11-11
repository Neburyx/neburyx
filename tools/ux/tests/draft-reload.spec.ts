import { expect, test, type Page } from '@playwright/test';
import { canvasOf, drawing, openWithDraft, positions, storedMatchesDrawn } from './support/workspace.ts';

const IDS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'];
const lines = (page: Page) => page.locator('.graph-scope p');

/** Opens AC-1 and gives the investigation a draft of five entities, as an expansion that was autosaved would have left it. */
async function openFiveEntities(page: Page): Promise<string> {
  const id = await openWithDraft(page, IDS, (index) => ({ x: Math.cos(index) * 200, y: Math.sin(index) * 200 }));
  await page.reload();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length));
  return id;
}

const storedDraft = async (page: Page, id: string) => {
  const body = (await (await page.request.get(`/v1/investigations/${id}`)).json()) as { draft: { version: number; layout: { nodes: { id: string; pinned: boolean; hidden: boolean; x?: number; y?: number }[] } } };
  return body.draft;
};

async function dragFirstBy(page: Page, by: number): Promise<string> {
  const canvas = canvasOf(page);
  const box = await canvas.boundingBox();
  const drawn = await positions(page);
  const [zoom, panX, panY] = await canvas.evaluate((element) => [Number(element.dataset['zoom']), Number(element.dataset['panX']), Number(element.dataset['panY'])]);
  if (box === null) throw new Error('NO_CANVAS');
  const [key, at] = Object.entries(drawn)[0] ?? [];
  if (key === undefined || at === undefined) throw new Error('NO_ENTITY');
  const from = { x: box.x + at.x * (zoom ?? 1) + (panX ?? 0), y: box.y + at.y * (zoom ?? 1) + (panY ?? 0) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by / 2, from.y + by / 2, { steps: 4 });
  await page.mouse.move(from.x + by, from.y + by, { steps: 4 });
  await page.mouse.up();
  return key;
}

test.describe('an investigation reloaded after its autosave', () => {
  test('shows the same positions, pin and hidden entity after the page is loaded again', async ({ page }) => {
    const id = await openFiveEntities(page);
    const moved = await dragFirstBy(page, 90);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('p');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.keyboard.press('Delete');
    await expect(lines(page).first()).toContainText('1 hidden from view');
    const before = await positions(page);
    const pinnedBefore = (await drawing(page)).nodes.filter((node) => node.badgeShown).length;
    expect(pinnedBefore).toBe(1);
    await expect.poll(async () => (await storedDraft(page, id)).layout.nodes.filter((node) => node.hidden).length, { message: 'the autosave stores the hidden entity', timeout: 15_000 }).toBe(1);
    expect((await storedDraft(page, id)).layout.nodes.filter((node) => node.pinned).length).toBe(pinnedBefore);

    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length - 1));
    await expect(lines(page).first()).toContainText('1 hidden from view');
    const after = await positions(page);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after[moved]?.x).toBeCloseTo(before[moved]?.x ?? NaN, 0);
    expect(after[moved]?.y).toBeCloseTo(before[moved]?.y ?? NaN, 0);
    expect((await drawing(page)).nodes.filter((node) => node.badgeShown).length).toBe(pinnedBefore);
  });

  test('does the same with the keyboard only: arrow keys move the selected entity and the reload shows where it went', async ({ page }) => {
    const id = await openFiveEntities(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    const before = await positions(page);
    for (let press = 0; press < 4; press += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => JSON.stringify(await positions(page)), { message: 'the selected entity moved' }).not.toBe(JSON.stringify(before));
    await expect.poll(() => storedMatchesDrawn(page, id), { message: 'the autosave caught up with the last move', timeout: 20_000 }).toBe(true);
    const moved = await positions(page);
    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', String(IDS.length));
    const after = await positions(page);
    for (const [key, at] of Object.entries(moved)) {
      expect(after[key]?.x).toBeCloseTo(at.x, 0);
      expect(after[key]?.y).toBeCloseTo(at.y, 0);
    }
  });
});
