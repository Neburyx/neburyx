import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf, openSample } from './support/workspace.ts';

const exact = (value: number) => ({ value, quality: 'exact', scope: 'relationships' });
const RANGE = { from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' };

test.describe('the time window in the Expand relationships panel', () => {
  let bodies: Array<Record<string, unknown>> = [];

  test.beforeEach(async ({ page }) => {
    bodies = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total: exact(40), byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: exact(40) }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown> & { sourceId: string; ref: { entityType: string; stableId: string } };
      bodies.push(body);
      const windowed = body['window'] !== undefined;
      const neighborTypes = body['neighborTypes'] as string[];
      await route.fulfill({
        json: {
          ref: { sourceId: body.sourceId, ...body.ref },
          pageSize: 25,
          ...(windowed ? { window: RANGE } : {}),
          nodes: [],
          edges: [],
          pages: neighborTypes.map((neighborType) => ({
            neighborType,
            returned: 0,
            hasMore: true,
            nextCursor: `v1.${neighborType}.next`,
            matchingTotal: { value: 12, quality: 'exact', scope: windowed ? 'expand:window' : 'expand:page' },
            ...(windowed ? { window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 2 } } : {}),
          })),
          warnings: [],
        },
      });
    });
  });

  const panel = (page: Page) => page.getByRole('complementary', { name: 'Expand relationships' });
  const windowField = (page: Page) => panel(page).getByRole('combobox', { name: /Time window/ });
  const load = (page: Page) => panel(page).getByRole('button', { name: /^Load \d+ per type$/ });
  const run = async (page: Page): Promise<void> => {
    await load(page).focus();
    await page.keyboard.press('Enter');
  };

  async function openByKeyboard(page: Page): Promise<void> {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by type', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Loading neighbors')).toHaveCount(0);
  }

  test('shows the last 7 days without a choice, sends it with the first page and says what the count is for', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await expect(windowField(page)).toHaveValue('7');
    await expect(panel(page).getByText('Time window · UTC')).toBeVisible();
    await run(page);
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]?.['window']).toEqual({ days: 7 });
    await expect(panel(page).getByText('In the last 7 days: 12 · exact', { exact: true })).toBeVisible();
    await expect(panel(page).getByText('2 relationships with no date are not included.').first()).toBeVisible();
    // the sample source has no relationship type with a date, so the window does not apply and no dates are shown beside it
    await expect(panel(page).getByText(/5 Nov 2026 to 12 Nov 2026 UTC/)).toHaveCount(0);
    const shot = process.env['NEBURYX_UX_SHOT'];
    if (shot !== undefined) await page.screenshot({ path: shot });
  });

  test('changes the label and the next request with 30 days and with All time, from the keyboard, and starts a new chain each time', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await run(page);
    await expect.poll(() => bodies.length).toBe(1);
    await windowField(page).selectOption('30');
    await expect(windowField(page)).toHaveValue('30');
    await expect(panel(page).getByText(/5 Nov 2026 to 12 Nov 2026 UTC/)).toHaveCount(0);
    await run(page);
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]?.['window']).toEqual({ days: 30 });
    expect(bodies[1]).not.toHaveProperty('cursors');
    await windowField(page).selectOption('all');
    await expect(windowField(page)).toHaveValue('all');
    await run(page);
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]).not.toHaveProperty('window');
    await expect(panel(page).getByText(/In the last/)).toHaveCount(0);
  });

  test('takes a number of days typed, and keeps Load off, with the reason, while the number is not right', async ({ page }) => {
    await openSample(page);
    await openByKeyboard(page);
    await windowField(page).selectOption('other');
    const days = panel(page).getByRole('textbox', { name: 'Days' });
    await days.fill('0');
    await expect(panel(page).getByText('Enter a whole number of days from 1 to 3650.')).toBeVisible();
    await expect(load(page)).toBeDisabled();
    await days.fill('45');
    await expect(load(page)).toBeEnabled();
    await run(page);
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]?.['window']).toEqual({ days: 45 });
  });

  const card = (page: Page) => panel(page).getByRole('region', { name: 'Node' });

  /** Answers every windowed expand with a page that holds nothing and has none after it, and an unwindowed one with the usual page. */
  async function leaveNothing(page: Page): Promise<void> {
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown> & { sourceId: string; ref: { entityType: string; stableId: string } };
      bodies.push(body);
      const windowed = body['window'] !== undefined;
      await route.fulfill({
        json: {
          ref: { sourceId: body.sourceId, ...body.ref },
          pageSize: 25,
          ...(windowed ? { window: RANGE } : {}),
          nodes: [],
          edges: [],
          pages: (body['neighborTypes'] as string[]).map((neighborType) => ({
            neighborType,
            returned: 0,
            hasMore: false,
            matchingTotal: { value: 0, quality: 'exact', scope: windowed ? 'expand:window' : 'relationships' },
            ...(windowed ? { window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 0 } } : {}),
          })),
          warnings: [],
        },
      });
    });
  }

  test('says plainly that the window left nothing, with the window named and the all-time degree, and widens to all time in one step from the panel', async ({ page }) => {
    await leaveNothing(page);
    await openSample(page);
    await openByKeyboard(page);
    await run(page);
    await expect.poll(() => bodies.length).toBe(1);
    await expect(panel(page).getByText(/: no relationships in the last 7 days\./)).toBeVisible();
    await expect(panel(page).getByText('40 relationships in all time (exact).').first()).toBeVisible();
    await expect(panel(page).getByText(/outside the window/i)).toHaveCount(0);
    const shot = process.env['NEBURYX_UX_SHOT'];
    if (shot !== undefined) await page.screenshot({ path: shot.replace(/\.png$/, '-empty.png') });
    await panel(page).getByRole('button', { name: 'Show all time' }).first().focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).not.toHaveProperty('window');
    await expect(windowField(page)).toHaveValue('all');
  });

  test('offers the same one step on the node card', async ({ page }) => {
    await leaveNothing(page);
    await openSample(page);
    await openByKeyboard(page);
    await run(page);
    await expect.poll(() => bodies.length).toBe(1);
    await expect(card(page).getByText('No relationships in the last 7 days.')).toBeVisible();
    await card(page).getByRole('button', { name: /^Show all time/ }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).not.toHaveProperty('window');
  });
});
