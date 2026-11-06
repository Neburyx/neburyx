import { expect, test, type Page } from '@playwright/test';
import { canvasOf, openOneEntity, positions, screenOf } from './support/workspace.ts';

const SOURCE = 'banking-demo';
const DEBOUNCE_MS = 250;

const onCanvasBox = (page: Page) => page.getByRole('searchbox', { name: 'Find on canvas' });
const sourceBox = (page: Page) => page.getByRole('searchbox', { name: 'Find in the source' });

/** Counts the searches and the entity reads the page makes from now on, and keeps what was asked. */
function watch(page: Page): { readonly searches: Array<Record<string, unknown>>; readonly reads: string[] } {
  const searches: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/v1/search/entities') searches.push(request.postDataJSON());
    if (request.method() === 'GET' && url.pathname.startsWith('/v1/entities/')) reads.push(url.pathname);
  });
  return { searches, reads };
}

test.describe('the Search tool on the canvas', () => {
  test.beforeEach(async ({ page }) => openOneEntity(page, SOURCE, 'AC-1'));

  test('opens its panel with the key, with the box focused, on the page the person is on', async ({ page }) => {
    const address = page.url();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('heading', { level: 2, name: 'Search' })).toBeVisible();
    await expect(onCanvasBox(page)).toBeFocused();
    await expect(page.getByRole('tab', { name: 'On canvas · 1' })).toBeVisible();
    expect(page.url()).toBe(address);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { level: 2, name: 'Search' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
  });

  test('finds a loaded entity from part of its ID, selects it and brings it to the middle of the canvas, from where the person had panned it', async ({ page }) => {
    const canvas = await canvasOf(page).boundingBox();
    const middle = { x: (canvas?.x ?? 0) + (canvas?.width ?? 0) / 2, y: (canvas?.y ?? 0) + (canvas?.height ?? 0) / 2 };
    await page.keyboard.press('h');
    await page.mouse.move(middle.x + 200, middle.y + 150);
    await page.mouse.down();
    await page.mouse.move(middle.x + 320, middle.y + 230, { steps: 6 });
    await page.mouse.up();
    const panned = await screenOf(page, 'AC-1');
    expect(Math.hypot(panned.x - middle.x, panned.y - middle.y), 'the entity was panned away from the middle').toBeGreaterThan(80);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await onCanvasBox(page).fill('c-');
    const row = page.getByRole('button', { name: /AC-1/ }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText('Selected account AC-1.')).toBeVisible();
    const at = await screenOf(page, 'AC-1');
    expect(Math.abs(at.x - middle.x)).toBeLessThan(4);
    expect(Math.abs(at.y - middle.y)).toBeLessThan(4);
  });

  test('sends one request after the pause and none for one character, adds one entity with no neighbours and moves none, and shows On canvas for it afterwards', async ({ page }) => {
    const { searches, reads } = watch(page);
    const before = await positions(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('tab', { name: 'Add from source' }).click();
    await expect(sourceBox(page)).toBeFocused();
    await sourceBox(page).pressSequentially('A', { delay: 20 });
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect(searches, 'no request for one character').toEqual([]);
    await sourceBox(page).pressSequentially('C-2', { delay: 20 });
    await page.waitForTimeout(DEBOUNCE_MS / 2);
    expect(searches, 'no request before the pause').toEqual([]);
    await expect(page.getByText('1 exact ID match · 2 start with the text · 0.18 s')).toBeVisible();
    expect(searches).toEqual([{ sourceId: SOURCE, text: 'AC-2', typeahead: true }]);
    expect(new URL(page.url()).search, 'the typed text is never in the address').toBe('');
    await page.getByRole('button', { name: 'Add account AC-2', exact: true }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    expect(reads).toEqual([`/v1/entities/${SOURCE}/account/AC-2`]);
    const after = await positions(page);
    for (const [id, at] of Object.entries(before)) expect(after[id], `entity ${id} after the add`).toEqual(at);
    await expect(page.getByRole('button', { name: 'On canvas: account AC-2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add account AC-2', exact: true })).toHaveCount(0);
    await expect(page.getByText('1 entity · 0 relationships')).toHaveCount(0);
    await expect(page.locator('.graph-scope')).toContainText('2 entities · 0 relationships');
  });

  test('shows On canvas for an entity that is already there and does not add it twice', async ({ page }) => {
    const { reads } = watch(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('tab', { name: 'Add from source' }).click();
    await sourceBox(page).fill('AC-1');
    await expect(page.getByRole('button', { name: 'On canvas: account AC-1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add account AC-1', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'On canvas: account AC-1' }).click();
    expect(reads).toEqual([]);
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });
});
