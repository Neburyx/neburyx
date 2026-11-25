import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const EMPTY = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const panel = (page: Page) => page.locator('.assistant-panel');
const popOutButton = (page: Page) => panel(page).getByRole('button', { name: 'Pop out' });
const NOTE = 'The chat is open in another window';

async function stubs(context: BrowserContext): Promise<void> {
  await context.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await context.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: EMPTY }));
}

async function openInvestigation(page: Page): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  const id = /\/explore\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id === undefined) throw new Error('the investigation is not in the address');
  return id;
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
}

async function popOut(page: Page): Promise<Page> {
  const [popup] = await Promise.all([page.waitForEvent('popup'), popOutButton(page).click()]);
  await popup.waitForLoadState();
  return popup;
}

test.describe('Pop out of the Assistant panel', () => {
  test('opens the page of the chat in a window of its own with the app header and sidebar, collapses the panel to its note, and restores it when the window closes', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await expect(popup).toHaveURL(new RegExp(`/assistant/${id}$`));
    await expect(popup.locator('.sidebar')).toBeVisible();
    await expect(popup.locator('.assistant-page-head')).toBeVisible();
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    await expect(panel(page).getByLabel('Your message')).toBeHidden();
    await expect(popOutButton(page)).toHaveAttribute('aria-pressed', 'true');
    await popup.close();
    await expect(panel(page).getByText(NOTE)).toBeHidden({ timeout: 10_000 });
    await expect(panel(page).getByLabel('Your message')).toBeVisible();
  });

  test('focuses the window on a second press and neither opens another nor reloads it, also after the panel has been reloaded', async ({ page, context }) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await popup.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'still here';
    });
    const extra = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await extra).toBe(false);
    expect(context.pages()).toHaveLength(2);
    expect(await popup.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('still here');
    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await openPanel(page);
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    const again = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await again).toBe(false);
    expect(context.pages()).toHaveLength(2);
    expect(await popup.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('still here');
  });

  test('uses the window it opened for the page again when the person has left the page in it', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const popup = await popOut(page);
    await popup.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
    await expect(popup).not.toHaveURL(/\/assistant\//);
    await expect(panel(page).getByText(NOTE)).toBeHidden({ timeout: 10_000 });
    const extra = page.waitForEvent('popup', { timeout: 1500 }).then(() => true, () => false);
    await popOutButton(page).click();
    expect(await extra).toBe(false);
    await expect(popup).toHaveURL(new RegExp(`/assistant/${id}$`));
    expect(context.pages()).toHaveLength(2);
  });

  test('keeps the panel as it was for a page of another investigation', async ({ page, context }) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    const other = await context.newPage();
    await openInvestigation(other);
    await other.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
    await other.getByRole('link', { name: 'Assistant' }).click();
    await expect(other).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
    await other.waitForTimeout(500);
    await expect(panel(page).getByText(NOTE)).toBeHidden();
    await expect(panel(page).getByLabel('Your message')).toBeVisible();
  });

  test('tells why nothing was switched to when the page is open in a window it cannot reach, without moving the header or clipping the text, at the opening width and wide', async ({ page, context }) => {
    await stubs(context);
    const id = await openInvestigation(page);
    await openPanel(page);
    const other = await context.newPage();
    await other.goto(`/assistant/${id}`);
    await expect(panel(page).getByText(NOTE)).toBeVisible({ timeout: 10_000 });
    const head = panel(page).locator('.ask-head');
    const before = await head.boundingBox();
    const lookup = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await popOutButton(page).click();
    const line = panel(page).getByRole('status').filter({ hasText: 'cannot switch to' });
    await expect(line).toBeVisible();
    const emptied = await lookup;
    if (emptied !== null && !emptied.isClosed()) await emptied.waitForEvent('close', { timeout: 5000 });
    expect(context.pages().filter((entry) => !entry.isClosed())).toHaveLength(2);
    const measure = async () => {
      const after = await head.boundingBox();
      expect(after?.y).toBe(before?.y);
      expect(after?.height).toBe(before?.height);
      const box = await line.boundingBox();
      const frame = await panel(page).boundingBox();
      expect(box && frame ? box.x >= frame.x && box.x + box.width <= frame.x + frame.width : false).toBe(true);
      expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
      await expect(panel(page).getByText(NOTE)).toBeVisible();
    };
    await measure();
    await panel(page).getByRole('button', { name: 'Wide' }).click();
    await expect(line).toBeVisible();
    await measure();
    await other.close();
    await expect(line).toBeHidden({ timeout: 10_000 });
  });

  test('is reached from the keyboard, and shows its tooltip and the note as the frames draw them', async ({ page, context }, info) => {
    await stubs(context);
    await openInvestigation(page);
    await openPanel(page);
    await popOutButton(page).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(popOutButton(page)).toBeFocused();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('Open this chat as a full page in a new window');
    const shots = process.env['NBX_UX_SHOTS'];
    if (shots !== undefined) await page.screenshot({ path: `${shots}/pop-out-tooltip-${info.project.name}.png` });
    await page.keyboard.press('Enter');
    const popup = await page.waitForEvent('popup');
    await expect(panel(page).getByText(NOTE)).toBeVisible();
    await popOutButton(page).blur();
    const box = await page.locator('.floating-panel', { has: panel(page) }).boundingBox();
    expect(box?.width).toBe(380);
    expect(Math.round(box?.height ?? 0)).toBe(189);
    if (shots !== undefined) await page.screenshot({ path: `${shots}/pop-out-collapsed-${info.project.name}.png` });
    await popup.close();
  });
});
